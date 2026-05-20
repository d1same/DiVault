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
        foreach (['', '/files', '/drive-files', '/backups', '/exports', '/imports', '/keys', '/logs', '/tmp'] as $path) {
            $dir = self::dir() . $path;
            if (!is_dir($dir)) {
                mkdir($dir, 0770, true);
            }
        }
    }
}
