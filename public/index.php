<?php

if (PHP_SAPI === 'cli-server') {
    $path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/';
    $file = realpath(__DIR__ . $path);
    $root = realpath(__DIR__);
    if ($file && $root && str_starts_with($file, $root) && is_file($file) && pathinfo($file, PATHINFO_EXTENSION) !== 'php') {
        return false;
    }
}

require __DIR__ . '/../src/Config.php';
require __DIR__ . '/../src/Database.php';
require __DIR__ . '/../src/Crypto.php';
require __DIR__ . '/../src/Totp.php';
require __DIR__ . '/../src/App.php';

try {
    (new App())->handle();
} catch (Throwable $e) {
    $method = $_SERVER['REQUEST_METHOD'] ?? 'unknown';
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
    $path = preg_replace('#^/api/integrations/onlyoffice/(download|callback)/[^/]+$#', '/api/integrations/onlyoffice/$1/[redacted]', $path) ?? $path;
    error_log(sprintf('[DiVault] Unhandled request error method=%s path=%s class=%s message=%s', $method, $path, get_class($e), $e->getMessage()));
    if (strtolower((string)(getenv('DIVAULT_LOG_LEVEL') ?: 'info')) === 'debug') {
        error_log($e->getTraceAsString());
    }
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json');
    }
    echo json_encode(['error' => 'Unexpected server error']);
}
