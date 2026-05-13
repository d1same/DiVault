<?php

require __DIR__ . '/../src/Config.php';
require __DIR__ . '/../src/Database.php';
require __DIR__ . '/../src/Crypto.php';
require __DIR__ . '/../src/Totp.php';
require __DIR__ . '/../src/App.php';

try {
    (new App())->handle();
} catch (Throwable $e) {
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json');
    }
    echo json_encode(['error' => 'Unexpected server error']);
}
