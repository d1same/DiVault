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
        $dir = rtrim(getenv('DRIVE_FILES_DIR') ?: self::dir() . '/drive-files', '/');
        return $dir !== '' ? $dir : self::dir() . '/drive-files';
    }

    public static function driveUploadMaxBytes(): int
    {
        $mb = (int)(getenv('DRIVE_UPLOAD_MAX_MB') ?: 250);
        return max(1, $mb) * 1024 * 1024;
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
