#!/bin/sh
set -e

log_info() {
  echo "[DiVault] $*"
}

log_error() {
  echo "[DiVault] ERROR: $*" >&2
}

is_bool_true() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    true|1|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

require_numeric_id() {
  name="$1"
  value="$2"
  case "$value" in
    ''|*[!0-9]*)
      log_error "$name must be a numeric id; received '${value:-unset}'"
      exit 1
      ;;
    0)
      log_error "$name=0 is not supported; use a non-root host id"
      exit 1
      ;;
  esac
}

www_uid="$(id -u www-data)"
www_gid="$(id -g www-data)"
target_uid="${PUID:-$www_uid}"
target_gid="${PGID:-$www_gid}"
require_numeric_id PUID "$target_uid"
require_numeric_id PGID "$target_gid"

target_group="$(getent group "$target_gid" | cut -d: -f1 || true)"
if [ -z "$target_group" ]; then
  target_group="www-data"
  if [ "$(getent group www-data | cut -d: -f3)" != "$target_gid" ]; then
    groupmod -g "$target_gid" www-data
  fi
fi

if [ "$(id -u www-data)" != "$target_uid" ]; then
  usermod -o -u "$target_uid" www-data
fi
if [ "$(id -g www-data)" != "$target_gid" ]; then
  usermod -g "$target_group" www-data
fi
export APACHE_RUN_USER=www-data
export APACHE_RUN_GROUP="$target_group"

log_info "Starting DiVault container"
log_info "Runtime user: www-data uid=$(id -u www-data) gid=$(id -g www-data) group=$(id -gn www-data) apache_group=$target_group"
log_info "Config: APP_CONFIG_DIR=${APP_CONFIG_DIR:-/config} DRIVE_FILES_DIR=${DRIVE_FILES_DIR:-unset} SKIP_CONFIG_CHOWN=${SKIP_CONFIG_CHOWN:-false} DIVAULT_CHOWN_MEDIA=${DIVAULT_CHOWN_MEDIA:-false}"

mkdir -p /config/files /config/backups /config/exports /config/imports /config/keys /config/logs /config/tmp /media
if [ -f /config/restore-pending.zip ]; then
  restore_ts="$(date -u +%Y%m%d-%H%M%S)"
  restore_stage="/config/tmp/restore-$restore_ts"
  restore_backup="/config/backups/pre-restore-$restore_ts"
  restore_passphrase_file="/config/restore-passphrase"
  restore_passphrase=""

  if [ -f "$restore_passphrase_file" ]; then
    restore_passphrase="$(cat "$restore_passphrase_file")"
  fi

  restore_cleanup() {
    rm -rf "$restore_stage"
    if [ -f "$restore_passphrase_file" ]; then
      rm -f "$restore_passphrase_file"
    fi
  }

  trap restore_cleanup EXIT HUP INT TERM

  mkdir -p "$restore_stage" "$restore_backup"
  log_info "Restore archive detected; validating /config/restore-pending.zip"

  RESTORE_PASSPHRASE="$restore_passphrase" RESTORE_STAGE="$restore_stage" php <<'PHP'
<?php
$zipPath = '/config/restore-pending.zip';
$stage = getenv('RESTORE_STAGE') ?: '';
$passphrase = getenv('RESTORE_PASSPHRASE') ?: '';
if ($stage === '') {
    fwrite(STDERR, "Restore stage missing\n");
    exit(1);
}
$zip = new ZipArchive();
if ($zip->open($zipPath) !== true) {
    fwrite(STDERR, "Refusing restore-pending.zip: invalid ZIP\n");
    exit(1);
}
if ($passphrase !== '' && !$zip->setPassword($passphrase)) {
    fwrite(STDERR, "Refusing restore-pending.zip: invalid passphrase\n");
    exit(1);
}
$hasDb = false;
$dbIndex = false;
$safeRelative = static function (string $path): bool {
    if ($path === '' || str_starts_with($path, '/') || preg_match('/^[A-Za-z]:\//', $path)) return false;
    foreach (explode('/', $path) as $part) {
        if ($part === '' || $part === '.' || $part === '..' || str_starts_with($part, '.')) return false;
    }
    return true;
};
for ($i = 0; $i < $zip->numFiles; $i++) {
    $entry = $zip->getNameIndex($i);
    if ($entry === false || str_contains($entry, '\\') || str_starts_with($entry, '/')) {
        fwrite(STDERR, "Refusing restore-pending.zip: unsafe entry: $entry\n");
        exit(1);
    }
    if ($zip->getExternalAttributesIndex($i, $opsys, $attrs) && $opsys === 3) {
        $mode = ($attrs >> 16) & 0170000;
        if ($mode !== 0 && !in_array($mode, [0040000, 0100000], true)) {
            fwrite(STDERR, "Refusing restore-pending.zip: unsafe file type: $entry\n");
            exit(1);
        }
    }
    if ($entry === 'app.sqlite') {
        $hasDb = true;
        $dbIndex = $i;
        continue;
    }
    if ($entry === 'keys/master.key' || $entry === 'keys/' || $entry === 'files/' || preg_match('#^files/[^/]+$#', $entry)) {
        continue;
    }
    if ($entry === 'drive-storage.json') {
        $settings = json_decode($zip->getFromIndex($i) ?: '', true);
        if (!is_array($settings)) {
            fwrite(STDERR, "Refusing restore-pending.zip: invalid Drive storage settings\n");
            exit(1);
        }
        $dir = rtrim(trim((string)($settings['drive_files_dir'] ?? '')), '/');
        if ($dir !== '' && (!str_starts_with($dir, '/') || in_array($dir, ['/', '/proc', '/sys', '/dev'], true))) {
            fwrite(STDERR, "Refusing restore-pending.zip: unsafe Drive storage settings\n");
            exit(1);
        }
        continue;
    }
    if (preg_match('#^drive-files/(.+)$#', $entry, $m) && $safeRelative($m[1])) {
        continue;
    }
    fwrite(STDERR, "Refusing restore-pending.zip: unexpected entry: $entry\n");
    exit(1);
}
if (!$hasDb) {
    fwrite(STDERR, "Refusing restore-pending.zip: app.sqlite missing\n");
    exit(1);
}
if ($zip->getFromIndex((int)$dbIndex, 1) === false) {
    fwrite(STDERR, $passphrase !== '' ? "Refusing restore-pending.zip: invalid passphrase\n" : "Refusing restore-pending.zip: passphrase required\n");
    exit(1);
}
if (!$zip->extractTo($stage)) {
    fwrite(STDERR, "Refusing restore-pending.zip: extraction failed\n");
    exit(1);
}
$zip->close();
PHP

  if find "$restore_stage" \( -type l -o \( ! -type f ! -type d \) \) | grep -q .; then
    echo "Refusing restore-pending.zip: unsafe file type in archive" >&2
    exit 1
  fi

  if [ -f /config/app.sqlite ]; then
    log_info "Backing up current database before restore"
    cp -a /config/app.sqlite "$restore_backup/app.sqlite"
  fi
  if [ -f /config/keys/master.key ]; then
    mkdir -p "$restore_backup/keys"
    cp -a /config/keys/master.key "$restore_backup/keys/master.key"
  fi
  if [ -f /config/drive-storage.json ]; then
    cp -a /config/drive-storage.json "$restore_backup/drive-storage.json"
  fi

  if [ -f "$restore_stage/app.sqlite" ]; then
    cp -a "$restore_stage/app.sqlite" /config/app.sqlite
  fi
  if [ -f "$restore_stage/keys/master.key" ]; then
    mkdir -p /config/keys
    cp -a "$restore_stage/keys/master.key" /config/keys/master.key
  fi
  if [ -f "$restore_stage/drive-storage.json" ]; then
    cp -a "$restore_stage/drive-storage.json" /config/drive-storage.json
  fi
  if [ -d "$restore_stage/files" ]; then
    mkdir -p /config/files
    cp -a "$restore_stage/files/." /config/files/
  fi
  if [ -d "$restore_stage/drive-files" ]; then
    restore_drive_dir="$(php <<'PHP'
<?php
$settingsFile = '/config/drive-storage.json';
$dir = '';
if (is_file($settingsFile)) {
    $settings = json_decode((string)file_get_contents($settingsFile), true);
    if (is_array($settings)) $dir = rtrim(trim((string)($settings['drive_files_dir'] ?? '')), '/');
}
if ($dir === '') $dir = rtrim(getenv('DRIVE_FILES_DIR') ?: '/config/drive-files', '/');
if ($dir === '' || !str_starts_with($dir, '/') || in_array($dir, ['/', '/proc', '/sys', '/dev'], true)) $dir = '/config/drive-files';
echo $dir;
PHP
)"
    mkdir -p "$restore_drive_dir"
    cp -a "$restore_stage/drive-files/." "$restore_drive_dir/"
  fi

  restore_cleanup
  trap - EXIT HUP INT TERM
  mv /config/restore-pending.zip "/config/backups/restored-$(date -u +%Y%m%d-%H%M%S).zip"
  log_info "Restore completed successfully"
fi

if is_bool_true "${SKIP_CONFIG_CHOWN:-false}"; then
  log_info "Skipping /config ownership repair because SKIP_CONFIG_CHOWN=${SKIP_CONFIG_CHOWN}"
else
  log_info "Repairing /config ownership to uid=$(id -u www-data) gid=$(id -g www-data)"
  for path in /config /config/app.sqlite /config/files /config/backups /config/exports /config/imports /config/keys /config/logs /config/tmp; do
    if [ -e "$path" ]; then
      log_info "chown -R www-data:$(id -gn www-data) $path"
      chown -R www-data:"$(id -gn www-data)" "$path"
    fi
  done
fi

if is_bool_true "${DIVAULT_CHOWN_MEDIA:-false}"; then
  if [ -e /media ]; then
    log_info "Repairing /media ownership to uid=$(id -u www-data) gid=$(id -g www-data)"
    chown -R www-data:"$(id -gn www-data)" /media
  fi
else
  log_info "Skipping /media recursive chown; set DIVAULT_CHOWN_MEDIA=true if Unraid media share ownership also needs repair"
fi

php <<'PHP'
<?php
$url = getenv('ONLYOFFICE_PUBLIC_URL') ?: '';
$source = '';
if ($url !== '') {
    $parts = parse_url($url);
    $scheme = strtolower((string)($parts['scheme'] ?? ''));
    $host = (string)($parts['host'] ?? '');
    if (in_array($scheme, ['http', 'https'], true) && $host !== '') {
        $source = $scheme . '://' . $host . (isset($parts['port']) ? ':' . (int)$parts['port'] : '');
    }
}
$extra = $source !== '' ? ' ' . $source : '';
$csp = "default-src 'self'; script-src 'self'{$extra}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'{$extra}; media-src 'self' blob:; frame-src 'self' blob:{$extra}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";
$path = '/var/www/html/.htaccess';
if (is_file($path)) {
    $line = 'Header always set Content-Security-Policy "' . addcslashes($csp, "\\\"") . '"';
    $contents = (string)file_get_contents($path);
    if (preg_match('/^Header always set Content-Security-Policy .*$/m', $contents)) {
        $contents = preg_replace('/^Header always set Content-Security-Policy .*$/m', $line, $contents);
    } else {
        $contents = rtrim($contents) . PHP_EOL . $line . PHP_EOL;
    }
    file_put_contents($path, $contents);
}
PHP

log_info "Apache starting on port ${APP_PORT:-3443}"
exec "$@"
