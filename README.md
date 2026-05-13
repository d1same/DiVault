# DiVault

DiVault is an all-in-one self-hosted notepad, quick-capture inbox, client documentation, file, script, and sensitive-note vault app.

It is designed for Unraid/Pangolin-style hosting with one persistent `/config` directory, SQLite, and no separate database container.

## Install

### Docker Compose

Clone the project, then start DiVault with Docker Compose:

```bash
git clone https://github.com/d1same/DiVault.git
cd DiVault
docker compose up -d --build
```

Open `http://localhost:3443`, create the owner account, then put it behind HTTPS for production.

### Desktop Preview

Windows desktop installers are published on the GitHub Releases page when available. The desktop app can run in two modes:

- Remote synced mode: point it at an existing DiVault server with `DIVAULT_REMOTE_URL=https://notes.example.com`.
- Local vault mode: runs the bundled DiVault web app locally, but currently requires PHP installed or `DIVAULT_PHP_BIN` set.

The desktop app is useful today as a native wrapper, but PHP bundling and full local-to-server merge sync are still roadmap items.

## Current Features

- Single Docker container
- Persistent `/config` layout
- SQLite database at `/config/app.sqlite`
- Mobile-friendly PWA shell
- Multi-user login with roles
- Owner/admin user management
- TOTP 2FA setup, verification, and recovery codes
- CSRF protection for mutating API requests
- Login rate limiting
- Session listing and revocation
- Passkeys/WebAuthn-ready schema and UI placeholder
- Fast notes that default to the virtual `All` view with an inline editor
- Optional note insert tools for username, secret, URL, checklist, file, and code blocks
- Code block copy/download actions for PowerShell, HTML, CSS, JavaScript, PHP, SQL, Bash, JSON, and plain text
- User-created note categories and subcategories; no fixed note folders beyond `All`
- Drag/drop note movement from `All` into custom categories/subcategories
- Archive and Recycle bin as note actions/views, with restore, permanent delete, and empty-recycle support
- Custom documentation categories for structured records
- Optional client records
- Tags, categories, and note version history
- File/photo/document attachments under `/config/files`
- Auto-detection of sensitive lines like `password:`, `token:`, `api key:`, and `🔒 Password:`
- Encrypted sensitive values using `/config/keys/master.key`
- Eye/copy reveal controls with audit logging
- Audit log for login, note, file, secret, export, import, and backup activity
- Optional Tauri desktop app that runs the same PHP/SQLite DiVault app in a native window
- JSON export and import
- Full backup ZIP containing SQLite database, files, and encryption key, with optional ZIP passphrase protection when enabled by the backup flow
- Backup listing, retention pruning, and safe scheduled restore on next container restart
- Repeatable API smoke test script at `scripts/smoke.ps1`

## Docker Compose

```yaml
services:
  notes:
    build: .
    container_name: divault-notes
    ports:
      - "3443:3443"
    volumes:
      - /mnt/user/appdata/divault:/config
    environment:
      APP_URL: "https://notes.example.com"
      APP_CONFIG_DIR: "/config"
      TRUST_PROXY: "true"
      SECURE_COOKIES: "true"
      TZ: "America/New_York"
    restart: unless-stopped
```

For local HTTP testing without a reverse proxy, set:

```yaml
SECURE_COOKIES: "false"
```

Keep `SECURE_COOKIES` set to `true` in production. Use `false` only for local plain-HTTP testing.

## Pangolin / Reverse Proxy Notes

Use Pangolin to proxy your public HTTPS domain to the container on port `3443`. The container listens on plain HTTP at port `3443`; Pangolin provides the public HTTPS layer.

Recommended environment values:

```text
APP_URL=https://notes.yourdomain.com
TRUST_PROXY=true
SECURE_COOKIES=true
```

The app honors forwarded IP headers when `TRUST_PROXY=true`, uses secure cookies when `SECURE_COOKIES=true`, and keeps passkey/WebAuthn planning tied to the final HTTPS domain.

## Persistent Data Layout

```text
/config/app.sqlite
/config/files/
/config/backups/
/config/exports/
/config/imports/
/config/keys/master.key
/config/logs/
/config/tmp/
```

Keep `/config/keys/master.key` safe. If it is lost, encrypted sensitive values cannot be recovered. Full backup ZIPs include the SQLite database, uploaded files, and this master key, so protect backup ZIPs like production secrets.

If you create an encrypted backup ZIP, store the backup passphrase outside DiVault, such as in your primary password manager or offline recovery notes. DiVault cannot recover a forgotten backup passphrase.

## First Run

1. Start the container.
2. Open DiVault through Pangolin or locally.
3. Create the owner account.
4. Enable 2FA from Security & data.
5. Install the PWA on your phone from the browser menu.

## Quick Capture Workflow

1. Open DiVault on your phone.
2. Tap `+`.
3. Start typing immediately.
4. Use the top icons only when needed: username, secret, URL, checklist, file, or code.
5. Save to `All`.
6. Review later and drag/drop into your own categories or subcategories.
7. Use Archive or Recycle bin actions when a note is no longer active.

## Desktop App

DiVault can also run as a local Tauri desktop app. The desktop app starts a local PHP server at `http://127.0.0.1:3444`, opens DiVault in a native window, and stores its local desktop data under `desktop-data/` by default.

For cross-device sync, point the desktop app at the same Docker/Pangolin DiVault URL used by phones, tablets, Android devices, and browsers. In that mode the desktop app opens the remote server directly instead of creating an isolated local SQLite vault.

Requirements:

- Node.js and npm
- Rust/Cargo
- PHP available on `PATH`, or set `DIVAULT_PHP_BIN` to the PHP executable path

Run the desktop app in development:

```powershell
npm install
npm run desktop:dev
```

Build a desktop bundle:

```powershell
npm run desktop:build
```

Optional desktop environment variables:

```text
DIVAULT_DESKTOP_CONFIG=C:\path\to\divault-desktop-data
DIVAULT_PHP_BIN=C:\path\to\php.exe
DIVAULT_REMOTE_URL=https://notes.example.com
```

Remote synced desktop mode:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\desktop-dev.ps1 -RemoteUrl http://localhost:3443
```

Local desktop mode is still useful for a private offline-only vault, but it does not sync to the Docker server unless you explicitly run against the same remote URL. The product direction is server-authoritative sync: every platform should target one DiVault server when you want the same data everywhere.

## Sync Between Devices

DiVault is server-backed. All phones, tablets, and computers sync through the same DiVault container and `/config/app.sqlite` database.

- Open the same DiVault URL on each device.
- Install the PWA from the browser menu if you want an app-like shortcut.
- Notes save to the server immediately when you press Save.
- Other devices refresh when the app gains focus, comes back online, or every 30 seconds while open.
- The header sync pill shows `Synced`, `Syncing...`, or `Offline`.

Current Docker/PWA/remote-desktop sync is online-first and server-authoritative. Offline viewing may work from the PWA cache, but offline note creation/editing is not yet conflict-safe. Full encrypted offline capture and local-desktop-to-server merge sync remain on the roadmap.

Platform-neutral sync API foundation:

- `GET /api/sync/manifest` returns server time, the current sync watermark, supported entities, and capabilities.
- `GET /api/sync/pull?since_event_id=0` returns a full snapshot for initial client hydration.
- `GET /api/sync/pull?since_event_id={watermark}` returns incremental mutation events after that watermark.
- `GET /api/sync/files/{id}` downloads attachment content for sync clients. Sync snapshots and file events include `download_url` and `preview_url`.
- `POST /api/sync/push` accepts idempotent note mutations from offline-capable clients. Each request must include `client_id` and each mutation must include `mutation_id`; duplicate mutations return the original result. Note updates with a stale `base_updated_at` return `status: "conflict"` and the current server record instead of overwriting.

Current push support is intentionally conservative: note create/update/archive/recycle/restore are supported first. Attachments, assets, categories, and full conflict UI remain future phases.

Phones, Android wrappers, desktop wrappers, PWAs, and future native clients should all use the same Docker/Pangolin DiVault server and this shared sync contract rather than platform-specific sync paths.

## Emergency Device Recovery

Emergency JSON snapshots are opt-in per browser. Create one from Security & data and choose a snapshot passphrase; while that browser tab/session remembers the passphrase, DiVault refreshes the encrypted local snapshot after successful sync. If the server is unreachable but the PWA shell is cached, DiVault opens an offline recovery screen where you can:

- Download the last synced emergency JSON from that device.
- Capture pending offline notes locally.
- Retry the server when it comes back online.

Pending offline notes sync automatically after login/session recovery when the server is reachable again.

Important limitation: encrypted secret values and uploaded file contents are protected by the server-side `/config/keys/master.key` and `/config/files`. Emergency snapshots can help recover the last synced notes and metadata available to that browser, but they are offline, device-local, and cannot replace the full server backup set. For full disaster recovery, keep scheduled/full backups of `/config` or DiVault backup ZIPs outside the server.

## Sensitive Values

These are auto-hidden and encrypted when saved:

```text
password: MySecret123
pwd: MySecret123
pass: MySecret123
secret: value
token: value
api key: value
key: value
🔒 Password: MySecret123
```

The visible editor hides saved `[hidden secret]` lines and shows encrypted values as inline secure blocks with reveal/copy controls.

## Code Blocks

Use the `⌘ Code` selector in the note editor to add script/snippet blocks. DiVault detects fenced code blocks and provides copy/download actions.

Examples:

````text
```powershell
Get-Service | Where-Object Status -eq Running
```
````

PowerShell downloads as `.ps1`, HTML as `.html`, JavaScript as `.js`, and so on.

## Security Notes

- `owner`, `admin`, and `editor` users can create/edit notes and reveal encrypted secrets.
- `viewer` users can read normal notes but cannot reveal secrets or mutate data.
- Login is rate-limited by IP.
- Mutating API requests use a double-submit CSRF token.
- 2FA recovery codes are shown once when generated. Store them outside the app.
- Sensitive security actions may require fresh 2FA reauthentication. If prompted, enter a current authenticator code or a stored recovery code before continuing.

## Backups and Restores

Full backup ZIPs contain:

- `/config/app.sqlite`
- `/config/keys/master.key`
- Uploaded files from `/config/files/`

When backup passphrase protection is available, create backups with a strong unique passphrase. The passphrase protects the ZIP archive in storage and transit, but anyone who can restore and run the backup with the included `keys/master.key` can decrypt DiVault secrets inside the restored app.

Restore handling:

1. Plaintext backup ZIPs restore normally from `/config/restore-pending.zip` on the next container restart.
2. Encrypted backup ZIPs require the passphrase to be placed in `/config/restore-passphrase` before restart.
3. The entrypoint uses PHP `ZipArchive` with `/config/restore-passphrase` during the pending restore, so AES-encrypted ZIPs produced by DiVault can be restored.
4. `/config/restore-passphrase` is deleted after the restore attempt succeeds or fails, so recreate it before retrying a failed encrypted restore.

Example encrypted restore staging:

```powershell
Copy-Item .\backup-20260512-120000.zip .\config\restore-pending.zip
Set-Content -LiteralPath .\config\restore-passphrase -Value "your backup passphrase" -NoNewline
docker restart divault-notes
```

Do not keep restore passphrases in Compose files, shell history, source control, or long-lived files. Prefer a temporary file with restrictive host permissions, then restart the container immediately.

## Migration

Preferred migration between servers:

1. Stop the old container.
2. Copy the full `/config` directory to the new server.
3. Start the new container with the copied `/config` mounted.
4. Update Pangolin routing if the hostname changed.
5. Verify login, files, notes, backups, and secret reveal.

Alternative migration:

1. Create a backup from Security & data.
2. Move the backup ZIP to the new server.
3. Restore/copy its contents into `/config` before starting the container. If the backup ZIP is encrypted, provide `/config/restore-passphrase` before starting the container or decrypt it in a trusted offline environment first.

In-app restore:

1. Open Security & data.
2. Schedule a backup restore.
3. Restart the container.
4. The entrypoint applies `/config/restore-pending.zip` before Apache starts.

## Desktop Helper Scripts

These wrappers keep desktop commands consistent from PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\desktop-dev.ps1
powershell -ExecutionPolicy Bypass -File scripts\desktop-build.ps1
powershell -ExecutionPolicy Bypass -File scripts\desktop-smoke.ps1
```

Pass `-PhpBin`, `-ConfigDir`, or `-RemoteUrl` to the desktop scripts to set `DIVAULT_PHP_BIN`, `DIVAULT_DESKTOP_CONFIG`, or `DIVAULT_REMOTE_URL` for that run.

`desktop-smoke.ps1` starts the built desktop executable, waits for `http://127.0.0.1:3444/api/health`, then stops the app and its local PHP server. Run `desktop-build.ps1` first if the release executable does not exist yet.

## Smoke Testing

After starting a local test container on port `3443`, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\smoke.ps1
```

The smoke test covers health, setup, login, CSRF, client creation, custom categories, encrypted note secrets, file upload/preview, backup creation/list/download, sessions, asset records, encrypted asset secrets, sync manifest/snapshot/pagination, file sync URLs, idempotent sync push, and conflict detection.

## Clean First-Run Test

To test first-run setup without touching your normal `./config` directory, run a separate container with an isolated config directory:

```powershell
docker run --rm -d --name divault-clean-test -p 3453:3443 -v "${PWD}\tmp-clean-config:/config" -e SECURE_COOKIES=false notes-notes:latest
powershell -ExecutionPolicy Bypass -File scripts\smoke.ps1 -BaseUrl http://localhost:3453
docker rm -f divault-clean-test
```

## Roadmap

- Make secret/code/file blocks fully inline editable without raw text syntax
- Add slash-command style insertion
- Complete WebAuthn/passkey enrollment and login
- Offline encrypted PWA cache
- Google Keep Takeout import
- Obsidian/Joplin Markdown folder import
- OCR for PDFs and images
- OnlyOffice integration as an optional extra container
- S3-compatible storage option
- Bundle PHP with desktop releases
- Add local-desktop-to-server conflict-safe merge sync
- Native mobile wrappers
- Browser extension and mobile share-sheet capture

## License

MIT License. See `LICENSE`.
