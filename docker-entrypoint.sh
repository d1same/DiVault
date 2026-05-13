#!/bin/sh
set -e

mkdir -p /config/files /config/backups /config/exports /config/imports /config/keys /config/logs /config/tmp
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
for ($i = 0; $i < $zip->numFiles; $i++) {
    $entry = $zip->getNameIndex($i);
    if ($entry === false || str_contains($entry, '..') || str_contains($entry, '\\') || str_starts_with($entry, '/')) {
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
    cp -a /config/app.sqlite "$restore_backup/app.sqlite"
  fi
  if [ -f /config/keys/master.key ]; then
    mkdir -p "$restore_backup/keys"
    cp -a /config/keys/master.key "$restore_backup/keys/master.key"
  fi

  if [ -f "$restore_stage/app.sqlite" ]; then
    cp -a "$restore_stage/app.sqlite" /config/app.sqlite
  fi
  if [ -f "$restore_stage/keys/master.key" ]; then
    mkdir -p /config/keys
    cp -a "$restore_stage/keys/master.key" /config/keys/master.key
  fi
  if [ -d "$restore_stage/files" ]; then
    mkdir -p /config/files
    cp -a "$restore_stage/files/." /config/files/
  fi

  restore_cleanup
  trap - EXIT HUP INT TERM
  mv /config/restore-pending.zip "/config/backups/restored-$(date -u +%Y%m%d-%H%M%S).zip"
fi

if [ "${SKIP_CONFIG_CHOWN:-false}" != "true" ]; then
  for path in /config/app.sqlite /config/files /config/backups /config/exports /config/imports /config/keys /config/logs /config/tmp; do
    if [ -e "$path" ]; then
      chown -R www-data:www-data "$path"
    fi
  done
fi

exec "$@"
