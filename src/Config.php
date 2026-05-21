<?php

final class Config
{
    public static function dir(): string
    {
        return rtrim(getenv('APP_CONFIG_DIR') ?: '/config', '/');
    }

    public static function appUrl(): string
    {
        return rtrim(getenv('APP_URL') ?: '', '/');
    }

    public static function driveFilesDir(): string
    {
        $settings = self::driveStorageSettings();
        $dir = rtrim((string)($settings['drive_files_dir'] ?? '') ?: (getenv('DRIVE_FILES_DIR') ?: self::dir() . '/drive-files'), '/');
        return $dir !== '' ? $dir : self::dir() . '/drive-files';
    }

    public static function driveUploadMaxBytes(): int
    {
        $settings = self::driveStorageSettings();
        $mb = (int)((string)($settings['drive_upload_max_mb'] ?? '') ?: (getenv('DRIVE_UPLOAD_MAX_MB') ?: 250));
        return max(1, $mb) * 1024 * 1024;
    }

    public static function driveStorageSettings(): array
    {
        $file = self::dir() . '/drive-storage.json';
        if (!is_file($file)) return [];
        $data = json_decode((string)file_get_contents($file), true);
        return is_array($data) ? $data : [];
    }

    public static function saveDriveStorageSettings(array $settings): void
    {
        $file = self::dir() . '/drive-storage.json';
        file_put_contents($file, json_encode($settings, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
        @chmod($file, 0660);
    }

    public static function secureCookies(): bool
    {
        return filter_var(getenv('SECURE_COOKIES') ?: 'true', FILTER_VALIDATE_BOOL);
    }

    public static function trustProxy(): bool
    {
        return filter_var(getenv('TRUST_PROXY') ?: 'false', FILTER_VALIDATE_BOOL);
    }

    public static function isDesktop(): bool
    {
        return filter_var(getenv('DIVAULT_DESKTOP') ?: 'false', FILTER_VALIDATE_BOOL);
    }

    public static function aiReviewApiToken(): string
    {
        return trim(getenv('AI_REVIEW_API_TOKEN') ?: '');
    }

    public static function aiReviewUserEmail(): string
    {
        return strtolower(trim(getenv('AI_REVIEW_USER_EMAIL') ?: ''));
    }

    public static function onlyOfficeUrl(): string
    {
        return rtrim(trim(getenv('ONLYOFFICE_URL') ?: ''), '/');
    }

    public static function onlyOfficePublicUrl(): string
    {
        return rtrim(trim(getenv('ONLYOFFICE_PUBLIC_URL') ?: self::onlyOfficeUrl()), '/');
    }

    public static function onlyOfficeCallbackBaseUrl(): string
    {
        return rtrim(trim(getenv('ONLYOFFICE_CALLBACK_BASE_URL') ?: self::appUrl()), '/');
    }

    public static function onlyOfficeJwtSecret(): string
    {
        return trim(getenv('ONLYOFFICE_JWT_SECRET') ?: '');
    }

    public static function ensureDirs(): void
    {
        foreach (['', '/files', '/backups', '/exports', '/imports', '/keys', '/logs', '/tmp'] as $path) {
            $dir = self::dir() . $path;
            if (!is_dir($dir)) {
                mkdir($dir, 0770, true);
            }
        }
        $driveFilesDir = self::driveFilesDir();
        if (!is_dir($driveFilesDir)) {
            mkdir($driveFilesDir, 0770, true);
        }
    }
}
