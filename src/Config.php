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

    public static function secureCookies(): bool
    {
        return filter_var(getenv('SECURE_COOKIES') ?: 'true', FILTER_VALIDATE_BOOL);
    }

    public static function trustProxy(): bool
    {
        return filter_var(getenv('TRUST_PROXY') ?: 'false', FILTER_VALIDATE_BOOL);
    }

    public static function ensureDirs(): void
    {
        foreach (['', '/files', '/backups', '/exports', '/imports', '/keys', '/logs', '/tmp'] as $path) {
            $dir = self::dir() . $path;
            if (!is_dir($dir)) {
                mkdir($dir, 0770, true);
            }
        }
    }
}
