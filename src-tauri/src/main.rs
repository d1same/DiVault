#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env,
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 3444;

fn main() {
    let server: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let setup_server = Arc::clone(&server);

    tauri::Builder::default()
        .setup(move |app| {
            let config_dir = desktop_config_dir(app.handle())?;
            let url = if let Some(remote_url) = remote_url(&config_dir)? {
                remote_url
            } else {
                let root = app_root(app.handle())?;
                ensure_config_dirs(&config_dir)?;

                let child = start_php_server(&root, &config_dir)?;
                *setup_server.lock().expect("server lock poisoned") = Some(child);

                Url::parse(&format!("http://{HOST}:{PORT}/"))?
            };
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("DiVault")
                .inner_size(1280.0, 820.0)
                .min_inner_size(420.0, 620.0)
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build DiVault desktop app")
        .run(move |_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(mut child) = server.lock().expect("server lock poisoned").take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}

fn remote_url(config_dir: &Path) -> Result<Option<Url>, Box<dyn std::error::Error>> {
    let value = match env::var("DIVAULT_REMOTE_URL") {
        Ok(value) => value,
        Err(_) => desktop_server_url(config_dir)?.unwrap_or_default(),
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let url = Url::parse(trimmed)?;
    match url.scheme() {
        "http" | "https" => Ok(Some(url)),
        _ => Err("DIVAULT_REMOTE_URL must start with http:// or https://".into()),
    }
}

fn desktop_server_url(config_dir: &Path) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let file = config_dir.join("desktop-server.json");
    if !file.is_file() {
        return Ok(None);
    }
    let value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(file)?)?;
    Ok(value
        .get("server_url")
        .and_then(|server_url| server_url.as_str())
        .map(str::to_string))
}

fn app_root(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    #[cfg(debug_assertions)]
    {
        let dev_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(Path::to_path_buf)
            .ok_or("could not resolve project root")?;
        if dev_root.join("public/index.php").is_file() {
            return Ok(dev_root);
        }
    }

    let mut resource_dirs = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        resource_dirs.push(resource_dir);
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            resource_dirs.push(exe_dir.join("resources"));
        }
    }

    for resource_dir in resource_dirs {
        if resource_dir.join("public/index.php").is_file() {
            return Ok(resource_dir);
        }

        if let Some(install_dir) = resource_dir.parent() {
            let bundled_root = install_dir.join("_up_");
            if bundled_root.join("public/index.php").is_file() {
                return Ok(bundled_root);
            }
        }
    }

    Err("DiVault web resources were not found".into())
}

fn desktop_config_dir(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Ok(path) = env::var("DIVAULT_DESKTOP_CONFIG") {
        return Ok(PathBuf::from(path));
    }
    Ok(app.path().app_data_dir()?)
}

fn ensure_config_dirs(config_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    for path in [
        "", "files", "backups", "exports", "imports", "keys", "logs", "tmp",
    ] {
        std::fs::create_dir_all(config_dir.join(path))?;
    }
    Ok(())
}

fn start_php_server(root: &Path, config_dir: &Path) -> Result<Child, Box<dyn std::error::Error>> {
    ensure_port_available()?;

    let php = php_runtime(root);
    let php_dir = php.parent().map(Path::to_path_buf);
    let public_dir = root.join("public");
    let router = public_dir.join("index.php");
    let addr = format!("{HOST}:{PORT}");

    let mut command = Command::new(&php);
    if let Some(dir) = php_dir {
        command.arg("-c").arg(dir);
    }
    command
        .arg("-S")
        .arg(addr)
        .arg("-t")
        .arg(public_dir)
        .arg(router)
        .current_dir(root)
        .env("APP_CONFIG_DIR", config_dir)
        .env("APP_URL", format!("http://{HOST}:{PORT}"))
        .env("DIVAULT_DESKTOP", "true")
        .env("SECURE_COOKIES", "false")
        .env("TRUST_PROXY", "false")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    command.creation_flags(0x08000000);

    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to start DiVault's bundled PHP runtime. Set DIVAULT_PHP_BIN only if you want to use a custom PHP build. Runtime: {}. {err}", php.display()))?;

    wait_for_server(&mut child)?;

    Ok(child)
}

fn php_runtime(root: &Path) -> PathBuf {
    if let Ok(path) = env::var("DIVAULT_PHP_BIN") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    #[cfg(windows)]
    {
        let mut dirs = vec![
            root.join("php"),
            root.join("src-tauri").join("resources").join("php"),
        ];
        if let Some(install_dir) = root.parent() {
            dirs.push(install_dir.join("resources").join("php"));
        }

        for dir in dirs {
            let bundled_php = dir.join("php.exe");
            if bundled_php.is_file() {
                return bundled_php;
            }
        }
    }

    #[cfg(not(windows))]
    {
        let mut dirs = vec![
            root.join("php"),
            root.join("src-tauri").join("resources").join("php"),
        ];
        if let Some(install_dir) = root.parent() {
            dirs.push(install_dir.join("resources").join("php"));
        }

        for dir in dirs {
            let bundled_php = dir.join("php");
            if bundled_php.is_file() {
                return bundled_php;
            }
        }
    }

    PathBuf::from("php")
}

fn ensure_port_available() -> Result<(), Box<dyn std::error::Error>> {
    TcpListener::bind((HOST, PORT))
        .map(|_| ())
        .map_err(|err| format!("DiVault desktop port {PORT} is already in use. Close the other process and reopen DiVault. {err}").into())
}

fn wait_for_server(child: &mut Child) -> Result<(), Box<dyn std::error::Error>> {
    let deadline = Instant::now() + Duration::from_secs(12);
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait()? {
            return Err(format!(
                "DiVault local PHP server exited before startup completed: {status}"
            )
            .into());
        }

        if TcpStream::connect((HOST, PORT)).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("DiVault local server did not start in time".into())
}
