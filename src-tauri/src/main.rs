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

const HOST: &str = "127.0.0.1";
const PORT: u16 = 3444;

fn main() {
    let server: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let setup_server = Arc::clone(&server);

    tauri::Builder::default()
        .setup(move |app| {
            let url = if let Some(remote_url) = remote_url()? {
                remote_url
            } else {
                let root = app_root(app.handle())?;
                let config_dir = desktop_config_dir(&root)?;
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

fn remote_url() -> Result<Option<Url>, Box<dyn std::error::Error>> {
    let Ok(value) = env::var("DIVAULT_REMOTE_URL") else {
        return Ok(None);
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

fn app_root(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dev_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .ok_or("could not resolve project root")?;
    if dev_root.join("public/index.php").is_file() {
        return Ok(dev_root);
    }

    let resource_dir = app.path().resource_dir()?;
    if resource_dir.join("public/index.php").is_file() {
        return Ok(resource_dir);
    }

    Err("DiVault web resources were not found".into())
}

fn desktop_config_dir(root: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Ok(path) = env::var("DIVAULT_DESKTOP_CONFIG") {
        return Ok(PathBuf::from(path));
    }
    Ok(root.join("desktop-data"))
}

fn ensure_config_dirs(config_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    for path in ["", "files", "backups", "exports", "imports", "keys", "logs", "tmp"] {
        std::fs::create_dir_all(config_dir.join(path))?;
    }
    Ok(())
}

fn start_php_server(root: &Path, config_dir: &Path) -> Result<Child, Box<dyn std::error::Error>> {
    ensure_port_available()?;

    let php = env::var("DIVAULT_PHP_BIN").unwrap_or_else(|_| "php".to_string());
    let public_dir = root.join("public");
    let router = public_dir.join("index.php");
    let addr = format!("{HOST}:{PORT}");

    let mut child = Command::new(php)
        .arg("-S")
        .arg(addr)
        .arg("-t")
        .arg(public_dir)
        .arg(router)
        .current_dir(root)
        .env("APP_CONFIG_DIR", config_dir)
        .env("APP_URL", format!("http://{HOST}:{PORT}"))
        .env("SECURE_COOKIES", "false")
        .env("TRUST_PROXY", "false")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("failed to start PHP. Install PHP or set DIVAULT_PHP_BIN. {err}"))?;

    wait_for_server(&mut child)?;

    Ok(child)
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
            return Err(format!("DiVault local PHP server exited before startup completed: {status}").into());
        }

        if TcpStream::connect((HOST, PORT)).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("DiVault local server did not start in time".into())
}
