# DiVault

DiVault is a self-hosted private workspace for notes, files, secrets, calendars, tasks, reminders, and lightweight client documentation.

Run it with Docker, open it in a browser, install it as a PWA, use the Windows desktop app, or connect with the Android client. Browser, desktop remote mode, Android, and PWA clients all use the same DiVault server and SQLite database.

![DiVault desktop showcase](docs/screenshots/desktop-showcase.png)

![DiVault Drive file manager showcase](docs/screenshots/drive-showcase.png)

![DiVault calendar showcase](docs/screenshots/calendar-showcase.png)

![DiVault task planning showcase](docs/screenshots/tasks-showcase.png)

![DiVault Android showcase](docs/screenshots/android-showcase.png)

## Quick Install

### Docker Compose

```bash
git clone https://github.com/<github-owner-or-org>/DiVault.git
cd DiVault
docker compose up -d --build
```

Open `http://localhost:3443` and create the owner account.

The included Compose file binds DiVault to `127.0.0.1` by default so a fresh setup is not exposed before the owner account exists. To expose it directly on your LAN, set `DIVAULT_BIND=0.0.0.0`; for production, keep it behind an HTTPS reverse proxy and set `SECURE_COOKIES=true`.

### Prebuilt Image

```text
ghcr.io/<github-owner-or-org>/divault:latest
```

Replace `<github-owner-or-org>` with the GitHub account or organization that owns the package.

Example Compose service:

```yaml
services:
  notes:
    image: ghcr.io/<github-owner-or-org>/divault:latest
    container_name: divault-notes
    ports:
      - "127.0.0.1:3443:3443"
    volumes:
      - /mnt/user/appdata/divault:/config
      - /mnt/user/divault-drive-files:/media
    environment:
      APP_URL: "https://notes.example.com"
      APP_CONFIG_DIR: "/config"
      DRIVE_FILES_DIR: ""
      DRIVE_UPLOAD_MAX_MB: ""
      ONLYOFFICE_URL: ""
      ONLYOFFICE_PUBLIC_URL: ""
      ONLYOFFICE_CALLBACK_BASE_URL: ""
      ONLYOFFICE_JWT_SECRET: ""
      TRUST_PROXY: "true"
      SECURE_COOKIES: "true"
      TZ: "America/New_York"
    restart: unless-stopped
```

For local plain-HTTP testing only:

```yaml
SECURE_COOKIES: "false"
```

Keep `SECURE_COOKIES=true` in production.

## Reverse Proxy

Put DiVault behind HTTPS with Pangolin, Caddy, Nginx Proxy Manager, Traefik, or another reverse proxy.

Recommended production environment values:

```text
APP_URL=https://notes.example.com
TRUST_PROXY=true
SECURE_COOKIES=true
```

The container listens on HTTP port `3443`. Your reverse proxy provides public HTTPS.

## Features

- Home dashboard with recent notes and schedule summary
- Notes, quick notes, archive, recycle bin, categories, and subcategories
- Rich note blocks for text, headings, lists, checklists, code, tables, drawings, files, and secrets
- File, photo, and document attachments
- Drive workspace with a native-style file manager, private folders, explicit sharing, previews, multi-select, ZIP compress/extract, and document editing hooks
- Auto-hidden encrypted sensitive lines such as passwords, tokens, API keys, and secrets
- Optional Calendar and Tasks modules per user
- Day, Week, Month, Year, and Schedule calendar views
- Internal calendar sharing with `view`, `edit`, and `admin` permissions
- Recurring calendar events and linked notes
- Browser reminders for events and tasks
- `.ics` calendar import/export for Google Calendar, Apple Calendar, Outlook, and Microsoft 365 workflows
- Multi-user accounts with owner/admin/editor/viewer roles
- Admin user management for creating users, resetting another user's password, and safely disabling accounts
- Optional 2FA, recovery codes, sessions, audit log, and passkeys/WebAuthn
- PWA, Windows desktop app, and Android WebView client
- JSON export, full backup ZIPs, encrypted backup ZIPs, and restore staging
- AI review-note REST API for external tools

## First Run

1. Start the container.
2. Open DiVault locally or through your HTTPS reverse proxy.
3. Create the owner account.
4. Open Settings.
5. Enable Calendar and Tasks if you want schedule features.
6. Enable 2FA or passkeys if desired.
7. Install the PWA from your browser menu if you want an app shortcut.

## Persistent Data

DiVault stores application data under `/config`:

```text
/config/app.sqlite
/config/files/
/config/drive-files/
/config/backups/
/config/exports/
/config/imports/
/config/keys/master.key
/config/logs/
/config/tmp/
```

Keep `/config/keys/master.key` safe. If it is lost, encrypted sensitive values cannot be recovered.

Full backup ZIPs include the SQLite database, uploaded files, and the master key. Treat backup ZIPs like production secrets.

## Drive

Drive is the DiVault file workspace for documents that should live outside an individual note. It is designed around private, user-owned folders and files with a compact file-manager interface:

- Create folders for clients, projects, procedures, and reference material.
- Upload small business documents, text files, PDFs, images, and other file types supported by the server upload limits.
- List folders and files, preview browser-safe files, and download originals.
- Rename, move, or delete files and folders as the Drive API exposes those actions.
- Share specific files or folders with other DiVault users using explicit permissions.
- Select multiple visible files or folders with checkboxes, Ctrl/Cmd-click, or Shift-click range selection on desktop-class pointers.
- Right-click files, folders, and note cards on desktop-class pointers to open context actions; touch devices keep explicit `...` actions.
- Compress selected Drive items into ZIP files and extract ZIP archives into folders.
- Edit text-like files such as TXT, Markdown, CSV, JSON, XML, HTML, CSS, and JS directly in the browser.
- Edit Word, Excel, and PowerPoint-style files through an optional OnlyOffice Document Server sidecar.

Privacy model:

- Drive items are private to the owning user by default.
- Owner/admin accounts can administer users and backups, but normal users cannot browse another user's Drive files through Drive URLs.
- Admin role alone does not grant read access to another user's private Drive files.
- Mutating Drive requests use the same logged-in session and CSRF protection as notes, files, backups, and settings.
- User deletion in Settings is a safe disable operation: it revokes sessions and sign-in while preserving existing data for backups, ownership, and audit history.

Backup model:

- Drive metadata is stored in the SQLite database.
- Drive uploads are stored under `/config/drive-files/` by default.
- Full backup ZIPs and encrypted backup ZIPs include Drive data because they include `/config/app.sqlite`, `/config/files/`, the configured Drive files directory, and `/config/keys/master.key`.

Storage and upload limits:

- `DRIVE_FILES_DIR` changes the container path where Drive file contents are stored. Leave it unset for the default `/config/drive-files` path.
- `DRIVE_UPLOAD_MAX_MB` controls the app-level Drive upload limit. The Docker default is `250` MB.
- Admins can also set the Drive files path in Settings → Workspace → Drive storage. Enter the container path DiVault can see, such as `/media`; Docker decides which host folder or disk is mounted there.
- The Docker image PHP upload ceiling is higher (`upload_max_filesize=2G`, `post_max_size=2G`, `max_execution_time=600`, `max_input_time=600`, `memory_limit=512M`) so the app limit can be raised without rebuilding the image.

Host path vs container path:

- Host path is the real folder on the Docker host, NAS, or mounted disk, for example `/mnt/user/divault-drive-files`.
- Container path is the path inside the DiVault container, for example `/media`.
- The Compose volume line connects them as `host-path:container-path`; DiVault should be configured with the container path, not the host path.

Example external Drive storage mount:

```yaml
services:
  notes:
    volumes:
      - /mnt/user/appdata/divault:/config
      - /mnt/user/divault-drive-files:/media
    environment:
      APP_CONFIG_DIR: "/config"
      DRIVE_FILES_DIR: ""
      DRIVE_UPLOAD_MAX_MB: ""
```

Then open Settings → Workspace → Drive storage and set:

```text
Drive files path: /media
Upload limit MB: 1024
```

To attach a different drive, change the host side of the volume, for example `DIVAULT_MEDIA_PATH=/mnt/disk2/divault-drive-files`, recreate the container, then keep the Drive files path set to `/media`. DiVault uses one active Drive storage path at a time. If you want multiple physical drives behind Drive, combine them on the host first with a NAS share, storage pool, merger/union filesystem, or mounted subfolders under one parent folder, then mount that combined location into the container.

Office editing:

- Drive includes built-in text-file editing and optional OnlyOffice editing for Word, Excel, and PowerPoint-style files.
- OnlyOffice Document Server runs as a sidecar with `docker-compose.onlyoffice.yml`; the default DiVault container stays lightweight.
- Leave OnlyOffice disabled if you want the smallest/default DiVault deployment.

Optional OnlyOffice sidecar:

```bash
ONLYOFFICE_JWT_SECRET='<generate-a-long-random-secret>' \
ONLYOFFICE_URL='http://onlyoffice' \
ONLYOFFICE_PUBLIC_URL='http://127.0.0.1:8082' \
ONLYOFFICE_CALLBACK_BASE_URL='http://notes:3443' \
docker compose -f docker-compose.yml -f docker-compose.onlyoffice.yml up -d
```

Generate a unique JWT secret before enabling the sidecar and reuse the same value for DiVault and OnlyOffice. The sidecar compose file starts `onlyoffice/documentserver` as `divault-onlyoffice` and exposes it on host port `8082` by default. Local Docker uses `ONLYOFFICE_URL=http://onlyoffice` for DiVault-to-OnlyOffice traffic, `ONLYOFFICE_PUBLIC_URL=http://127.0.0.1:8082` so the browser can load the editor, and `ONLYOFFICE_CALLBACK_BASE_URL=http://notes:3443` so Document Server can fetch and save Drive files over the Docker network. For production, put both DiVault and OnlyOffice behind HTTPS and set the public/callback URLs to routable HTTPS origins.

OnlyOffice configuration variables:

- `ONLYOFFICE_URL` tells DiVault where the Document Server is from the app container. Use `http://onlyoffice` for local Docker networking.
- `ONLYOFFICE_PUBLIC_URL` is the browser-reachable Document Server URL used to load `/web-apps/apps/api/documents/api.js`.
- `ONLYOFFICE_CALLBACK_BASE_URL` is the DiVault URL reachable from the Document Server for signed download and save callbacks.
- `ONLYOFFICE_JWT_SECRET` must match the sidecar `JWT_SECRET`.
- `ONLYOFFICE_PORT` changes the host port for the sidecar. The default is `8082`.
- `ONLYOFFICE_IMAGE` can pin the Document Server image tag. Keep the default only for local testing; pin a tested version in production.

## Notes And Secrets

These lines are auto-hidden and encrypted when saved:

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

The editor shows saved secrets as secure inline blocks with reveal/copy controls.

## Calendar And Tasks

Calendar and Tasks are optional per-user features.

Calendar supports:

- Personal calendars
- Shared internal calendars
- Day, Week, Month, Year, and Schedule views
- Click/tap-to-add from calendar cells
- Recurring events
- Event reminders
- Linked notes
- `.ics` import/export

Tasks support:

- Private tasks
- Tasks attached to shared calendars
- Due dates and reminders
- Done/open status
- Linked notes
- Calendar visibility when assigned to a date/calendar

Google/Microsoft sync is intentionally simple: use `.ics` import/export instead of OAuth account sync.

## Desktop App

Download the Windows installer from GitHub Releases:

```text
DiVault_*_x64-setup.exe
```

An `.msi` installer is also published for users who prefer MSI packages.

Desktop modes:

- Standalone local vault: runs the bundled PHP runtime at `http://127.0.0.1:3444` and stores local data in the Windows user app-data folder.
- Server mode: opens your hosted DiVault server URL directly, sharing the same data as browser, PWA, and Android clients.

Developer commands:

```powershell
npm install
npm run desktop:dev
npm run desktop:build
```

Helper scripts:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\desktop-dev.ps1
powershell -ExecutionPolicy Bypass -File scripts\desktop-build.ps1
powershell -ExecutionPolicy Bypass -File scripts\desktop-smoke.ps1
```

Useful desktop environment variables:

```text
DIVAULT_DESKTOP_CONFIG=C:\path\to\divault-desktop-data
DIVAULT_PHP_BIN=C:\path\to\php.exe
DIVAULT_REMOTE_URL=https://notes.example.com
```

## Android App

Download the signed APK from GitHub Releases:

```text
DiVault_*_android-signed.apk
```

The Android app is a server-connected WebView client.

- First launch asks for your DiVault server URL.
- The server URL is saved on the device.
- JavaScript, DOM storage, uploads, and Android share intents are enabled.
- If the server is unavailable, Android shows retry and change-server actions.
- Android Settings includes a Change server action.
- Android system Back sends DiVault to the background.

If Android rejects a signed APK update over an older debug APK, uninstall the debug APK once and install the signed APK.

Build from source by opening `android/` in Android Studio with JDK 17 or newer.

## Sync Between Devices

DiVault is server-backed. Use the same DiVault URL on every device.

- Notes save to the server when saved or autosaved.
- Devices refresh on focus, reconnect, and periodic sync while open.
- The sync pill shows the current connection state.
- Docker, browser/PWA, Android, and desktop server mode share the same server data.

Current sync API support is conservative:

- Notes, clients, categories, assets, and files are included in the sync API foundation.
- `POST /api/sync/push` supports idempotent note mutations.
- Calendar, Tasks, reminders, and shares use normal online server APIs and are not offline sync-push entities yet.

Emergency/offline snapshots are for device-local note recovery. Calendar and Tasks should be treated as online server-backed data for this release.

## Joplin Markdown Import

Export Joplin notebooks as `MD - Markdown + Front Matter`, then import from Settings > Import / export > Import Markdown folder.

The importer keeps note titles, Markdown bodies, tags, created/updated timestamps, and maps subfolders to categories.

## Backups And Restores

Full backup ZIPs include:

- `/config/app.sqlite`
- `/config/keys/master.key`
- Uploaded note files from `/config/files/`
- Drive files from `/config/drive-files/`

The database includes notes, Drive metadata, users, settings, categories, assets, calendars, calendar shares, events, tasks, reminders, and audit records.

Restore options:

1. Upload or stage a backup as `/config/restore-pending.zip`.
2. If encrypted, place the passphrase in `/config/restore-passphrase`.
3. Restart the container.
4. The entrypoint applies the pending restore before Apache starts.

Example encrypted restore staging:

```powershell
Copy-Item .\backup-20260512-120000.zip .\config\restore-pending.zip
Set-Content -LiteralPath .\config\restore-passphrase -Value "your backup passphrase" -NoNewline
docker restart divault-notes
```

Do not store restore passphrases in Compose files, shell history, source control, or long-lived files.

## Migration

Preferred migration between servers:

1. Stop the old container.
2. Copy the full `/config` directory to the new server.
3. Start the new container with the copied `/config` mounted.
4. Update reverse proxy routing if the hostname changed.
5. Verify login, notes, files, calendars, tasks, backups, and secret reveal.

## Security Notes

- `owner`, `admin`, and `editor` users can create and edit content.
- `viewer` users can read normal notes but cannot reveal encrypted secrets or mutate data.
- Login is rate-limited by IP.
- Mutating browser API requests use double-submit CSRF protection.
- Calendar sharing is internal-only and permission checked server-side.
- Export/import/backup/admin tools require admin-level access where appropriate.
- Owner/admin users can reset other users' passwords and disable accounts; self-password changes still use the profile password flow.
- 2FA recovery codes are shown once. Store them outside DiVault.
- Sensitive security actions may require fresh 2FA reauthentication.

## AI Review Notes API

External tools can create review notes using a dedicated API token.

Server URL:

```text
https://notes.example.com/api/integrations/ai/review-notes
```

Desktop local URL:

```text
http://127.0.0.1:3444/api/integrations/ai/review-notes
```

Server environment variables:

```text
AI_REVIEW_API_TOKEN=use-a-long-random-token
AI_REVIEW_USER_EMAIL=owner@example.com
```

Example request:

```bash
curl -X POST "https://notes.example.com/api/integrations/ai/review-notes" \
  -H "X-DiVault-AI-Token: $AI_REVIEW_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "my-ai-reviewer",
    "review": {
      "title": "Weekly infrastructure review",
      "severity": "info",
      "body": "Summarized changes and follow-up items.",
      "findings": [
        { "location": "server-01", "message": "Patch window should be scheduled." }
      ]
    }
  }'
```

`X-API-Key: ...` and `Authorization: Bearer ...` are also accepted. `X-DiVault-AI-Token` is the most explicit option for DiVault, while `X-API-Key` is useful for agents that only expose a generic API key header.

## Smoke Testing

After starting a local container on port `3443`, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\smoke.ps1
```

The smoke test covers health, setup, login, CSRF, notes, categories, encrypted note secrets, file upload/preview, backups, sessions, asset records, encrypted asset secrets, sync manifest/snapshot/pagination, file sync URLs, idempotent sync push, and conflict detection. It also probes `/api/drive`; when Drive endpoints are available it validates folder creation, text and PDF-like uploads, listing, preview, download, text editing, optional rename/delete endpoints, and a best-effort multi-user privacy check.

## Clean First-Run Test

```powershell
docker run --rm -d --name divault-clean-test -p 3453:3443 -v "${PWD}\tmp-clean-config:/config" -e SECURE_COOKIES=false ghcr.io/<github-owner-or-org>/divault:latest
powershell -ExecutionPolicy Bypass -File scripts\smoke.ps1 -BaseUrl http://localhost:3453
docker rm -f divault-clean-test
```

## Roadmap

- Conflict-safe offline sync beyond notes
- Calendar/task sync-push support for offline-capable clients
- Browser extension capture
- Google Keep Takeout import
- OCR for PDFs and images
- Optional S3-compatible file storage
- External calendar feed sync controls

## License

MIT License. See `LICENSE`.
