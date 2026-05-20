<?php

final class App
{
    private const ICS_IMPORT_MAX_BYTES = 5242880;
    private const ICS_IMPORT_MAX_EVENTS = 10000;
    private const ICS_FEED_MAX_EVENTS = 5000;

    private PDO $db;
    private Crypto $crypto;

    public function __construct()
    {
        $this->db = (new Database())->pdo();
        $this->crypto = new Crypto();
        $this->seedOwnerIfNeeded();
    }

    public function handle(): void
    {
        $this->securityHeaders();
        $path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/';
        if (!str_starts_with($path, '/api')) {
            $shell = rtrim($_SERVER['DOCUMENT_ROOT'] ?? '', '/\\') . '/app.html';
            if (!is_file($shell)) $shell = dirname(__DIR__) . '/public/app.html';
            require $shell;
            return;
        }

        header('Content-Type: application/json');
        header('Cache-Control: no-store');
        try {
            $this->route($_SERVER['REQUEST_METHOD'], substr($path, 4) ?: '/');
        } catch (Throwable $e) {
            $clientError = $e instanceof RuntimeException && !$e instanceof PDOException;
            http_response_code($clientError ? 400 : 500);
            echo json_encode(['error' => $clientError ? $e->getMessage() : 'Unexpected server error']);
        }
    }

    private function route(string $method, string $path): void
    {
        if ($method === 'GET' && $path === '/health') $this->json(['ok' => true]);
        if ($method === 'GET' && $path === '/bootstrap') $this->bootstrap();
        if ($method === 'POST' && $path === '/setup') $this->setup();
        if ($method === 'POST' && $path === '/setup/restore' && $this->needsSetup()) $this->setupRestoreUpload();
        if ($method === 'POST' && $path === '/desktop/server' && $this->needsSetup()) $this->saveDesktopServer();
        if ($method === 'POST' && $path === '/login/check') $this->loginCheck();
        if ($method === 'POST' && $path === '/login') $this->login();
        if ($method === 'POST' && $path === '/webauthn/login/options') $this->webauthnLoginOptions();
        if ($method === 'POST' && $path === '/webauthn/login') $this->webauthnLogin();
        if ($method === 'POST' && $path === '/logout') $this->logout();
        if ($method === 'POST' && $path === '/integrations/ai/review-notes') $this->createAiReviewNote();

        $user = $this->requireUser();
        $this->applyRetentionPolicy();
        if (in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
            $this->requireCsrf();
        }
        if ($method === 'GET' && $path === '/me') $this->json(['user' => $this->publicUser($user)]);
        if ($method === 'GET' && $path === '/desktop/server') $this->desktopServer($user);
        if ($method === 'POST' && $path === '/desktop/server') $this->saveDesktopServer($user);
        if ($method === 'DELETE' && $path === '/desktop/server') $this->clearDesktopServer($user);
        if ($method === 'POST' && $path === '/profile') $this->updateProfile($user);
        if ($method === 'GET' && $path === '/sessions') $this->sessions($user);
        if ($method === 'DELETE' && preg_match('#^/sessions/(\d+)$#', $path, $m)) $this->revokeSession($user, (int)$m[1]);
        if ($method === 'GET' && $path === '/sync/manifest') $this->syncManifest($user);
        if ($method === 'GET' && $path === '/sync/pull') $this->syncPull($user);
        if ($method === 'POST' && $path === '/sync/push') $this->syncPush($user);
        if ($method === 'GET' && $path === '/retention-settings') $this->retentionSettings($user);
        if ($method === 'POST' && $path === '/retention-settings') $this->saveRetentionSettings($user);
        if ($method === 'GET' && $path === '/features') $this->featureSettings($user);
        if ($method === 'PATCH' && $path === '/features') $this->saveFeatureSettings($user);
        if ($method === 'GET' && preg_match('#^/sync/files/(\d+)$#', $path, $m)) $this->downloadFile($user, (int)$m[1]);
        if ($method === 'GET' && $path === '/integrations/ai/status') $this->aiReviewStatus($user);
        if ($method === 'POST' && $path === '/integrations/ai/enable') $this->enableAiReviewApi($user);
        if ($method === 'POST' && $path === '/integrations/ai/reveal') $this->revealAiReviewApiToken($user);
        if ($method === 'POST' && $path === '/integrations/ai/test') $this->testAiReviewApiToken($user);
        if ($method === 'POST' && $path === '/integrations/ai/disable') $this->disableAiReviewApi($user);
        if ($method === 'GET' && $path === '/categories') $this->categories($user);
        if ($method === 'POST' && $path === '/categories') $this->createCategory($user);
        if ($method === 'PUT' && preg_match('#^/categories/(\d+)$#', $path, $m)) $this->updateCategory($user, (int)$m[1]);
        if ($method === 'DELETE' && preg_match('#^/categories/(\d+)$#', $path, $m)) $this->deleteCategory($user, (int)$m[1]);
        if ($method === 'GET' && $path === '/asset-counts') $this->assetCounts($user);
        if ($method === 'GET' && $path === '/assets') $this->listAssets($user);
        if ($method === 'POST' && $path === '/assets') $this->saveAsset($user);
        if ($method === 'GET' && preg_match('#^/assets/(\d+)$#', $path, $m)) $this->getAsset($user, (int)$m[1]);
        if ($method === 'DELETE' && preg_match('#^/assets/(\d+)$#', $path, $m)) $this->deleteAsset($user, (int)$m[1]);
        if ($method === 'POST' && preg_match('#^/assets/(\d+)/secret$#', $path, $m)) $this->revealAssetSecret($user, (int)$m[1]);
        if ($method === 'GET' && $path === '/notes') $this->listNotes($user);
        if ($method === 'POST' && $path === '/notes') $this->saveNote($user);
        if ($method === 'GET' && preg_match('#^/notes/(\d+)$#', $path, $m)) $this->getNote($user, (int)$m[1]);
        if ($method === 'GET' && preg_match('#^/notes/(\d+)/versions/(\d+)$#', $path, $m)) $this->getNoteVersion($user, (int)$m[1], (int)$m[2]);
        if ($method === 'POST' && preg_match('#^/notes/(\d+)/versions/(\d+)/restore$#', $path, $m)) $this->restoreNoteVersion($user, (int)$m[1], (int)$m[2]);
        if ($method === 'POST' && preg_match('#^/notes/(\d+)/archive$#', $path, $m)) $this->archiveNote($user, (int)$m[1]);
        if ($method === 'POST' && preg_match('#^/notes/(\d+)/restore$#', $path, $m)) $this->restoreNote($user, (int)$m[1]);
        if ($method === 'DELETE' && preg_match('#^/notes/(\d+)/permanent$#', $path, $m)) $this->permanentlyDeleteNote($user, (int)$m[1]);
        if ($method === 'DELETE' && preg_match('#^/notes/(\d+)$#', $path, $m)) $this->deleteNote($user, (int)$m[1]);
        if ($method === 'DELETE' && $path === '/trash/notes') $this->emptyTrash($user);
        if ($method === 'GET' && $path === '/calendars') $this->listCalendars($user);
        if ($method === 'POST' && $path === '/calendars') $this->saveCalendar($user);
        if ($method === 'PATCH' && preg_match('#^/calendars/(\d+)$#', $path, $m)) $this->saveCalendar($user, (int)$m[1]);
        if ($method === 'DELETE' && preg_match('#^/calendars/(\d+)$#', $path, $m)) $this->deleteCalendar($user, (int)$m[1]);
        if ($method === 'POST' && preg_match('#^/calendars/(\d+)/share$#', $path, $m)) $this->shareCalendar($user, (int)$m[1]);
        if ($method === 'DELETE' && preg_match('#^/calendars/(\d+)/share/(\d+)$#', $path, $m)) $this->unshareCalendar($user, (int)$m[1], (int)$m[2]);
        if ($method === 'GET' && $path === '/calendar-feeds') $this->listCalendarFeeds($user);
        if ($method === 'POST' && $path === '/calendar-feeds') $this->saveCalendarFeed($user);
        if ($method === 'PATCH' && preg_match('#^/calendar-feeds/(\d+)$#', $path, $m)) $this->saveCalendarFeed($user, (int)$m[1]);
        if ($method === 'POST' && preg_match('#^/calendar-feeds/(\d+)/sync$#', $path, $m)) $this->syncCalendarFeed($user, (int)$m[1]);
        if ($method === 'DELETE' && preg_match('#^/calendar-feeds/(\d+)$#', $path, $m)) $this->deleteCalendarFeed($user, (int)$m[1]);
        if ($method === 'GET' && $path === '/events') $this->listEvents($user);
        if ($method === 'POST' && $path === '/events') $this->saveEvent($user);
        if ($method === 'GET' && preg_match('#^/events/(\d+)$#', $path, $m)) $this->getEvent($user, (int)$m[1]);
        if ($method === 'PATCH' && preg_match('#^/events/(\d+)$#', $path, $m)) $this->saveEvent($user, (int)$m[1]);
        if ($method === 'DELETE' && preg_match('#^/events/(\d+)$#', $path, $m)) $this->deleteEvent($user, (int)$m[1]);
        if ($method === 'GET' && $path === '/tasks') $this->listTasks($user);
        if ($method === 'POST' && $path === '/tasks') $this->saveTask($user);
        if ($method === 'GET' && preg_match('#^/tasks/(\d+)$#', $path, $m)) $this->getTask($user, (int)$m[1]);
        if ($method === 'PATCH' && preg_match('#^/tasks/(\d+)$#', $path, $m)) $this->saveTask($user, (int)$m[1]);
        if ($method === 'DELETE' && preg_match('#^/tasks/(\d+)$#', $path, $m)) $this->deleteTask($user, (int)$m[1]);
        if ($method === 'GET' && $path === '/reminders/due') $this->dueReminders($user);
        if ($method === 'POST' && preg_match('#^/reminders/(event|task)/(\d+)/(dismiss|snooze)$#', $path, $m)) $this->updateReminder($user, $m[1], (int)$m[2], $m[3]);
        if ($method === 'POST' && $path === '/calendar/import') $this->importCalendar($user);
        if ($method === 'GET' && preg_match('#^/calendar/export/(\d+)\.ics$#', $path, $m)) $this->exportCalendarIcs($user, (int)$m[1]);
        if ($method === 'POST' && preg_match('#^/notes/(\d+)/files$#', $path, $m)) $this->uploadFile($user, (int)$m[1]);
        if ($method === 'GET' && preg_match('#^/files/(\d+)/preview$#', $path, $m)) $this->downloadFile($user, (int)$m[1], true);
        if ($method === 'GET' && preg_match('#^/files/(\d+)$#', $path, $m)) $this->downloadFile($user, (int)$m[1]);
        if ($method === 'POST' && preg_match('#^/secrets/(\d+)/reveal$#', $path, $m)) $this->revealSecret($user, (int)$m[1]);
        if ($method === 'GET' && $path === '/clients') $this->clients($user);
        if ($method === 'POST' && $path === '/clients') $this->createClient($user);
        if ($method === 'DELETE' && preg_match('#^/clients/(\d+)$#', $path, $m)) $this->deleteClient($user, (int)$m[1]);
        if ($method === 'GET' && $path === '/users') $this->users($user);
        if ($method === 'POST' && $path === '/users') $this->createUser($user);
        if ($method === 'POST' && $path === '/2fa/start') $this->start2fa($user);
        if ($method === 'POST' && $path === '/2fa/confirm') $this->confirm2fa($user);
        if ($method === 'POST' && $path === '/2fa/recovery') $this->regenerateRecoveryCodes($user);
        if ($method === 'GET' && $path === '/webauthn/credentials') $this->listWebauthnCredentials($user);
        if ($method === 'POST' && $path === '/webauthn/register/options') $this->webauthnRegisterOptions($user);
        if ($method === 'POST' && $path === '/webauthn/register') $this->webauthnRegister($user);
        if ($method === 'DELETE' && preg_match('#^/webauthn/credentials/(\d+)$#', $path, $m)) $this->deleteWebauthnCredential($user, (int)$m[1]);
        if ($method === 'GET' && $path === '/audit') $this->audit($user);
        if ($method === 'GET' && $path === '/export') $this->export($user);
        if ($method === 'POST' && $path === '/import') $this->import($user);
        if ($method === 'GET' && $path === '/backups') $this->backups($user);
        if ($method === 'GET' && preg_match('#^/backups/([A-Za-z0-9._-]+)$#', $path, $m)) $this->downloadBackup($user, $m[1]);
        if ($method === 'POST' && $path === '/backup') $this->backup($user);
        if ($method === 'POST' && $path === '/restore') $this->restore($user);
        if ($method === 'POST' && $path === '/restore/upload') $this->restoreUpload($user);
        throw new RuntimeException('Not found');
    }

    private function bootstrap(): void
    {
        $this->json(['needsSetup' => $this->needsSetup(), 'appUrl' => Config::appUrl(), 'desktop' => Config::isDesktop()]);
    }

    private function needsSetup(): bool
    {
        return (int) $this->db->query('SELECT COUNT(*) FROM users')->fetchColumn() === 0;
    }

    private function setup(): void
    {
        $data = $this->input();
        $this->db->beginTransaction();
        try {
            if ((int) $this->db->query('SELECT COUNT(*) FROM users')->fetchColumn() > 0) {
                throw new RuntimeException('Setup already completed');
            }
            if (($data['password_confirm'] ?? $data['password'] ?? '') !== ($data['password'] ?? '')) {
                throw new RuntimeException('Passwords do not match');
            }
            $id = $this->createUserRow($data['email'] ?? '', $data['name'] ?? 'Owner', $data['password'] ?? '', 'owner');
            $this->audit(null, 'setup.complete', 'user', $id);
            $this->db->commit();
        } catch (Throwable $e) {
            $this->db->rollBack();
            throw $e;
        }
        $this->json(['ok' => true]);
    }

    private function desktopServer(array $user): void
    {
        $this->requireAdmin($user);
        if (!Config::isDesktop()) throw new RuntimeException('Desktop server settings are only available in the desktop app');
        $this->json(['server_url' => $this->desktopServerUrl(), 'config_dir' => Config::dir()]);
    }

    private function saveDesktopServer(?array $user = null): void
    {
        if (!Config::isDesktop()) throw new RuntimeException('Desktop server settings are only available in the desktop app');
        if ($user) $this->requireAdmin($user);
        if (!$user && !$this->needsSetup()) throw new RuntimeException('Sign in to update desktop server settings');
        $data = $this->input();
        $url = rtrim(trim((string)($data['server_url'] ?? '')), '/');
        if ($url === '' || !preg_match('#^https?://#i', $url)) throw new RuntimeException('Enter a server URL that starts with http:// or https://');
        if (!filter_var($url, FILTER_VALIDATE_URL)) throw new RuntimeException('Enter a valid server URL');
        $file = Config::dir() . '/desktop-server.json';
        file_put_contents($file, json_encode(['server_url' => $url], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
        $this->json(['ok' => true, 'server_url' => $url]);
    }

    private function clearDesktopServer(array $user): void
    {
        $this->requireAdmin($user);
        if (!Config::isDesktop()) throw new RuntimeException('Desktop server settings are only available in the desktop app');
        $file = Config::dir() . '/desktop-server.json';
        if (is_file($file) && !unlink($file)) throw new RuntimeException('Could not clear desktop server settings');
        $this->json(['ok' => true, 'server_url' => '']);
    }

    private function desktopServerUrl(): string
    {
        $file = Config::dir() . '/desktop-server.json';
        if (!is_file($file)) return '';
        $data = json_decode((string)file_get_contents($file), true) ?: [];
        return is_string($data['server_url'] ?? null) ? (string)$data['server_url'] : '';
    }

    private function setupRestoreUpload(): void
    {
        if (empty($_FILES['backup'])) throw new RuntimeException('No backup uploaded');
        $file = $_FILES['backup'];
        if (($file['error'] ?? UPLOAD_ERR_OK) !== UPLOAD_ERR_OK) throw new RuntimeException('Upload failed');
        if (($file['size'] ?? 0) <= 0 || (int)$file['size'] > 200 * 1024 * 1024) throw new RuntimeException('Invalid backup size');
        $passphrase = (string)($_POST['passphrase'] ?? '');
        $this->validateBackupZip($file['tmp_name'], $passphrase);
        $this->applyBackupZip($file['tmp_name'], $passphrase);
        $this->json(['ok' => true, 'message' => 'Backup restored. Reload DiVault and sign in with the restored owner account.']);
    }

    private function login(): void
    {
        $data = $this->input();
        $this->checkRateLimit('login:' . $this->ip(), 8, 900);
        $stmt = $this->db->prepare('SELECT * FROM users WHERE email = ? AND disabled = 0');
        $stmt->execute([strtolower(trim($data['email'] ?? ''))]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$user || !password_verify($data['password'] ?? '', $user['password_hash'])) {
            $this->hitRateLimit('login:' . $this->ip(), 900);
            $this->audit(null, 'login.failed', 'user', null);
            throw new RuntimeException('Invalid login');
        }
        if ((int)$user['totp_enabled'] === 1) {
            $secret = $this->crypto->decrypt($user['totp_secret']);
            $recoveryOk = !empty($data['recovery_code']) && $this->consumeRecoveryCode((int)$user['id'], $data['recovery_code']);
            if (!$recoveryOk && !Totp::verify($secret, $data['totp'] ?? '')) {
                $this->hitRateLimit('login:' . $this->ip(), 900);
                $this->audit((int)$user['id'], 'login.2fa_failed', 'user', (int)$user['id']);
                throw new RuntimeException('Two-factor code required');
            }
        }
        $this->createSession($user);
        $this->audit((int)$user['id'], 'login.success', 'user', (int)$user['id']);
        $this->json(['user' => $this->publicUser($user)]);
    }

    private function loginCheck(): void
    {
        $data = $this->input();
        $this->checkRateLimit('login:' . $this->ip(), 8, 900);
        $stmt = $this->db->prepare('SELECT * FROM users WHERE email = ? AND disabled = 0');
        $stmt->execute([strtolower(trim($data['email'] ?? ''))]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$user || !password_verify($data['password'] ?? '', $user['password_hash'])) {
            $this->hitRateLimit('login:' . $this->ip(), 900);
            $this->audit(null, 'login.failed', 'user', null);
            throw new RuntimeException('Invalid login');
        }
        $this->json(['mfa_required' => (int)$user['totp_enabled'] === 1]);
    }

    private function webauthnLoginOptions(): void
    {
        $data = $this->input();
        $email = strtolower(trim((string)($data['email'] ?? '')));
        $this->checkRateLimit('login:' . $this->ip(), 8, 900);
        $stmt = $this->db->prepare('SELECT * FROM users WHERE email = ? AND disabled = 0');
        $stmt->execute([$email]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$user) {
            $this->hitRateLimit('login:' . $this->ip(), 900);
            throw new RuntimeException('Passkey not found');
        }
        $credentials = $this->webauthnCredentials((int)$user['id']);
        if (!$credentials) throw new RuntimeException('No passkey is enrolled for this account');
        $challenge = $this->base64UrlEncode(random_bytes(32));
        $this->saveWebauthnChallenge('login', (int)$user['id'], $challenge);
        $this->json([
            'challenge' => $challenge,
            'timeout' => 60000,
            'userVerification' => 'required',
            'allowCredentials' => array_map(fn($row) => ['type' => 'public-key', 'id' => $row['credential_id']], $credentials),
        ]);
    }

    private function webauthnLogin(): void
    {
        $data = $this->input();
        $email = strtolower(trim((string)($data['email'] ?? '')));
        $credentialId = (string)($data['id'] ?? '');
        $this->checkRateLimit('login:' . $this->ip(), 8, 900);
        $stmt = $this->db->prepare('SELECT u.*, c.public_key, c.id AS credential_row_id FROM webauthn_credentials c JOIN users u ON u.id = c.user_id WHERE u.email = ? AND c.credential_id = ? AND u.disabled = 0');
        $stmt->execute([$email, $credentialId]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$user) {
            $this->hitRateLimit('login:' . $this->ip(), 900);
            $this->audit(null, 'login.passkey_failed', 'user', null);
            throw new RuntimeException('Passkey verification failed');
        }
        $challenge = $this->webauthnChallenge('login', (int)$user['id']);
        $this->deleteSetting($this->webauthnChallengeKey('login', (int)$user['id']));
        $this->verifyWebauthnAssertion($data, $challenge, (string)$user['public_key']);
        $this->db->prepare('UPDATE webauthn_credentials SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([(int)$user['credential_row_id']]);
        $this->createSession($user);
        $this->audit((int)$user['id'], 'login.passkey_success', 'user', (int)$user['id']);
        $this->json(['user' => $this->publicUser($user)]);
    }

    private function logout(): void
    {
        $this->requireUser();
        $this->requireCsrf();
        $token = $_COOKIE['divault_session'] ?? $_COOKIE['qv_session'] ?? '';
        if ($token) {
            $stmt = $this->db->prepare('DELETE FROM sessions WHERE token_hash = ?');
            $stmt->execute([hash('sha256', $token)]);
        }
        setcookie('divault_session', '', $this->cookieOptions(time() - 3600));
        setcookie('qv_session', '', $this->cookieOptions(time() - 3600));
        setcookie('divault_csrf', '', ['expires' => time() - 3600, 'path' => '/', 'secure' => Config::secureCookies(), 'httponly' => false, 'samesite' => 'Lax']);
        setcookie('qv_csrf', '', ['expires' => time() - 3600, 'path' => '/', 'secure' => Config::secureCookies(), 'httponly' => false, 'samesite' => 'Lax']);
        $this->json(['ok' => true]);
    }

    private function sessions(array $user): void
    {
        $stmt = $this->db->prepare('SELECT id, user_agent, ip, created_at, expires_at FROM sessions WHERE user_id = ? ORDER BY id DESC');
        $stmt->execute([(int)$user['id']]);
        $this->json(['sessions' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
    }

    private function revokeSession(array $user, int $id): void
    {
        $stmt = $this->db->prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, (int)$user['id']]);
        $this->audit((int)$user['id'], 'session.revoked', 'session', $id);
        $this->json(['ok' => true]);
    }

    private function syncManifest(array $user): void
    {
        $watermark = (int)$this->db->query('SELECT COALESCE(MAX(id), 0) FROM sync_events')->fetchColumn();
        $this->json([
            'server_time' => gmdate('c'),
            'watermark' => $watermark,
            'user' => $this->publicUser($user),
            'capabilities' => [
                'server_authoritative',
                'snapshot_pull',
                'incremental_events',
                'soft_delete_notes',
                'file_metadata_pull',
                'file_content_download',
                'note_mutation_push',
                'idempotent_mutations',
                'conflict_detection',
            ],
            'entities' => ['notes', 'clients', 'categories', 'assets', 'files'],
        ]);
    }

    private function syncPull(array $user): void
    {
        $since = max(0, (int)($_GET['since_event_id'] ?? $_GET['since'] ?? 0));
        $limit = min(500, max(1, (int)($_GET['limit'] ?? 200)));
        $snapshot = $since === 0 ? $this->syncSnapshot($user) : null;
        $stmt = $this->db->prepare('SELECT * FROM sync_events WHERE id > ? AND (user_id = ? OR user_id IS NULL) ORDER BY id ASC LIMIT ?');
        $stmt->bindValue(1, $since, PDO::PARAM_INT);
        $stmt->bindValue(2, (int)$user['id'], PDO::PARAM_INT);
        $stmt->bindValue(3, $limit + 1, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $hasMore = count($rows) > $limit;
        $rows = array_slice($rows, 0, $limit);
        $events = [];
        foreach ($rows as $event) {
            $payload = $this->syncEventPayload($event, $user);
            if ($payload) $events[] = $payload;
        }
        $watermark = (int)$this->db->query('SELECT COALESCE(MAX(id), 0) FROM sync_events')->fetchColumn();
        $nextSince = $events ? (int)end($events)['id'] : $since;
        $this->json([
            'server_time' => gmdate('c'),
            'since_event_id' => $since,
            'next_since_event_id' => $nextSince,
            'watermark' => $watermark,
            'has_more' => $hasMore,
            'snapshot' => $snapshot,
            'events' => $events,
        ]);
    }

    private function syncPush(array $user): void
    {
        $this->requireEditor($user);
        $data = $this->input();
        $clientId = $this->cleanSyncClientId($data['client_id'] ?? '');
        $mutations = $data['mutations'] ?? [];
        if ($clientId === '') throw new RuntimeException('Sync client_id required');
        if (!is_array($mutations) || count($mutations) > 100) throw new RuntimeException('Sync mutations must be an array of up to 100 items');

        $results = [];
        foreach ($mutations as $mutation) {
            if (!is_array($mutation)) throw new RuntimeException('Invalid sync mutation');
            $results[] = $this->applySyncMutation($user, $clientId, $mutation);
        }
        $watermark = (int)$this->db->query('SELECT COALESCE(MAX(id), 0) FROM sync_events')->fetchColumn();
        $this->json(['ok' => true, 'watermark' => $watermark, 'results' => $results]);
    }

    private function applySyncMutation(array $user, string $clientId, array $mutation): array
    {
        $mutationId = $this->cleanSyncMutationId($mutation['mutation_id'] ?? '');
        if ($mutationId === '') throw new RuntimeException('Sync mutation_id required');

        $existing = $this->db->prepare('SELECT result_json FROM sync_applied_mutations WHERE client_id = ? AND mutation_id = ?');
        $existing->execute([$clientId, $mutationId]);
        $resultJson = $existing->fetchColumn();
        if ($resultJson) {
            $result = json_decode((string)$resultJson, true) ?: [];
            $result['duplicate'] = true;
            return $result;
        }

        $type = $mutation['entity_type'] ?? '';
        if ($type !== 'note') throw new RuntimeException('Only note sync push is supported in this phase');
        $result = $this->applyNoteSyncMutation($user, $mutation);
        $this->db->prepare('INSERT INTO sync_applied_mutations (client_id, mutation_id, user_id, result_json) VALUES (?, ?, ?, ?)')->execute([$clientId, $mutationId, (int)$user['id'], json_encode($result)]);
        return $result;
    }

    private function applyNoteSyncMutation(array $user, array $mutation): array
    {
        $action = $mutation['action'] ?? 'upsert';
        $record = is_array($mutation['record'] ?? null) ? $mutation['record'] : [];
        $id = isset($record['id']) ? (int)$record['id'] : (int)($mutation['entity_id'] ?? 0);
        $baseUpdatedAt = trim((string)($mutation['base_updated_at'] ?? ''));

        $this->db->beginTransaction();
        try {
            $current = $id > 0 ? $this->noteOrNull($id) : null;
            if ($current && $baseUpdatedAt !== '' && (string)$current['updated_at'] !== $baseUpdatedAt) {
                $this->db->rollBack();
                return ['status' => 'conflict', 'entity_type' => 'note', 'entity_id' => $id, 'server' => $current];
            }

            if ($action === 'delete') {
                if (!$current) throw new RuntimeException('Note not found');
                $this->db->prepare('UPDATE notes SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([$id]);
                $this->audit((int)$user['id'], 'note.deleted', 'note', $id);
            } elseif ($action === 'archive') {
                if (!$current) throw new RuntimeException('Note not found');
                $this->db->prepare('UPDATE notes SET archived = 1, deleted = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([$id]);
                $this->audit((int)$user['id'], 'note.archived', 'note', $id);
            } elseif ($action === 'restore') {
                if (!$current) throw new RuntimeException('Note not found');
                $this->db->prepare('UPDATE notes SET archived = 0, deleted = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([$id]);
                $this->audit((int)$user['id'], 'note.restored', 'note', $id);
            } elseif ($action === 'upsert') {
                $id = $this->upsertNoteFromSync($user, $record, $current);
            } else {
                throw new RuntimeException('Unsupported note sync action');
            }

            $fresh = $this->noteOrNull($id);
            $this->db->commit();
            return ['status' => 'applied', 'entity_type' => 'note', 'entity_id' => $id, 'record' => $fresh];
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            throw $e;
        }
    }

    private function upsertNoteFromSync(array $user, array $record, ?array $current): int
    {
        $id = $current ? (int)$current['id'] : 0;
        $parsed = $this->extractSecrets($record['body'] ?? '', $id);
        $clientId = !empty($record['client_id']) ? (int)$record['client_id'] : null;
        $categoryId = !empty($record['category_id']) ? (int)$record['category_id'] : null;
        if ($categoryId) $this->category($categoryId);
        $fields = [
            'title' => trim($record['title'] ?? '') ?: 'Quick note',
            'body' => $parsed['body'],
            'type' => trim($record['type'] ?? 'text') ?: 'text',
            'section' => trim($record['section'] ?? 'All') ?: 'All',
            'category_id' => $categoryId,
            'category' => $record['category'] ?? null,
            'tags' => $record['tags'] ?? null,
            'client_id' => $clientId,
            'pinned' => !empty($record['pinned']) ? 1 : 0,
            'archived' => !empty($record['archived']) ? 1 : 0,
            'deleted' => !empty($record['deleted']) ? 1 : 0,
        ];

        if ($current) {
            $this->db->prepare('INSERT INTO note_versions (note_id, user_id, title, body) VALUES (?, ?, ?, ?)')->execute([$id, (int)$user['id'], $current['title'], $current['body']]);
            $this->pruneNoteVersions($id);
            $stmt = $this->db->prepare('UPDATE notes SET title=?, body=?, type=?, section=?, category_id=?, category=?, tags=?, client_id=?, pinned=?, archived=?, deleted=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
            $stmt->execute([$fields['title'], $fields['body'], $fields['type'], $fields['section'], $fields['category_id'], $fields['category'], $fields['tags'], $fields['client_id'], $fields['pinned'], $fields['archived'], $fields['deleted'], $id]);
            $this->db->prepare('DELETE FROM note_secrets WHERE note_id = ?')->execute([$id]);
            $this->audit((int)$user['id'], 'note.updated', 'note', $id);
        } else {
            $stmt = $this->db->prepare('INSERT INTO notes (user_id, client_id, title, body, type, section, category_id, category, tags, pinned, archived, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            $stmt->execute([(int)$user['id'], $fields['client_id'], $fields['title'], $fields['body'], $fields['type'], $fields['section'], $fields['category_id'], $fields['category'], $fields['tags'], $fields['pinned'], $fields['archived'], $fields['deleted']]);
            $id = (int)$this->db->lastInsertId();
            $this->audit((int)$user['id'], 'note.created', 'note', $id);
        }

        foreach ($parsed['secrets'] as $secret) {
            $ciphertext = $secret['ciphertext'] ?? $this->crypto->encrypt($secret['value']);
            $this->db->prepare('INSERT INTO note_secrets (note_id, label, ciphertext) VALUES (?, ?, ?)')->execute([$id, $secret['label'], $ciphertext]);
        }
        return $id;
    }

    private function syncSnapshot(array $user): array
    {
        $userId = (int)$user['id'];
        $notes = $this->db->prepare('SELECT * FROM notes WHERE user_id = ? ORDER BY id');
        $notes->execute([$userId]);
        $assets = $this->db->prepare('SELECT id, user_id, client_id, type, name, status, asset_type, os, primary_ip, serial_number, expires_at, location, contact, username, notes, data_json, archived, created_at, updated_at FROM asset_records WHERE user_id = ? ORDER BY id');
        $assets->execute([$userId]);
        $files = $this->db->prepare('SELECT id, note_id, user_id, original_name, mime, size, created_at FROM files WHERE user_id = ? ORDER BY id');
        $files->execute([$userId]);
        return [
            'categories' => $this->db->query('SELECT id, parent_id, name, icon, slug, created_at FROM asset_categories ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'clients' => $this->db->query('SELECT * FROM clients ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'notes' => $notes->fetchAll(PDO::FETCH_ASSOC),
            'assets' => $assets->fetchAll(PDO::FETCH_ASSOC),
            'files' => array_map(fn ($row) => $this->syncFilePayload($row), $files->fetchAll(PDO::FETCH_ASSOC)),
        ];
    }

    private function syncEventPayload(array $event, array $user): ?array
    {
        $type = (string)$event['entity_type'];
        if (in_array($type, ['calendar', 'event', 'task'], true)) return null;
        $id = isset($event['entity_id']) ? (int)$event['entity_id'] : null;
        $row = $id ? $this->syncEntityRow($type, $id, $user) : null;
        return [
            'id' => (int)$event['id'],
            'entity_type' => $type,
            'entity_id' => $id,
            'action' => $event['action'],
            'created_at' => $event['created_at'],
            'deleted' => $row === null && $id !== null,
            'record' => $row,
        ];
    }

    private function syncEntityRow(string $type, int $id, array $user): ?array
    {
        if (in_array($type, ['calendar', 'event', 'task'], true)) return null;
        $queries = [
            'note' => 'SELECT * FROM notes WHERE id = ? AND user_id = ?',
            'category' => 'SELECT id, parent_id, name, icon, slug, created_at FROM asset_categories WHERE id = ?',
            'asset' => 'SELECT id, user_id, client_id, type, name, status, asset_type, os, primary_ip, serial_number, expires_at, location, contact, username, notes, data_json, archived, created_at, updated_at FROM asset_records WHERE id = ? AND user_id = ?',
            'client' => 'SELECT * FROM clients WHERE id = ?',
            'file' => 'SELECT id, note_id, user_id, original_name, mime, size, created_at FROM files WHERE id = ? AND user_id = ?',
        ];
        if (empty($queries[$type])) return null;
        $stmt = $this->db->prepare($queries[$type]);
        $args = in_array($type, ['note', 'asset', 'file'], true) ? [$id, (int)$user['id']] : [$id];
        $stmt->execute($args);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) return null;
        return $type === 'file' ? $this->syncFilePayload($row) : $row;
    }

    private function syncFilePayload(array $row): array
    {
        $id = (int)$row['id'];
        $row['download_url'] = '/api/sync/files/' . $id;
        $row['preview_url'] = '/api/files/' . $id . '/preview';
        return $row;
    }

    private function listNotes(array $user): void
    {
        $q = trim($_GET['q'] ?? '');
        $view = trim($_GET['view'] ?? 'all');
        $categoryId = isset($_GET['category_id']) && $_GET['category_id'] !== '' ? (int)$_GET['category_id'] : null;
        $where = [];
        $args = [];
        if ($view === 'trash') {
            $where[] = 'n.deleted = 1';
        } else {
            $where[] = 'n.deleted = 0';
            if ($view === 'archive') {
                $where[] = 'n.archived = 1';
            } else {
                $where[] = 'n.archived = 0';
            }
            if ($categoryId) {
                $where[] = 'n.category_id = ?';
                $args[] = $categoryId;
            } elseif ($view === 'quick') {
                $where[] = 'n.category_id IS NULL';
            }
        }
        if ($q !== '') { $where[] = '(n.title LIKE ? OR n.body LIKE ? OR n.tags LIKE ?)'; array_push($args, "%$q%", "%$q%", "%$q%"); }
        if (!empty($_GET['has_file'])) $where[] = 'EXISTS (SELECT 1 FROM files f WHERE f.note_id = n.id)';
        if (!empty($_GET['has_secret'])) $where[] = 'EXISTS (SELECT 1 FROM note_secrets s WHERE s.note_id = n.id)';
        if (!empty($_GET['has_code'])) $where[] = "n.body LIKE '%```%'";
        $sort = $_GET['sort'] ?? 'updated_desc';
        $order = match ($sort) {
            'updated_asc' => 'n.pinned DESC, n.updated_at ASC, n.id ASC',
            'created_desc' => 'n.pinned DESC, n.created_at DESC, n.id DESC',
            'created_asc' => 'n.pinned DESC, n.created_at ASC, n.id ASC',
            'title_asc' => 'n.pinned DESC, lower(n.title) ASC, n.updated_at DESC',
            'title_desc' => 'n.pinned DESC, lower(n.title) DESC, n.updated_at DESC',
            default => 'n.pinned DESC, n.updated_at DESC, n.id DESC',
        };
        $sql = 'SELECT n.*, ac.name AS category_name, ac.slug AS category_slug, c.name AS client_name, (SELECT COUNT(*) FROM files f WHERE f.note_id = n.id) AS file_count, (SELECT COUNT(*) FROM note_secrets s WHERE s.note_id = n.id) AS secret_count FROM notes n LEFT JOIN asset_categories ac ON ac.id = n.category_id LEFT JOIN clients c ON c.id = n.client_id WHERE ' . implode(' AND ', $where) . ' ORDER BY ' . $order . ' LIMIT 200';
        $stmt = $this->db->prepare($sql);
        $stmt->execute($args);
        $this->json(['notes' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
    }

    private function assetCounts(array $user): void
    {
        $counts = [];
        $stmt = $this->db->query('SELECT type, COUNT(*) AS count FROM asset_records WHERE archived = 0 GROUP BY type');
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $counts[$row['type']] = (int)$row['count'];
        }
        $counts['notes:all'] = (int)$this->db->query('SELECT COUNT(*) FROM notes WHERE deleted = 0 AND archived = 0')->fetchColumn();
        $counts['notes:quick'] = (int)$this->db->query('SELECT COUNT(*) FROM notes WHERE deleted = 0 AND archived = 0 AND category_id IS NULL')->fetchColumn();
        $counts['notes:archive'] = (int)$this->db->query('SELECT COUNT(*) FROM notes WHERE deleted = 0 AND archived = 1')->fetchColumn();
        $counts['notes:trash'] = (int)$this->db->query('SELECT COUNT(*) FROM notes WHERE deleted = 1')->fetchColumn();
        $noteCounts = $this->db->query('SELECT category_id, COUNT(*) AS count FROM notes WHERE deleted = 0 AND archived = 0 AND category_id IS NOT NULL GROUP BY category_id')->fetchAll(PDO::FETCH_ASSOC);
        foreach ($noteCounts as $row) {
            $counts['notes:cat:' . $row['category_id']] = (int)$row['count'];
        }
        $this->json(['counts' => $counts]);
    }

    private function categories(array $user): void
    {
        $rows = $this->db->query('SELECT id, parent_id, name, icon, slug, created_at FROM asset_categories ORDER BY parent_id IS NOT NULL, name')->fetchAll(PDO::FETCH_ASSOC);
        $this->json(['categories' => $rows]);
    }

    private function createCategory(array $user): void
    {
        $this->requireEditor($user);
        $data = $this->input();
        $name = trim($data['name'] ?? '');
        $icon = $this->cleanCategoryIcon($data['icon'] ?? '');
        $parentId = !empty($data['parent_id']) ? (int)$data['parent_id'] : null;
        if ($name === '') throw new RuntimeException('Category name required');
        if ($parentId) $this->category($parentId);
        $slug = $this->slugify($name);
        $stmt = $this->db->prepare('INSERT INTO asset_categories (parent_id, name, icon, slug) VALUES (?, ?, ?, ?)');
        $stmt->execute([$parentId, $name, $icon, $slug]);
        $id = (int)$this->db->lastInsertId();
        $this->audit((int)$user['id'], 'category.created', 'category', $id);
        $this->json(['id' => $id, 'slug' => $slug]);
    }

    private function updateCategory(array $user, int $id): void
    {
        $this->requireEditor($user);
        $category = $this->category($id);
        $data = $this->input();
        $name = trim($data['name'] ?? $category['name']);
        $icon = $this->cleanCategoryIcon($data['icon'] ?? ($category['icon'] ?? ''));
        if ($name === '') throw new RuntimeException('Category name required');
        $this->db->prepare('UPDATE asset_categories SET name = ?, icon = ? WHERE id = ?')->execute([$name, $icon, $id]);
        $this->audit((int)$user['id'], 'category.updated', 'category', $id);
        $this->json(['ok' => true]);
    }

    private function deleteCategory(array $user, int $id): void
    {
        $this->requireEditor($user);
        $category = $this->category($id);
        $slug = $category['slug'];
        $this->db->prepare('UPDATE asset_records SET archived = 1 WHERE type = ?')->execute([$slug]);
        $this->db->prepare('UPDATE notes SET category_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE category_id = ?')->execute([$id]);
        $this->db->prepare('UPDATE asset_categories SET parent_id = NULL WHERE parent_id = ?')->execute([$id]);
        $this->db->prepare('DELETE FROM asset_categories WHERE id = ?')->execute([$id]);
        $this->audit((int)$user['id'], 'category.deleted', 'category', $id);
        $this->json(['ok' => true]);
    }

    private function listAssets(array $user): void
    {
        $type = trim($_GET['type'] ?? 'configurations');
        $q = trim($_GET['q'] ?? '');
        $clientId = isset($_GET['client_id']) && $_GET['client_id'] !== '' ? (int)$_GET['client_id'] : null;
        $includeArchive = !empty($_GET['include_archive']);
        $where = ['a.type = ?'];
        $args = [$type];
        if ($clientId) {
            $where[] = 'a.client_id = ?';
            $args[] = $clientId;
        }
        if (!$includeArchive) $where[] = 'a.archived = 0';
        if ($q !== '') {
            $where[] = '(a.name LIKE ? OR a.status LIKE ? OR a.asset_type LIKE ? OR a.primary_ip LIKE ? OR a.serial_number LIKE ? OR a.location LIKE ? OR a.contact LIKE ? OR a.username LIKE ? OR a.notes LIKE ?)';
            array_push($args, ...array_fill(0, 9, "%$q%"));
        }
        $sql = 'SELECT a.id, a.client_id, c.name AS client_name, a.type, a.name, a.status, a.asset_type, a.os, a.primary_ip, a.serial_number, a.expires_at, a.location, a.contact, a.username, a.notes, a.archived, a.created_at, a.updated_at FROM asset_records a LEFT JOIN clients c ON c.id = a.client_id WHERE ' . implode(' AND ', $where) . ' ORDER BY a.updated_at DESC, a.name LIMIT 500';
        $stmt = $this->db->prepare($sql);
        $stmt->execute($args);
        $this->json(['assets' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
    }

    private function getAsset(array $user, int $id): void
    {
        $stmt = $this->db->prepare('SELECT a.id, a.client_id, c.name AS client_name, a.type, a.name, a.status, a.asset_type, a.os, a.primary_ip, a.serial_number, a.expires_at, a.location, a.contact, a.username, a.notes, a.data_json, a.archived, a.created_at, a.updated_at, CASE WHEN a.secret_ciphertext IS NULL THEN 0 ELSE 1 END AS has_secret FROM asset_records a LEFT JOIN clients c ON c.id = a.client_id WHERE a.id = ?');
        $stmt->execute([$id]);
        $asset = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$asset) throw new RuntimeException('Asset not found');
        $asset['data'] = $asset['data_json'] ? json_decode($asset['data_json'], true) : [];
        unset($asset['data_json']);
        $this->json(['asset' => $asset]);
    }

    private function saveAsset(array $user): void
    {
        $this->requireEditor($user);
        $data = $this->input();
        $id = isset($data['id']) ? (int)$data['id'] : 0;
        $type = $this->cleanAssetType($data['type'] ?? 'configurations');
        $secretCipher = null;
        if (!empty($data['password'])) {
            $secretCipher = $this->crypto->encrypt((string)$data['password']);
        } elseif ($id > 0 && empty($data['clear_password'])) {
            $stmt = $this->db->prepare('SELECT secret_ciphertext FROM asset_records WHERE id = ?');
            $stmt->execute([$id]);
            $secretCipher = $stmt->fetchColumn() ?: null;
        }
        $fields = [
            'client_id' => !empty($data['client_id']) ? (int)$data['client_id'] : null,
            'name' => trim($data['name'] ?? '') ?: 'Untitled',
            'status' => trim($data['status'] ?? 'Active') ?: 'Active',
            'asset_type' => trim($data['asset_type'] ?? '') ?: null,
            'os' => trim($data['os'] ?? '') ?: null,
            'primary_ip' => trim($data['primary_ip'] ?? '') ?: null,
            'serial_number' => trim($data['serial_number'] ?? '') ?: null,
            'expires_at' => trim($data['expires_at'] ?? '') ?: null,
            'location' => trim($data['location'] ?? '') ?: null,
            'contact' => trim($data['contact'] ?? '') ?: null,
            'username' => trim($data['username'] ?? '') ?: null,
            'notes' => trim($data['notes'] ?? '') ?: null,
            'data_json' => json_encode($data['data'] ?? []),
            'archived' => !empty($data['archived']) ? 1 : 0,
        ];
        if ($id > 0) {
            $stmt = $this->db->prepare('UPDATE asset_records SET client_id=?, type=?, name=?, status=?, asset_type=?, os=?, primary_ip=?, serial_number=?, expires_at=?, location=?, contact=?, username=?, secret_ciphertext=?, notes=?, data_json=?, archived=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
            $stmt->execute([$fields['client_id'], $type, $fields['name'], $fields['status'], $fields['asset_type'], $fields['os'], $fields['primary_ip'], $fields['serial_number'], $fields['expires_at'], $fields['location'], $fields['contact'], $fields['username'], $secretCipher, $fields['notes'], $fields['data_json'], $fields['archived'], $id]);
            $this->audit((int)$user['id'], 'asset.updated', 'asset', $id);
        } else {
            $stmt = $this->db->prepare('INSERT INTO asset_records (user_id, client_id, type, name, status, asset_type, os, primary_ip, serial_number, expires_at, location, contact, username, secret_ciphertext, notes, data_json, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            $stmt->execute([(int)$user['id'], $fields['client_id'], $type, $fields['name'], $fields['status'], $fields['asset_type'], $fields['os'], $fields['primary_ip'], $fields['serial_number'], $fields['expires_at'], $fields['location'], $fields['contact'], $fields['username'], $secretCipher, $fields['notes'], $fields['data_json'], $fields['archived']]);
            $id = (int)$this->db->lastInsertId();
            $this->audit((int)$user['id'], 'asset.created', 'asset', $id);
        }
        $this->json(['id' => $id]);
    }

    private function deleteAsset(array $user, int $id): void
    {
        $this->requireEditor($user);
        $this->db->prepare('UPDATE asset_records SET archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([$id]);
        $this->audit((int)$user['id'], 'asset.archived', 'asset', $id);
        $this->json(['ok' => true]);
    }

    private function revealAssetSecret(array $user, int $id): void
    {
        $this->requireEditor($user);
        $stmt = $this->db->prepare('SELECT secret_ciphertext FROM asset_records WHERE id = ?');
        $stmt->execute([$id]);
        $cipher = $stmt->fetchColumn();
        if (!$cipher) throw new RuntimeException('No secret stored');
        $this->audit((int)$user['id'], 'asset.secret_revealed', 'asset', $id);
        $this->json(['value' => $this->crypto->decrypt($cipher)]);
    }

    private function getNote(array $user, int $id): void
    {
        $note = $this->note($id);
        $files = $this->db->prepare('SELECT id, original_name, mime, size, created_at FROM files WHERE note_id = ? ORDER BY id DESC');
        $files->execute([$id]);
        $secrets = $this->db->prepare('SELECT id, label, created_at FROM note_secrets WHERE note_id = ? ORDER BY id');
        $secrets->execute([$id]);
        $versions = $this->db->prepare('SELECT id, title, created_at FROM note_versions WHERE note_id = ? ORDER BY id DESC LIMIT 20');
        $versions->execute([$id]);
        $this->json(['note' => $note, 'files' => $files->fetchAll(PDO::FETCH_ASSOC), 'secrets' => $secrets->fetchAll(PDO::FETCH_ASSOC), 'versions' => $versions->fetchAll(PDO::FETCH_ASSOC)]);
    }

    private function saveNote(array $user): void
    {
        $this->requireEditor($user);
        $data = $this->input();
        $id = isset($data['id']) ? (int)$data['id'] : 0;
        $parsed = $this->extractSecrets($data['body'] ?? '', $id);
        $clientId = !empty($data['client_id']) ? (int)$data['client_id'] : null;
        $title = trim($data['title'] ?? '') ?: 'Quick note';
        $type = $data['type'] ?? 'text';
        $section = $data['section'] ?? 'All';
        $categoryId = !empty($data['category_id']) ? (int)$data['category_id'] : null;
        if ($categoryId) $this->category($categoryId);
        $category = $data['category'] ?? null;
        $tags = $data['tags'] ?? null;
        $pinned = !empty($data['pinned']) ? 1 : 0;
        $archived = !empty($data['archived']) ? 1 : 0;
        $this->db->beginTransaction();
        try {
            if ($id > 0) {
                $old = $this->note($id);
                $this->db->prepare('INSERT INTO note_versions (note_id, user_id, title, body) VALUES (?, ?, ?, ?)')->execute([$id, (int)$user['id'], $old['title'], $old['body']]);
                $this->pruneNoteVersions($id);
                $stmt = $this->db->prepare('UPDATE notes SET title=?, body=?, type=?, section=?, category_id=?, category=?, tags=?, client_id=?, pinned=?, archived=?, deleted=0, updated_at=CURRENT_TIMESTAMP WHERE id=?');
                $stmt->execute([$title, $parsed['body'], $type, $section, $categoryId, $category, $tags, $clientId, $pinned, $archived, $id]);
                $this->db->prepare('DELETE FROM note_secrets WHERE note_id = ?')->execute([$id]);
                $this->audit((int)$user['id'], 'note.updated', 'note', $id);
            } else {
                $stmt = $this->db->prepare('INSERT INTO notes (user_id, client_id, title, body, type, section, category_id, category, tags, pinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
                $stmt->execute([(int)$user['id'], $clientId, $title, $parsed['body'], $type, $section, $categoryId, $category, $tags, $pinned]);
                $id = (int)$this->db->lastInsertId();
                $this->audit((int)$user['id'], 'note.created', 'note', $id);
            }
            foreach ($parsed['secrets'] as $secret) {
                $ciphertext = $secret['ciphertext'] ?? $this->crypto->encrypt($secret['value']);
                $this->db->prepare('INSERT INTO note_secrets (note_id, label, ciphertext) VALUES (?, ?, ?)')->execute([$id, $secret['label'], $ciphertext]);
            }
            $this->db->commit();
        } catch (Throwable $e) {
            $this->db->rollBack();
            throw $e;
        }
        $this->json(['id' => $id]);
    }

    private function createAiReviewNote(): void
    {
        $user = $this->requireAiReviewUser();
        $this->requireEditor($user);
        $data = $this->input();
        $review = $data['review'] ?? $data;
        if (!is_array($review)) throw new RuntimeException('Review payload required');

        $summary = trim((string)($review['summary'] ?? $review['title'] ?? 'AI review note')) ?: 'AI review note';
        $source = trim((string)($review['source'] ?? $data['source'] ?? 'AI')) ?: 'AI';
        $severity = trim((string)($review['severity'] ?? 'info')) ?: 'info';
        $body = trim((string)($review['body'] ?? $review['notes'] ?? $review['content'] ?? ''));
        $findings = $review['findings'] ?? [];
        if (!is_array($findings)) $findings = [];
        if ($body === '' && count($findings) === 0) throw new RuntimeException('Review body or findings required');

        $lines = [
            'Source: ' . $source,
            'Severity: ' . $severity,
            'Created: ' . gmdate('c'),
            '',
        ];
        if ($body !== '') {
            $lines[] = $body;
            $lines[] = '';
        }
        if (count($findings) > 0) {
            $lines[] = 'Findings:';
            foreach ($findings as $finding) {
                if (is_array($finding)) {
                    $text = trim((string)($finding['message'] ?? $finding['summary'] ?? $finding['title'] ?? ''));
                    $location = trim((string)($finding['location'] ?? $finding['file'] ?? ''));
                    $lines[] = '- ' . ($location !== '' ? $location . ': ' : '') . ($text !== '' ? $text : json_encode($finding));
                } else {
                    $lines[] = '- ' . trim((string)$finding);
                }
            }
        }

        $tags = trim((string)($review['tags'] ?? $data['tags'] ?? ''));
        $tagParts = array_filter(array_map('trim', explode(',', $tags)));
        foreach (['ai-review', strtolower(preg_replace('/[^a-z0-9]+/i', '-', $source)) ?: 'ai'] as $tag) {
            if (!in_array($tag, $tagParts, true)) $tagParts[] = $tag;
        }

        $clientId = !empty($review['client_id']) ? (int)$review['client_id'] : (!empty($data['client_id']) ? (int)$data['client_id'] : null);
        $title = '[AI Review] ' . substr($summary, 0, 180);
        $stmt = $this->db->prepare('INSERT INTO notes (user_id, client_id, title, body, type, section, tags) VALUES (?, ?, ?, ?, ?, ?, ?)');
        $stmt->execute([(int)$user['id'], $clientId, $title, trim(implode("\n", $lines)), 'review', 'All', implode(', ', $tagParts)]);
        $id = (int)$this->db->lastInsertId();
        $this->audit((int)$user['id'], 'integration.ai_review_note_created', 'note', $id);
        $this->json(['ok' => true, 'id' => $id, 'note' => $this->note($id)]);
    }

    private function aiReviewStatus(array $user): void
    {
        $this->requireAdmin($user);
        $envToken = Config::aiReviewApiToken();
        $fileToken = $this->aiReviewFileToken();
        $enabled = $envToken !== '' || $fileToken !== '';
        $this->json([
            'enabled' => $enabled,
            'source' => $envToken !== '' ? 'environment' : ($fileToken !== '' ? 'local' : 'disabled'),
            'can_disable' => $envToken === '',
            'can_reveal' => $envToken === '' && $fileToken !== '',
            'endpoint' => $this->origin() . '/api/integrations/ai/review-notes',
            'token_hint' => $enabled ? 'Use the token you saved when enabling the API. Regenerate if you need a new one.' : '',
        ]);
    }

    private function enableAiReviewApi(array $user): void
    {
        $this->requireAdmin($user);
        $envToken = Config::aiReviewApiToken();
        if ($envToken !== '') {
            $this->json(['enabled' => true, 'source' => 'environment', 'token' => null, 'endpoint' => $this->origin() . '/api/integrations/ai/review-notes']);
        }
        $token = bin2hex(random_bytes(32));
        file_put_contents($this->aiReviewTokenPath(), $token . "\n");
        $this->audit((int)$user['id'], 'integration.ai_review_enabled', 'integration', null);
        $this->json(['enabled' => true, 'source' => 'local', 'token' => $token, 'endpoint' => $this->origin() . '/api/integrations/ai/review-notes']);
    }

    private function revealAiReviewApiToken(array $user): void
    {
        $this->requireAdmin($user);
        if (Config::aiReviewApiToken() !== '') throw new RuntimeException('Environment-managed AI API tokens cannot be revealed from Settings');
        $data = $this->input();
        $this->requireCurrentPassword($user, (string)($data['current_password'] ?? ''));
        $token = $this->aiReviewFileToken();
        if ($token === '') throw new RuntimeException('AI review API is not enabled');
        $this->audit((int)$user['id'], 'integration.ai_review_token_revealed', 'integration', null);
        $this->json(['token' => $token, 'endpoint' => $this->origin() . '/api/integrations/ai/review-notes']);
    }

    private function testAiReviewApiToken(array $user): void
    {
        $this->requireAdmin($user);
        $data = $this->input();
        $token = trim((string)($data['token'] ?? ''));
        if ($token === '') throw new RuntimeException('Token required');
        $configuredToken = $this->configuredAiReviewToken();
        if ($configuredToken === '' || !hash_equals($configuredToken, $token)) throw new RuntimeException('AI review API token did not validate');
        $this->json(['ok' => true, 'message' => 'AI review API token validated']);
    }

    private function disableAiReviewApi(array $user): void
    {
        $this->requireAdmin($user);
        if (Config::aiReviewApiToken() !== '') throw new RuntimeException('AI API is configured by environment variable');
        $path = $this->aiReviewTokenPath();
        if (is_file($path)) unlink($path);
        $this->audit((int)$user['id'], 'integration.ai_review_disabled', 'integration', null);
        $this->json(['enabled' => false]);
    }

    private function featureSettings(array $user): void
    {
        $this->json(['features' => $this->userFeatures((int)$user['id'])]);
    }

    private function saveFeatureSettings(array $user): void
    {
        $data = $this->input();
        $features = $this->userFeatures((int)$user['id']);
        foreach (['calendar', 'tasks', 'home'] as $feature) {
            if (!isset($data[$feature]) || !is_array($data[$feature])) continue;
            $current = $features[$feature];
            $incoming = $data[$feature];
            if (array_key_exists('enabled', $incoming)) $current['enabled'] = !empty($incoming['enabled']);
            foreach ($incoming as $key => $value) {
                if ($key === 'enabled') continue;
                $current['settings'][$key] = is_bool($value) ? $value : (is_numeric($value) ? (int)$value : $value);
            }
            $features[$feature] = $current;
            $stmt = $this->db->prepare('INSERT INTO user_feature_settings (user_id, feature, enabled, settings_json, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(user_id, feature) DO UPDATE SET enabled = excluded.enabled, settings_json = excluded.settings_json, updated_at = CURRENT_TIMESTAMP');
            $stmt->execute([(int)$user['id'], $feature, !empty($current['enabled']) ? 1 : 0, json_encode($current['settings'])]);
        }
        $this->audit((int)$user['id'], 'settings.features_updated', 'settings', null);
        $this->json(['features' => $this->userFeatures((int)$user['id'])]);
    }

    private function listCalendars(array $user): void
    {
        $this->ensureDefaultCalendar($user);
        $stmt = $this->db->prepare("SELECT c.*, CASE WHEN c.owner_user_id = ? THEN 'owner' ELSE s.permission END AS permission, u.name AS owner_name FROM calendars c JOIN users u ON u.id = c.owner_user_id LEFT JOIN calendar_shares s ON s.calendar_id = c.id AND s.user_id = ? WHERE c.archived = 0 AND (c.owner_user_id = ? OR s.user_id = ?) ORDER BY c.owner_user_id = ? DESC, c.name COLLATE NOCASE");
        $stmt->execute([(int)$user['id'], (int)$user['id'], (int)$user['id'], (int)$user['id'], (int)$user['id']]);
        $calendars = $stmt->fetchAll(PDO::FETCH_ASSOC);
        foreach ($calendars as &$calendar) {
            $calendar['shares'] = in_array((string)($calendar['permission'] ?? ''), ['owner', 'admin'], true) ? $this->calendarShares((int)$calendar['id']) : [];
        }
        $this->json(['calendars' => $calendars]);
    }

    private function saveCalendar(array $user, int $id = 0): void
    {
        $this->requireEditor($user);
        $data = $this->input();
        $name = trim((string)($data['name'] ?? '')) ?: 'Calendar';
        $color = $this->cleanColor($data['color'] ?? '#635bff');
        $description = trim((string)($data['description'] ?? '')) ?: null;
        if ($id > 0) {
            $this->calendarAccess($user, $id, 'admin');
            $stmt = $this->db->prepare('UPDATE calendars SET name = ?, color = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
            $stmt->execute([$name, $color, $description, $id]);
            $this->audit((int)$user['id'], 'calendar.updated', 'calendar', $id);
        } else {
            $stmt = $this->db->prepare('INSERT INTO calendars (owner_user_id, name, color, description, timezone) VALUES (?, ?, ?, ?, ?)');
            $stmt->execute([(int)$user['id'], $name, $color, $description, date_default_timezone_get() ?: 'UTC']);
            $id = (int)$this->db->lastInsertId();
            $this->audit((int)$user['id'], 'calendar.created', 'calendar', $id);
        }
        $this->json(['calendar' => $this->calendarAccess($user, $id, 'view')]);
    }

    private function deleteCalendar(array $user, int $id): void
    {
        $this->calendarAccess($user, $id, 'admin');
        $this->db->prepare('UPDATE calendars SET archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([$id]);
        $this->audit((int)$user['id'], 'calendar.deleted', 'calendar', $id);
        $this->json(['ok' => true]);
    }

    private function shareCalendar(array $user, int $id): void
    {
        $this->calendarAccess($user, $id, 'admin');
        $data = $this->input();
        $email = strtolower(trim((string)($data['email'] ?? '')));
        $permission = (string)($data['permission'] ?? 'view');
        if (!in_array($permission, ['view', 'edit', 'admin'], true)) throw new RuntimeException('Invalid permission');
        $stmt = $this->db->prepare('SELECT id FROM users WHERE email = ? AND disabled = 0');
        $stmt->execute([$email]);
        $shareUserId = (int)$stmt->fetchColumn();
        if (!$shareUserId) throw new RuntimeException('User not found');
        if ($shareUserId === (int)$user['id']) throw new RuntimeException('Calendar owner already has access');
        $this->db->prepare('INSERT INTO calendar_shares (calendar_id, user_id, permission) VALUES (?, ?, ?) ON CONFLICT(calendar_id, user_id) DO UPDATE SET permission = excluded.permission')->execute([$id, $shareUserId, $permission]);
        $this->audit((int)$user['id'], 'calendar.shared', 'calendar', $id);
        $this->json(['shares' => $this->calendarShares($id)]);
    }

    private function unshareCalendar(array $user, int $id, int $shareUserId): void
    {
        $this->calendarAccess($user, $id, 'admin');
        $this->db->prepare('DELETE FROM calendar_shares WHERE calendar_id = ? AND user_id = ?')->execute([$id, $shareUserId]);
        $this->db->prepare('DELETE FROM calendar_event_reminders WHERE user_id = ? AND event_id IN (SELECT id FROM calendar_events WHERE calendar_id = ?)')->execute([$shareUserId, $id]);
        $this->db->prepare('DELETE FROM task_reminders WHERE user_id = ? AND task_id IN (SELECT id FROM tasks WHERE calendar_id = ?)')->execute([$shareUserId, $id]);
        $this->audit((int)$user['id'], 'calendar.unshared', 'calendar', $id);
        $this->json(['shares' => $this->calendarShares($id)]);
    }

    private function listEvents(array $user): void
    {
        $this->ensureDefaultCalendar($user);
        $this->syncDueCalendarFeeds($user);
        [$start, $end] = $this->dateRangeFromQuery();
        $args = [(int)$user['id'], (int)$user['id'], (int)$user['id'], $end, $start, $end];
        $stmt = $this->db->prepare("SELECT e.*, c.name AS calendar_name, c.color AS calendar_color FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id LEFT JOIN calendar_shares s ON s.calendar_id = c.id AND s.user_id = ? WHERE c.archived = 0 AND (c.owner_user_id = ? OR s.user_id = ?) AND ((e.recurrence_rule IS NULL AND e.starts_at <= ? AND COALESCE(e.ends_at, e.starts_at) >= ?) OR (e.recurrence_rule IS NOT NULL AND e.starts_at <= ?)) ORDER BY e.starts_at ASC");
        $stmt->execute($args);
        $this->json(['events' => $this->expandRecurringEvents($stmt->fetchAll(PDO::FETCH_ASSOC), $start, $end)]);
    }

    private function listCalendarFeeds(array $user): void
    {
        $stmt = $this->db->prepare('SELECT f.*, c.archived AS calendar_archived FROM calendar_feeds f LEFT JOIN calendars c ON c.id = f.calendar_id WHERE f.user_id = ? ORDER BY f.name COLLATE NOCASE');
        $stmt->execute([(int)$user['id']]);
        $this->json(['feeds' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
    }

    private function saveCalendarFeed(array $user, int $id = 0): void
    {
        $this->requireEditor($user);
        $data = $this->input();
        $current = $id > 0 ? $this->calendarFeed($user, $id) : null;
        $name = trim((string)($data['name'] ?? ($current['name'] ?? '')));
        if ($name === '') $name = 'External calendar';
        $url = trim((string)($data['url'] ?? ($current['url'] ?? '')));
        $this->validateCalendarFeedUrl($url);
        $color = $this->cleanColor($data['color'] ?? ($current['color'] ?? '#22c55e'));
        $refresh = $this->boundedGenericInt($data['refresh_minutes'] ?? ($current['refresh_minutes'] ?? 360), 15, 10080);
        $enabled = !array_key_exists('enabled', $data) || !empty($data['enabled']) ? 1 : 0;
        if ($current) {
            $calendarId = (int)($current['calendar_id'] ?: 0);
            if ($calendarId) {
                $this->db->prepare('UPDATE calendars SET name = ?, color = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_user_id = ?')->execute([$name, $color, 'Read-only external calendar feed.', $calendarId, (int)$user['id']]);
            }
            $this->db->prepare('UPDATE calendar_feeds SET name=?, url=?, color=?, refresh_minutes=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?')->execute([$name, $url, $color, $refresh, $enabled, $id, (int)$user['id']]);
            $this->audit((int)$user['id'], 'calendar_feed.updated', 'calendar_feed', $id);
        } else {
            $this->db->prepare('INSERT INTO calendars (owner_user_id, name, color, description, timezone, external_source) VALUES (?, ?, ?, ?, ?, ?)')->execute([(int)$user['id'], $name, $color, 'Read-only external calendar feed.', date_default_timezone_get() ?: 'UTC', 'ics_feed']);
            $calendarId = (int)$this->db->lastInsertId();
            $this->db->prepare('INSERT INTO calendar_feeds (user_id, calendar_id, name, url, color, refresh_minutes, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)')->execute([(int)$user['id'], $calendarId, $name, $url, $color, $refresh, $enabled]);
            $id = (int)$this->db->lastInsertId();
            $this->audit((int)$user['id'], 'calendar_feed.created', 'calendar_feed', $id);
        }
        $syncError = null;
        if (!empty($data['sync_now'])) {
            try {
                $this->syncCalendarFeedInternal($user, $id);
            } catch (Throwable $e) {
                $syncError = $e->getMessage();
            }
        }
        $this->json(['feed' => $this->calendarFeed($user, $id), 'sync_error' => $syncError]);
    }

    private function syncCalendarFeed(array $user, int $id): void
    {
        $this->requireEditor($user);
        $result = $this->syncCalendarFeedInternal($user, $id);
        $this->json($result);
    }

    private function deleteCalendarFeed(array $user, int $id): void
    {
        $this->requireEditor($user);
        $feed = $this->calendarFeed($user, $id);
        $this->db->prepare('DELETE FROM calendar_feeds WHERE id = ? AND user_id = ?')->execute([$id, (int)$user['id']]);
        if (!empty($feed['calendar_id'])) $this->db->prepare('UPDATE calendars SET archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_user_id = ?')->execute([(int)$feed['calendar_id'], (int)$user['id']]);
        $this->audit((int)$user['id'], 'calendar_feed.deleted', 'calendar_feed', $id);
        $this->json(['ok' => true]);
    }

    private function getEvent(array $user, int $id): void
    {
        $event = $this->eventAccess($user, $id, 'view');
        $event['notes'] = $this->linkedNotes('event', $id, $user);
        $event['reminder_minutes'] = $this->eventReminderMinutes($user, $id);
        $this->json(['event' => $event]);
    }

    private function saveEvent(array $user, int $id = 0): void
    {
        $this->requireEditor($user);
        $data = $this->input();
        $calendarId = (int)($data['calendar_id'] ?? 0);
        if ($id > 0) {
            $current = $this->eventAccess($user, $id, 'edit');
            if (($current['source'] ?? '') === 'ics_feed') throw new RuntimeException('Synced calendar events are read-only');
            $calendarId = $calendarId ?: (int)$current['calendar_id'];
        }
        if (!$calendarId) $calendarId = $this->ensureDefaultCalendar($user);
        $this->calendarAccess($user, $calendarId, 'edit');
        $title = trim((string)($data['title'] ?? '')) ?: 'Untitled event';
        $startsAt = $this->cleanDateTime($data['starts_at'] ?? '') ?: gmdate('Y-m-d H:i:s');
        $endsAt = $this->cleanDateTime($data['ends_at'] ?? '') ?: $startsAt;
        $allDay = !empty($data['all_day']) ? 1 : 0;
        if ($id > 0) {
            $stmt = $this->db->prepare('UPDATE calendar_events SET calendar_id=?, title=?, description=?, location=?, starts_at=?, ends_at=?, all_day=?, recurrence_rule=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
            $stmt->execute([$calendarId, $title, (string)($data['description'] ?? ''), (string)($data['location'] ?? ''), $startsAt, $endsAt, $allDay, trim((string)($data['recurrence_rule'] ?? '')) ?: null, $id]);
            $this->audit((int)$user['id'], 'event.updated', 'event', $id);
        } else {
            $stmt = $this->db->prepare('INSERT INTO calendar_events (calendar_id, created_by_user_id, title, description, location, starts_at, ends_at, all_day, recurrence_rule, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            $stmt->execute([$calendarId, (int)$user['id'], $title, (string)($data['description'] ?? ''), (string)($data['location'] ?? ''), $startsAt, $endsAt, $allDay, trim((string)($data['recurrence_rule'] ?? '')) ?: null, 'manual']);
            $id = (int)$this->db->lastInsertId();
            $this->audit((int)$user['id'], 'event.created', 'event', $id);
        }
        $this->saveEventReminder($user, $id, $startsAt, $data['reminder_minutes'] ?? null);
        $this->saveLinks('event', $id, $user, $data['note_ids'] ?? []);
        $this->json(['event' => $this->eventAccess($user, $id, 'view')]);
    }

    private function deleteEvent(array $user, int $id): void
    {
        $event = $this->eventAccess($user, $id, 'edit');
        if (($event['source'] ?? '') === 'ics_feed') throw new RuntimeException('Synced calendar events are read-only');
        $this->db->prepare('DELETE FROM calendar_events WHERE id = ?')->execute([$id]);
        $this->audit((int)$user['id'], 'event.deleted', 'event', $id);
        $this->json(['ok' => true]);
    }

    private function listTasks(array $user): void
    {
        $this->ensureDefaultCalendar($user);
        $view = $_GET['view'] ?? 'open';
        $where = ['(t.user_id = ? OR (t.private = 0 AND t.calendar_id IN (SELECT c.id FROM calendars c LEFT JOIN calendar_shares s ON s.calendar_id = c.id AND s.user_id = ? WHERE c.archived = 0 AND (c.owner_user_id = ? OR s.user_id = ?))))'];
        $args = [(int)$user['id'], (int)$user['id'], (int)$user['id'], (int)$user['id']];
        if ($view !== 'all') $where[] = $view === 'done' ? "t.status = 'done'" : "t.status != 'done'";
        $stmt = $this->db->prepare('SELECT t.*, c.name AS calendar_name, c.color AS calendar_color FROM tasks t LEFT JOIN calendars c ON c.id = t.calendar_id WHERE ' . implode(' AND ', $where) . ' ORDER BY CASE WHEN t.status = \'done\' THEN 1 ELSE 0 END, t.due_at IS NULL, t.due_at ASC, t.priority DESC, t.id DESC');
        $stmt->execute($args);
        $this->json(['tasks' => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
    }

    private function getTask(array $user, int $id): void
    {
        $task = $this->taskAccess($user, $id, 'view');
        $task['notes'] = $this->linkedNotes('task', $id, $user);
        $task['reminder_minutes'] = $this->taskReminderMinutes($user, $id);
        $this->json(['task' => $task]);
    }

    private function saveTask(array $user, int $id = 0): void
    {
        $this->requireEditor($user);
        $data = $this->input();
        $current = $id > 0 ? $this->taskAccess($user, $id, 'edit') : null;
        $calendarId = isset($data['calendar_id']) && $data['calendar_id'] !== '' ? (int)$data['calendar_id'] : ($current ? (int)($current['calendar_id'] ?? 0) : null);
        $private = array_key_exists('shared', $data) ? (empty($data['shared']) ? 1 : 0) : ($current ? (int)$current['private'] : 1);
        if ($calendarId) $this->calendarAccess($user, $calendarId, 'edit');
        $title = trim((string)($data['title'] ?? ($current['title'] ?? ''))) ?: 'Untitled task';
        $status = in_array(($data['status'] ?? ''), ['open', 'done'], true) ? $data['status'] : ($current['status'] ?? 'open');
        $completedAt = $status === 'done' ? ($current['completed_at'] ?? gmdate('Y-m-d H:i:s')) : null;
        $dueAt = $this->cleanDateTime($data['due_at'] ?? ($current['due_at'] ?? ''));
        $location = trim((string)($data['location'] ?? $current['location'] ?? ''));
        if ($id > 0) {
            $stmt = $this->db->prepare('UPDATE tasks SET calendar_id=?, title=?, description=?, location=?, status=?, priority=?, due_at=?, completed_at=?, private=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
            $stmt->execute([$calendarId ?: null, $title, (string)($data['description'] ?? $current['description'] ?? ''), $location, $status, (int)($data['priority'] ?? $current['priority'] ?? 0), $dueAt, $completedAt, $private, $id]);
            $this->audit((int)$user['id'], 'task.updated', 'task', $id);
        } else {
            $stmt = $this->db->prepare('INSERT INTO tasks (user_id, calendar_id, title, description, location, status, priority, due_at, completed_at, private, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            $stmt->execute([(int)$user['id'], $calendarId ?: null, $title, (string)($data['description'] ?? ''), $location, $status, (int)($data['priority'] ?? 0), $dueAt, $completedAt, $private, 'manual']);
            $id = (int)$this->db->lastInsertId();
            $this->audit((int)$user['id'], 'task.created', 'task', $id);
        }
        $this->saveTaskReminder($user, $id, $dueAt, $data['reminder_minutes'] ?? null);
        $this->saveLinks('task', $id, $user, $data['note_ids'] ?? []);
        $this->json(['task' => $this->taskAccess($user, $id, 'view')]);
    }

    private function deleteTask(array $user, int $id): void
    {
        $this->taskAccess($user, $id, 'edit');
        $this->db->prepare('DELETE FROM tasks WHERE id = ?')->execute([$id]);
        $this->audit((int)$user['id'], 'task.deleted', 'task', $id);
        $this->json(['ok' => true]);
    }

    private function dueReminders(array $user): void
    {
        $userId = (int)$user['id'];
        $eventStmt = $this->db->prepare("SELECT r.id, 'event' AS kind, r.remind_at, e.title, e.starts_at AS due_at FROM calendar_event_reminders r JOIN calendar_events e ON e.id = r.event_id JOIN calendars c ON c.id = e.calendar_id LEFT JOIN calendar_shares s ON s.calendar_id = c.id AND s.user_id = ? WHERE r.user_id = ? AND c.archived = 0 AND (c.owner_user_id = ? OR s.user_id = ?) AND r.dismissed_at IS NULL AND r.sent_at IS NULL AND r.remind_at <= CURRENT_TIMESTAMP ORDER BY r.remind_at LIMIT 25");
        $eventStmt->execute([$userId, $userId, $userId, $userId]);
        $taskStmt = $this->db->prepare("SELECT r.id, 'task' AS kind, r.remind_at, t.title, t.due_at FROM task_reminders r JOIN tasks t ON t.id = r.task_id LEFT JOIN calendars c ON c.id = t.calendar_id LEFT JOIN calendar_shares s ON s.calendar_id = c.id AND s.user_id = ? WHERE r.user_id = ? AND (t.user_id = ? OR (t.private = 0 AND c.archived = 0 AND (c.owner_user_id = ? OR s.user_id = ?))) AND r.dismissed_at IS NULL AND r.sent_at IS NULL AND r.remind_at <= CURRENT_TIMESTAMP ORDER BY r.remind_at LIMIT 25");
        $taskStmt->execute([$userId, $userId, $userId, $userId, $userId]);
        $this->json(['reminders' => array_merge($eventStmt->fetchAll(PDO::FETCH_ASSOC), $taskStmt->fetchAll(PDO::FETCH_ASSOC))]);
    }

    private function updateReminder(array $user, string $kind, int $id, string $action): void
    {
        $table = $kind === 'event' ? 'calendar_event_reminders' : 'task_reminders';
        if ($action === 'dismiss') {
            $this->db->prepare("UPDATE $table SET dismissed_at = CURRENT_TIMESTAMP, sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP) WHERE id = ? AND user_id = ?")->execute([$id, (int)$user['id']]);
        } else {
            $minutes = $this->boundedGenericInt($this->input()['minutes'] ?? 10, 1, 1440);
            $this->db->prepare("UPDATE $table SET remind_at = datetime('now', ?), sent_at = NULL WHERE id = ? AND user_id = ?")->execute(['+' . $minutes . ' minutes', $id, (int)$user['id']]);
        }
        $this->json(['ok' => true]);
    }

    private function calendarFeed(array $user, int $id): array
    {
        $stmt = $this->db->prepare('SELECT * FROM calendar_feeds WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, (int)$user['id']]);
        $feed = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$feed) throw new RuntimeException('Calendar feed not found');
        return $feed;
    }

    private function syncCalendarFeedInternal(array $user, int $id): array
    {
        $feed = $this->calendarFeed($user, $id);
        if ((int)($feed['enabled'] ?? 1) !== 1) throw new RuntimeException('Calendar feed is disabled');
        $calendarId = (int)($feed['calendar_id'] ?? 0);
        if (!$calendarId) throw new RuntimeException('Calendar feed has no calendar');
        $this->calendarAccess($user, $calendarId, 'admin');
        try {
            $ics = $this->fetchCalendarFeed((string)$feed['url']);
            $events = $this->parseIcsEvents($ics);
            if (count($events) > self::ICS_FEED_MAX_EVENTS) throw new RuntimeException('ICS feed is limited to ' . self::ICS_FEED_MAX_EVENTS . ' events');
            $seen = [];
            $imported = 0;
            $updated = 0;
            $total = 0;
            foreach ($events as $event) {
                $total++;
                $uid = $event['uid'] ?: hash('sha256', json_encode($event));
                $seen[] = $uid;
                $existing = $this->db->prepare('SELECT id FROM calendar_events WHERE calendar_id = ? AND import_source = ? AND import_uid = ?');
                $existing->execute([$calendarId, 'ics_feed', $uid]);
                $existingId = (int)$existing->fetchColumn();
                if ($existingId) {
                    $stmt = $this->db->prepare('UPDATE calendar_events SET title=?, description=?, location=?, starts_at=?, ends_at=?, all_day=?, recurrence_rule=?, source=?, import_updated_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?');
                    $stmt->execute([$event['title'], $event['description'], $event['location'], $event['starts_at'], $event['ends_at'], $event['all_day'], $event['recurrence_rule'], 'ics_feed', $existingId]);
                    $updated++;
                } else {
                    $stmt = $this->db->prepare('INSERT OR IGNORE INTO calendar_events (calendar_id, created_by_user_id, title, description, location, starts_at, ends_at, all_day, recurrence_rule, source, import_source, import_uid, import_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)');
                    $stmt->execute([$calendarId, (int)$user['id'], $event['title'], $event['description'], $event['location'], $event['starts_at'], $event['ends_at'], $event['all_day'], $event['recurrence_rule'], 'ics_feed', 'ics_feed', $uid]);
                    if ($stmt->rowCount() > 0) $imported++;
                }
            }
            if ($seen) {
                $placeholders = implode(',', array_fill(0, count($seen), '?'));
                $args = array_merge([$calendarId, 'ics_feed'], $seen);
                $this->db->prepare("DELETE FROM calendar_events WHERE calendar_id = ? AND import_source = ? AND import_uid NOT IN ($placeholders)")->execute($args);
            } else {
                $this->db->prepare('DELETE FROM calendar_events WHERE calendar_id = ? AND import_source = ?')->execute([$calendarId, 'ics_feed']);
            }
            $message = "Synced $total event" . ($total === 1 ? '' : 's');
            $this->db->prepare('UPDATE calendar_feeds SET last_synced_at=CURRENT_TIMESTAMP, last_status=?, last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?')->execute([$message, $id]);
            $this->audit((int)$user['id'], 'calendar_feed.synced', 'calendar_feed', $id);
            return ['ok' => true, 'total' => $total, 'imported' => $imported, 'updated' => $updated, 'message' => $message, 'feed' => $this->calendarFeed($user, $id)];
        } catch (Throwable $e) {
            $this->db->prepare('UPDATE calendar_feeds SET last_status=?, last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')->execute(['Sync failed', substr($e->getMessage(), 0, 500), $id]);
            throw $e;
        }
    }

    private function syncDueCalendarFeeds(array $user): void
    {
        $stmt = $this->db->prepare("SELECT id FROM calendar_feeds WHERE user_id = ? AND enabled = 1 AND (last_synced_at IS NULL OR datetime(last_synced_at, '+' || refresh_minutes || ' minutes') <= CURRENT_TIMESTAMP) ORDER BY COALESCE(last_synced_at, '1970-01-01') ASC LIMIT 3");
        $stmt->execute([(int)$user['id']]);
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $feedId) {
            try {
                $this->syncCalendarFeedInternal($user, (int)$feedId);
            } catch (Throwable $e) {
                // Feed errors are saved on the feed and should not block opening Calendar.
            }
        }
    }

    private function validateCalendarFeedUrl(string $url): void
    {
        $parts = parse_url($url);
        if (!$parts || !in_array(strtolower((string)($parts['scheme'] ?? '')), ['http', 'https'], true) || empty($parts['host'])) throw new RuntimeException('Enter a valid HTTP or HTTPS calendar URL');
        $host = strtolower((string)$parts['host']);
        if (in_array($host, ['localhost', '127.0.0.1', '::1'], true) || str_ends_with($host, '.local')) throw new RuntimeException('Local calendar feed URLs are not allowed');
        $addresses = filter_var($host, FILTER_VALIDATE_IP) ? [$host] : (gethostbynamel($host) ?: []);
        foreach ($addresses as $address) {
            if (!filter_var($address, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) throw new RuntimeException('Private network calendar feed URLs are not allowed');
        }
    }

    private function fetchCalendarFeed(string $url): string
    {
        $this->validateCalendarFeedUrl($url);
        $context = stream_context_create(['http' => ['timeout' => 15, 'user_agent' => 'DiVault Calendar Feed/1.0', 'follow_location' => 0]]);
        $maxBytes = 1024 * 1024;
        $ics = @file_get_contents($url, false, $context, 0, $maxBytes + 1);
        if ($ics === false || trim((string)$ics) === '') throw new RuntimeException('Calendar feed could not be fetched');
        if (strlen((string)$ics) > $maxBytes) throw new RuntimeException('Calendar feed is too large');
        if (!str_contains(strtoupper((string)$ics), 'BEGIN:VCALENDAR')) throw new RuntimeException('Calendar feed is not a valid ICS calendar');
        return (string)$ics;
    }

    private function importCalendar(array $user): void
    {
        $this->requireEditor($user);
        $calendarId = (int)($_POST['calendar_id'] ?? 0);
        $ics = '';
        $maxBytes = self::ICS_IMPORT_MAX_BYTES;
        if (!empty($_FILES['ics']['tmp_name'])) {
            if ((int)($_FILES['ics']['size'] ?? 0) > $maxBytes) throw new RuntimeException('ICS file is too large');
            $ics = (string)file_get_contents($_FILES['ics']['tmp_name'], false, null, 0, $maxBytes + 1);
        }
        if ($ics === '') $ics = (string)($this->input()['ics'] ?? '');
        if (strlen($ics) > $maxBytes) throw new RuntimeException('ICS file is too large');
        if (trim($ics) === '') throw new RuntimeException('Choose an ICS file to import');
        if (!$calendarId) $calendarId = $this->ensureDefaultCalendar($user);
        $this->calendarAccess($user, $calendarId, 'edit');
        $imported = 0;
        $updated = 0;
        $skipped = 0;
        $total = 0;
        $mode = ($_POST['mode'] ?? ($this->input()['mode'] ?? 'skip')) === 'update' ? 'update' : 'skip';
        $events = $this->parseIcsEvents($ics);
        if (count($events) > self::ICS_IMPORT_MAX_EVENTS) throw new RuntimeException('ICS import is limited to ' . self::ICS_IMPORT_MAX_EVENTS . ' events per file');
        $this->db->beginTransaction();
        try {
            foreach ($events as $event) {
                $total++;
                $uid = $event['uid'] ?: hash('sha256', json_encode($event));
                if ($mode === 'update') {
                    $existing = $this->db->prepare('SELECT id FROM calendar_events WHERE calendar_id = ? AND import_source = ? AND import_uid = ?');
                    $existing->execute([$calendarId, 'ics', $uid]);
                    $existingId = (int)$existing->fetchColumn();
                    if ($existingId) {
                        $stmt = $this->db->prepare('UPDATE calendar_events SET title=?, description=?, location=?, starts_at=?, ends_at=?, all_day=?, recurrence_rule=?, import_updated_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?');
                        $stmt->execute([$event['title'], $event['description'], $event['location'], $event['starts_at'], $event['ends_at'], $event['all_day'], $event['recurrence_rule'], $existingId]);
                        $updated++;
                        continue;
                    }
                }
                $stmt = $this->db->prepare('INSERT OR IGNORE INTO calendar_events (calendar_id, created_by_user_id, title, description, location, starts_at, ends_at, all_day, recurrence_rule, source, import_source, import_uid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
                $stmt->execute([$calendarId, (int)$user['id'], $event['title'], $event['description'], $event['location'], $event['starts_at'], $event['ends_at'], $event['all_day'], $event['recurrence_rule'], 'ics', 'ics', $uid]);
                if ($stmt->rowCount() > 0) $imported++;
                else $skipped++;
            }
            $this->audit((int)$user['id'], 'calendar.imported', 'calendar', $calendarId);
            $this->db->commit();
        } catch (Throwable $e) {
            $this->db->rollBack();
            throw $e;
        }
        $this->json(['total' => $total, 'imported' => $imported, 'updated' => $updated, 'skipped' => $skipped]);
    }

    private function exportCalendarIcs(array $user, int $calendarId): void
    {
        $calendar = $this->calendarAccess($user, $calendarId, 'view');
        $stmt = $this->db->prepare('SELECT * FROM calendar_events WHERE calendar_id = ? ORDER BY starts_at');
        $stmt->execute([$calendarId]);
        $lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DiVault//Calendar//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:' . $this->icsEscape($calendar['name'])];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $event) {
            $lines[] = 'BEGIN:VEVENT';
            $lines[] = 'UID:' . $this->icsEscape(($event['import_uid'] ?: 'divault-' . $event['id']) . '@divault');
            $lines[] = 'DTSTAMP:' . gmdate('Ymd\THis\Z');
            if ((int)$event['all_day']) {
                $startDate = strtotime($event['starts_at']);
                $endDate = strtotime($event['ends_at'] ?: $event['starts_at']);
                $lines[] = 'DTSTART;VALUE=DATE:' . gmdate('Ymd', $startDate);
                $lines[] = 'DTEND;VALUE=DATE:' . gmdate('Ymd', strtotime('+1 day', $endDate));
            } else {
                $lines[] = 'DTSTART:' . gmdate('Ymd\THis\Z', strtotime($event['starts_at']));
                $lines[] = 'DTEND:' . gmdate('Ymd\THis\Z', strtotime($event['ends_at'] ?: $event['starts_at']));
            }
            $lines[] = 'SUMMARY:' . $this->icsEscape($event['title']);
            if ($event['description']) $lines[] = 'DESCRIPTION:' . $this->icsEscape($event['description']);
            if ($event['location']) $lines[] = 'LOCATION:' . $this->icsEscape($event['location']);
            if ($event['recurrence_rule']) $lines[] = 'RRULE:' . $this->icsEscape($event['recurrence_rule']);
            $lines[] = 'END:VEVENT';
        }
        $lines[] = 'END:VCALENDAR';
        header('Content-Type: text/calendar; charset=utf-8');
        header('Content-Disposition: ' . $this->contentDisposition('attachment', $this->slugify($calendar['name']) . '.ics'));
        echo implode("\r\n", $lines) . "\r\n";
        exit;
    }

    private function retentionSettings(array $user): void
    {
        $this->requireAdmin($user);
        $this->json(['settings' => $this->retentionPolicy()]);
    }

    private function saveRetentionSettings(array $user): void
    {
        $this->requireAdmin($user);
        $data = $this->input();
        $versionLimit = $this->boundedInt($data['version_limit'] ?? 3, 0, 100);
        $trashDays = $this->boundedInt($data['trash_days'] ?? 30, 1, 3650);
        $this->setAppSetting('version_limit', (string)$versionLimit);
        $this->setAppSetting('trash_days', (string)$trashDays);
        $this->pruneAllNoteVersions();
        $this->pruneTrashByPolicy();
        $this->audit((int)$user['id'], 'settings.retention_updated', 'settings', null);
        $this->json(['ok' => true, 'settings' => $this->retentionPolicy()]);
    }

    private function deleteNote(array $user, int $id): void
    {
        $this->requireEditor($user);
        $this->db->prepare('UPDATE notes SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([$id]);
        $this->audit((int)$user['id'], 'note.deleted', 'note', $id);
        $this->json(['ok' => true]);
    }

    private function restoreNoteVersion(array $user, int $noteId, int $versionId): void
    {
        $this->requireEditor($user);
        $note = $this->note($noteId);
        $stmt = $this->db->prepare('SELECT * FROM note_versions WHERE id = ? AND note_id = ?');
        $stmt->execute([$versionId, $noteId]);
        $version = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$version) throw new RuntimeException('Version not found');
        $this->db->beginTransaction();
        try {
            $this->db->prepare('INSERT INTO note_versions (note_id, user_id, title, body) VALUES (?, ?, ?, ?)')->execute([$noteId, (int)$user['id'], $note['title'], $note['body']]);
            $this->pruneNoteVersions($noteId);
            $this->db->prepare('UPDATE notes SET title = ?, body = ?, deleted = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([$version['title'], $version['body'], $noteId]);
            $this->audit((int)$user['id'], 'note.version_restored', 'note', $noteId);
            $this->db->commit();
        } catch (Throwable $e) {
            $this->db->rollBack();
            throw $e;
        }
        $this->json(['ok' => true]);
    }

    private function getNoteVersion(array $user, int $noteId, int $versionId): void
    {
        $this->note($noteId);
        $stmt = $this->db->prepare('SELECT id, note_id, title, body, created_at FROM note_versions WHERE id = ? AND note_id = ?');
        $stmt->execute([$versionId, $noteId]);
        $version = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$version) throw new RuntimeException('Version not found');
        $this->json(['version' => $version]);
    }

    private function archiveNote(array $user, int $id): void
    {
        $this->requireEditor($user);
        $this->note($id);
        $this->db->prepare('UPDATE notes SET archived = 1, deleted = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([$id]);
        $this->audit((int)$user['id'], 'note.archived', 'note', $id);
        $this->json(['ok' => true]);
    }

    private function restoreNote(array $user, int $id): void
    {
        $this->requireEditor($user);
        $this->note($id);
        $this->db->prepare('UPDATE notes SET archived = 0, deleted = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([$id]);
        $this->audit((int)$user['id'], 'note.restored', 'note', $id);
        $this->json(['ok' => true]);
    }

    private function permanentlyDeleteNote(array $user, int $id): void
    {
        $this->requireEditor($user);
        $this->note($id);
        $this->db->prepare('DELETE FROM notes WHERE id = ?')->execute([$id]);
        $this->audit((int)$user['id'], 'note.permanently_deleted', 'note', $id);
        $this->json(['ok' => true]);
    }

    private function emptyTrash(array $user): void
    {
        $this->requireEditor($user);
        $this->db->exec('DELETE FROM notes WHERE deleted = 1');
        $this->audit((int)$user['id'], 'note.trash_emptied', 'note', null);
        $this->json(['ok' => true]);
    }

    private function retentionPolicy(): array
    {
        return [
            'version_limit' => $this->settingInt('version_limit', 3, 0, 100),
            'trash_days' => $this->settingInt('trash_days', 30, 1, 3650),
        ];
    }

    private function settingInt(string $key, int $default, int $min, int $max): int
    {
        $stmt = $this->db->prepare('SELECT value FROM app_settings WHERE key = ?');
        $stmt->execute([$key]);
        $value = $stmt->fetchColumn();
        return $this->boundedInt($value === false ? $default : $value, $min, $max);
    }

    private function setAppSetting(string $key, string $value): void
    {
        $stmt = $this->db->prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP');
        $stmt->execute([$key, $value]);
    }

    private function boundedInt($value, int $min, int $max): int
    {
        $number = filter_var($value, FILTER_VALIDATE_INT);
        if ($number === false) throw new RuntimeException('Retention settings must be whole numbers');
        return max($min, min($max, (int)$number));
    }

    private function boundedGenericInt($value, int $min, int $max): int
    {
        $number = filter_var($value, FILTER_VALIDATE_INT);
        if ($number === false) throw new RuntimeException('Value must be a whole number');
        return max($min, min($max, (int)$number));
    }

    private function userFeatures(int $userId): array
    {
        $features = [
            'calendar' => ['enabled' => false, 'settings' => ['home_enabled' => true, 'reminders_enabled' => true, 'default_reminder_minutes' => 10, 'default_calendar_id' => null]],
            'tasks' => ['enabled' => false, 'settings' => ['home_enabled' => true, 'reminders_enabled' => true, 'default_reminder_minutes' => 10, 'shared_calendar_tasks' => true]],
            'home' => ['enabled' => true, 'settings' => ['notes_enabled' => true]],
        ];
        $stmt = $this->db->prepare('SELECT feature, enabled, settings_json FROM user_feature_settings WHERE user_id = ?');
        $stmt->execute([$userId]);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $feature = (string)$row['feature'];
            if (!isset($features[$feature])) continue;
            $settings = json_decode((string)($row['settings_json'] ?? ''), true);
            $features[$feature]['enabled'] = (int)$row['enabled'] === 1;
            if (is_array($settings)) $features[$feature]['settings'] = array_replace($features[$feature]['settings'], $settings);
        }
        return $features;
    }

    private function ensureDefaultCalendar(array $user): int
    {
        $stmt = $this->db->prepare('SELECT id FROM calendars WHERE owner_user_id = ? AND archived = 0 ORDER BY id LIMIT 1');
        $stmt->execute([(int)$user['id']]);
        $id = (int)$stmt->fetchColumn();
        if ($id) return $id;
        $stmt = $this->db->prepare('INSERT INTO calendars (owner_user_id, name, color, timezone) VALUES (?, ?, ?, ?)');
        $stmt->execute([(int)$user['id'], 'My Calendar', '#635bff', date_default_timezone_get() ?: 'UTC']);
        return (int)$this->db->lastInsertId();
    }

    private function calendarAccess(array $user, int $calendarId, string $level): array
    {
        $stmt = $this->db->prepare("SELECT c.*, CASE WHEN c.owner_user_id = ? THEN 'owner' ELSE s.permission END AS permission FROM calendars c LEFT JOIN calendar_shares s ON s.calendar_id = c.id AND s.user_id = ? WHERE c.id = ? AND c.archived = 0 AND (c.owner_user_id = ? OR s.user_id = ?)");
        $stmt->execute([(int)$user['id'], (int)$user['id'], $calendarId, (int)$user['id'], (int)$user['id']]);
        $calendar = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$calendar) throw new RuntimeException('Calendar not found');
        $permission = (string)($calendar['permission'] ?? '');
        $rank = ['view' => 1, 'read' => 1, 'edit' => 2, 'admin' => 3, 'owner' => 4];
        if (($rank[$permission] ?? 0) < ($rank[$level] ?? 1)) throw new RuntimeException('Calendar permission required');
        return $calendar;
    }

    private function calendarShares(int $calendarId): array
    {
        $stmt = $this->db->prepare('SELECT s.user_id, s.permission, u.email, u.name FROM calendar_shares s JOIN users u ON u.id = s.user_id WHERE s.calendar_id = ? ORDER BY u.email');
        $stmt->execute([$calendarId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    private function eventAccess(array $user, int $eventId, string $level): array
    {
        $stmt = $this->db->prepare('SELECT e.*, c.name AS calendar_name, c.color AS calendar_color FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id WHERE e.id = ?');
        $stmt->execute([$eventId]);
        $event = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$event) throw new RuntimeException('Event not found');
        $this->calendarAccess($user, (int)$event['calendar_id'], $level);
        return $event;
    }

    private function taskAccess(array $user, int $taskId, string $level): array
    {
        $stmt = $this->db->prepare('SELECT t.*, c.name AS calendar_name, c.color AS calendar_color FROM tasks t LEFT JOIN calendars c ON c.id = t.calendar_id WHERE t.id = ?');
        $stmt->execute([$taskId]);
        $task = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$task) throw new RuntimeException('Task not found');
        if ((int)$task['user_id'] === (int)$user['id']) return $task;
        if ((int)$task['private'] === 1 || empty($task['calendar_id'])) throw new RuntimeException('Task not found');
        $this->calendarAccess($user, (int)$task['calendar_id'], $level);
        return $task;
    }

    private function dateRangeFromQuery(): array
    {
        $start = $this->cleanDateTime($_GET['start'] ?? '') ?: gmdate('Y-m-01 00:00:00');
        $end = $this->cleanDateTime($_GET['end'] ?? '') ?: gmdate('Y-m-t 23:59:59');
        return [$start, $end];
    }

    private function cleanDateTime($value): ?string
    {
        if (!is_string($value) || trim($value) === '') return null;
        $value = trim($value);
        if (preg_match('/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/', $value, $match)) {
            return $match[1] . ' ' . $match[2] . ':' . ($match[3] ?? '00');
        }
        $time = strtotime($value);
        return $time ? gmdate('Y-m-d H:i:s', $time) : null;
    }

    private function cleanColor($value): string
    {
        $color = trim((string)$value);
        return preg_match('/^#[0-9a-f]{6}$/i', $color) ? $color : '#635bff';
    }

    private function saveEventReminder(array $user, int $eventId, string $startsAt, $minutes): void
    {
        $this->db->prepare('DELETE FROM calendar_event_reminders WHERE event_id = ? AND user_id = ?')->execute([$eventId, (int)$user['id']]);
        if ($minutes === null || $minutes === '' || (int)$minutes < 0) return;
        $minutes = $this->boundedGenericInt($minutes, 0, 10080);
        $remindAt = gmdate('Y-m-d H:i:s', strtotime($startsAt) - ($minutes * 60));
        $this->db->prepare('INSERT INTO calendar_event_reminders (event_id, user_id, remind_at, offset_minutes) VALUES (?, ?, ?, ?)')->execute([$eventId, (int)$user['id'], $remindAt, $minutes]);
    }

    private function saveTaskReminder(array $user, int $taskId, ?string $dueAt, $minutes): void
    {
        $this->db->prepare('DELETE FROM task_reminders WHERE task_id = ? AND user_id = ?')->execute([$taskId, (int)$user['id']]);
        if (!$dueAt || $minutes === null || $minutes === '' || (int)$minutes < 0) return;
        $minutes = $this->boundedGenericInt($minutes, 0, 10080);
        $remindAt = gmdate('Y-m-d H:i:s', strtotime($dueAt) - ($minutes * 60));
        $this->db->prepare('INSERT INTO task_reminders (task_id, user_id, remind_at, offset_minutes) VALUES (?, ?, ?, ?)')->execute([$taskId, (int)$user['id'], $remindAt, $minutes]);
    }

    private function eventReminderMinutes(array $user, int $eventId): ?int
    {
        $stmt = $this->db->prepare('SELECT offset_minutes FROM calendar_event_reminders WHERE event_id = ? AND user_id = ? AND dismissed_at IS NULL ORDER BY id DESC LIMIT 1');
        $stmt->execute([$eventId, (int)$user['id']]);
        $value = $stmt->fetchColumn();
        return $value === false ? null : (int)$value;
    }

    private function taskReminderMinutes(array $user, int $taskId): ?int
    {
        $stmt = $this->db->prepare('SELECT offset_minutes FROM task_reminders WHERE task_id = ? AND user_id = ? AND dismissed_at IS NULL ORDER BY id DESC LIMIT 1');
        $stmt->execute([$taskId, (int)$user['id']]);
        $value = $stmt->fetchColumn();
        return $value === false ? null : (int)$value;
    }

    private function saveLinks(string $kind, int $id, array $user, $noteIds): void
    {
        $table = $kind === 'event' ? 'calendar_event_notes' : 'task_notes';
        $idColumn = $kind === 'event' ? 'event_id' : 'task_id';
        if (!is_array($noteIds)) return;
        $validNoteIds = [];
        foreach (array_unique(array_map('intval', $noteIds)) as $noteId) {
            if ($noteId <= 0) continue;
            $note = $this->note($noteId);
            if ((int)$note['user_id'] !== (int)$user['id']) throw new RuntimeException('Note not found');
            $validNoteIds[] = $noteId;
        }
        $this->db->prepare("DELETE FROM $table WHERE $idColumn = ? AND (user_id = ? OR user_id IS NULL)")->execute([$id, (int)$user['id']]);
        foreach ($validNoteIds as $noteId) {
            $this->db->prepare("INSERT OR IGNORE INTO $table ($idColumn, note_id, user_id) VALUES (?, ?, ?)")->execute([$id, $noteId, (int)$user['id']]);
        }
    }

    private function linkedNotes(string $kind, int $id, array $user): array
    {
        $table = $kind === 'event' ? 'calendar_event_notes' : 'task_notes';
        $idColumn = $kind === 'event' ? 'event_id' : 'task_id';
        $stmt = $this->db->prepare("SELECT n.id, n.title FROM $table l JOIN notes n ON n.id = l.note_id WHERE l.$idColumn = ? AND n.user_id = ? AND n.deleted = 0 ORDER BY n.title");
        $stmt->execute([$id, (int)$user['id']]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    private function expandRecurringEvents(array $events, string $rangeStart, string $rangeEnd): array
    {
        $expanded = [];
        $rangeStartTs = strtotime($rangeStart) ?: 0;
        $rangeEndTs = strtotime($rangeEnd) ?: time();
        foreach ($events as $event) {
            $rule = $this->parseRecurrenceRule((string)($event['recurrence_rule'] ?? ''));
            if (!$rule) {
                $expanded[] = $event;
                continue;
            }
            $startTs = strtotime((string)$event['starts_at']);
            if (!$startTs) continue;
            $endTs = strtotime((string)($event['ends_at'] ?: $event['starts_at'])) ?: $startTs;
            $duration = max(0, $endTs - $startTs);
            $interval = max(1, (int)($rule['INTERVAL'] ?? 1));
            $count = isset($rule['COUNT']) ? max(1, (int)$rule['COUNT']) : 732;
            $untilTs = isset($rule['UNTIL']) ? ($this->icsDateToTimestamp((string)$rule['UNTIL']) ?: $rangeEndTs) : $rangeEndTs;
            $limitTs = min($rangeEndTs, $untilTs);
            $occurrenceTs = $startTs;
            $seen = 0;
            while ($occurrenceTs <= $limitTs && $seen < $count) {
                $occurrenceEnd = $occurrenceTs + $duration;
                if ($occurrenceEnd >= $rangeStartTs && $occurrenceTs <= $rangeEndTs) {
                    $copy = $event;
                    $copy['occurrence_id'] = $event['id'] . '-' . gmdate('YmdHis', $occurrenceTs);
                    $copy['series_id'] = (int)$event['id'];
                    $copy['starts_at'] = gmdate('Y-m-d H:i:s', $occurrenceTs);
                    $copy['ends_at'] = gmdate('Y-m-d H:i:s', $occurrenceEnd);
                    $expanded[] = $copy;
                }
                $seen++;
                $occurrenceTs = $this->nextRecurrenceTimestamp($occurrenceTs, (string)($rule['FREQ'] ?? ''), $interval);
                if (!$occurrenceTs) break;
            }
        }
        usort($expanded, fn($a, $b) => strcmp((string)$a['starts_at'], (string)$b['starts_at']));
        return $expanded;
    }

    private function parseRecurrenceRule(string $rule): array
    {
        $rule = trim($rule);
        if ($rule === '') return [];
        $parts = [];
        foreach (explode(';', $rule) as $part) {
            if (!str_contains($part, '=')) continue;
            [$key, $value] = explode('=', $part, 2);
            $parts[strtoupper(trim($key))] = strtoupper(trim($value));
        }
        return in_array($parts['FREQ'] ?? '', ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'], true) ? $parts : [];
    }

    private function nextRecurrenceTimestamp(int $timestamp, string $freq, int $interval): int
    {
        return match ($freq) {
            'DAILY' => strtotime('+' . $interval . ' day', $timestamp) ?: 0,
            'WEEKLY' => strtotime('+' . $interval . ' week', $timestamp) ?: 0,
            'MONTHLY' => strtotime('+' . $interval . ' month', $timestamp) ?: 0,
            'YEARLY' => strtotime('+' . $interval . ' year', $timestamp) ?: 0,
            default => 0,
        };
    }

    private function icsDateToTimestamp(string $value): ?int
    {
        $sql = $this->icsDateToSql($value);
        return $sql ? (strtotime($sql . ' UTC') ?: null) : null;
    }

    private function parseIcsEvents(string $ics): array
    {
        $ics = preg_replace("/\r?\n[ \t]/", '', $ics) ?? $ics;
        preg_match_all('/BEGIN:VEVENT\r?\n(.*?)\r?\nEND:VEVENT/s', $ics, $matches);
        $events = [];
        foreach ($matches[1] as $block) {
            $fields = [];
            foreach (preg_split('/\r?\n/', trim($block)) as $line) {
                if (!str_contains($line, ':')) continue;
                [$name, $value] = explode(':', $line, 2);
                $key = strtoupper(strtok($name, ';'));
                $fields[$key] = $this->icsUnescape($value);
                if (str_contains(strtoupper($name), 'VALUE=DATE')) $fields[$key . '_ALL_DAY'] = '1';
            }
            $start = $this->icsDateToSql($fields['DTSTART'] ?? '');
            if (!$start) continue;
            $events[] = [
                'uid' => substr($fields['UID'] ?? '', 0, 255),
                'title' => substr(trim($fields['SUMMARY'] ?? '') ?: 'Imported event', 0, 255),
                'description' => substr($fields['DESCRIPTION'] ?? '', 0, 5000),
                'location' => substr($fields['LOCATION'] ?? '', 0, 255),
                'starts_at' => $start,
                'ends_at' => $this->icsDateToSql($fields['DTEND'] ?? '') ?: $start,
                'all_day' => !empty($fields['DTSTART_ALL_DAY']) ? 1 : 0,
                'recurrence_rule' => isset($fields['RRULE']) ? substr($fields['RRULE'], 0, 500) : null,
            ];
        }
        return $events;
    }

    private function icsDateToSql(string $value): ?string
    {
        $value = trim($value);
        if ($value === '') return null;
        if (preg_match('/^\d{8}$/', $value)) return gmdate('Y-m-d 00:00:00', strtotime($value));
        if (preg_match('/^\d{8}T\d{6}Z?$/', $value)) {
            $time = strtotime(substr($value, 0, 8) . ' ' . substr($value, 9, 2) . ':' . substr($value, 11, 2) . ':' . substr($value, 13, 2) . (str_ends_with($value, 'Z') ? ' UTC' : ''));
            return $time ? gmdate('Y-m-d H:i:s', $time) : null;
        }
        return $this->cleanDateTime($value);
    }

    private function icsEscape(string $value): string
    {
        return str_replace(["\\", "\r", "\n", ';', ','], ['\\\\', '', '\\n', '\\;', '\\,'], $value);
    }

    private function icsUnescape(string $value): string
    {
        return str_replace(['\\n', '\\N', '\\,', '\\;', '\\\\'], ["\n", "\n", ',', ';', '\\'], $value);
    }

    private function applyRetentionPolicy(): void
    {
        $this->pruneTrashByPolicy();
    }

    private function pruneTrashByPolicy(): void
    {
        $days = $this->settingInt('trash_days', 30, 1, 3650);
        $stmt = $this->db->prepare('DELETE FROM notes WHERE deleted = 1 AND updated_at < datetime(\'now\', ?)');
        $stmt->execute(['-' . $days . ' days']);
    }

    private function pruneNoteVersions(int $noteId): void
    {
        $limit = $this->settingInt('version_limit', 3, 0, 100);
        if ($limit === 0) {
            $this->db->prepare('DELETE FROM note_versions WHERE note_id = ?')->execute([$noteId]);
            return;
        }
        $stmt = $this->db->prepare('DELETE FROM note_versions WHERE note_id = ? AND id NOT IN (SELECT id FROM note_versions WHERE note_id = ? ORDER BY id DESC LIMIT ?)');
        $stmt->execute([$noteId, $noteId, $limit]);
    }

    private function pruneAllNoteVersions(): void
    {
        $ids = $this->db->query('SELECT DISTINCT note_id FROM note_versions')->fetchAll(PDO::FETCH_COLUMN);
        foreach ($ids as $id) {
            $this->pruneNoteVersions((int)$id);
        }
    }

    private function uploadFile(array $user, int $noteId): void
    {
        $this->requireEditor($user);
        $this->note($noteId);
        if (empty($_FILES['file'])) throw new RuntimeException('No file uploaded');
        $file = $_FILES['file'];
        if (($file['error'] ?? UPLOAD_ERR_OK) !== UPLOAD_ERR_OK) throw new RuntimeException('Upload failed');
        if (($file['size'] ?? 0) <= 0 || (int)$file['size'] > 25 * 1024 * 1024) throw new RuntimeException('Invalid file size');
        $mime = (new finfo(FILEINFO_MIME_TYPE))->file($file['tmp_name']) ?: 'application/octet-stream';
        $name = preg_replace('/[^a-zA-Z0-9._-]/', '_', basename((string)$file['name'])) ?: 'upload.bin';
        $stored = bin2hex(random_bytes(16)) . '-' . $name;
        $dest = Config::dir() . '/files/' . $stored;
        if (!move_uploaded_file($file['tmp_name'], $dest)) throw new RuntimeException('Upload failed');
        @chmod($dest, 0600);
        $stmt = $this->db->prepare('INSERT INTO files (note_id, user_id, original_name, stored_name, mime, size) VALUES (?, ?, ?, ?, ?, ?)');
        $stmt->execute([$noteId, (int)$user['id'], $file['name'], $stored, $mime, (int)$file['size']]);
        $this->audit((int)$user['id'], 'file.uploaded', 'note', $noteId);
        $this->json(['ok' => true]);
    }

    private function downloadFile(array $user, int $id, bool $inline = false): void
    {
        $stmt = $this->db->prepare('SELECT * FROM files WHERE id = ?');
        $stmt->execute([$id]);
        $file = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$file) throw new RuntimeException('File not found');
        $path = Config::dir() . '/files/' . basename((string)$file['stored_name']);
        if (!is_file($path)) throw new RuntimeException('File not found');
        $this->audit((int)$user['id'], 'file.downloaded', 'file', $id);
        header_remove('Content-Type');
        header('Content-Type: ' . ($file['mime'] ?: 'application/octet-stream'));
        $mode = $inline && $this->isPreviewable($file['mime'] ?? '') ? 'inline' : 'attachment';
        header('Content-Disposition: ' . $this->contentDisposition($mode, $file['original_name']));
        header('X-Content-Type-Options: nosniff');
        readfile($path);
        exit;
    }

    private function revealSecret(array $user, int $id): void
    {
        $this->requireEditor($user);
        $stmt = $this->db->prepare('SELECT * FROM note_secrets WHERE id = ?');
        $stmt->execute([$id]);
        $secret = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$secret) throw new RuntimeException('Secret not found');
        $this->audit((int)$user['id'], 'secret.revealed', 'secret', $id);
        $this->json(['value' => $this->crypto->decrypt($secret['ciphertext'])]);
    }

    private function clients(array $user): void
    {
        $this->json(['clients' => $this->db->query('SELECT * FROM clients ORDER BY name')->fetchAll(PDO::FETCH_ASSOC)]);
    }

    private function createClient(array $user): void
    {
        $this->requireEditor($user);
        $data = $this->input();
        $this->db->prepare('INSERT INTO clients (name, notes) VALUES (?, ?)')->execute([trim($data['name'] ?? ''), $data['notes'] ?? null]);
        $id = (int)$this->db->lastInsertId();
        $this->audit((int)$user['id'], 'client.created', 'client', $id);
        $this->json(['id' => $id]);
    }

    private function deleteClient(array $user, int $id): void
    {
        $this->requireEditor($user);
        $this->db->prepare('DELETE FROM clients WHERE id = ?')->execute([$id]);
        $this->audit((int)$user['id'], 'client.deleted', 'client', $id);
        $this->json(['ok' => true]);
    }

    private function users(array $user): void
    {
        $this->requireAdmin($user);
        $this->json(['users' => $this->db->query('SELECT id, email, name, role, totp_enabled, passkey_enabled, disabled, created_at FROM users ORDER BY id')->fetchAll(PDO::FETCH_ASSOC)]);
    }

    private function updateProfile(array $user): void
    {
        $data = $this->input();
        $name = trim($data['name'] ?? $user['name']);
        if ($name === '') throw new RuntimeException('Name required');
        $avatar = isset($data['avatar_data']) ? trim((string)$data['avatar_data']) : ($user['avatar_data'] ?? null);
        if ($avatar !== null && $avatar !== '' && !preg_match('#^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$#', $avatar)) {
            throw new RuntimeException('Avatar must be an image');
        }
        if ($avatar !== null && strlen($avatar) > 512000) throw new RuntimeException('Avatar image is too large');
        if (!empty($data['new_password'])) {
            $this->requireCurrentPassword($user, $data['current_password'] ?? '');
            if (strlen((string)$data['new_password']) < 10) throw new RuntimeException('Password must be at least 10 characters');
            if (($data['new_password_confirm'] ?? '') !== $data['new_password']) throw new RuntimeException('New passwords do not match');
            $hash = password_hash((string)$data['new_password'], PASSWORD_DEFAULT);
            $this->db->prepare('UPDATE users SET name = ?, password_hash = ?, avatar_data = ? WHERE id = ?')->execute([$name, $hash, $avatar ?: null, (int)$user['id']]);
            $this->audit((int)$user['id'], 'profile.password_updated', 'user', (int)$user['id']);
        } else {
            $this->db->prepare('UPDATE users SET name = ?, avatar_data = ? WHERE id = ?')->execute([$name, $avatar ?: null, (int)$user['id']]);
            $this->audit((int)$user['id'], 'profile.updated', 'user', (int)$user['id']);
        }
        $stmt = $this->db->prepare('SELECT * FROM users WHERE id = ?');
        $stmt->execute([(int)$user['id']]);
        $this->json(['user' => $this->publicUser($stmt->fetch(PDO::FETCH_ASSOC))]);
    }

    private function createUser(array $user): void
    {
        $this->requireAdmin($user);
        $data = $this->input();
        $role = $data['role'] ?? 'editor';
        if (!in_array($role, ['owner', 'admin', 'editor', 'viewer'], true)) throw new RuntimeException('Invalid role');
        if ($role === 'owner' && $user['role'] !== 'owner') throw new RuntimeException('Owner role required');
        $id = $this->createUserRow($data['email'] ?? '', $data['name'] ?? '', $data['password'] ?? '', $role);
        $this->audit((int)$user['id'], 'user.created', 'user', $id);
        $this->json(['id' => $id]);
    }

    private function start2fa(array $user): void
    {
        $data = $this->input();
        $this->requireCurrentPassword($user, $data['current_password'] ?? '');
        $secret = Totp::secret();
        $this->db->prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?')->execute([$this->crypto->encrypt($secret), (int)$user['id']]);
        $issuer = rawurlencode('DiVault');
        $label = rawurlencode($user['email']);
        $this->json(['secret' => $secret, 'otpauth' => "otpauth://totp/$issuer:$label?secret=$secret&issuer=$issuer"]);
    }

    private function confirm2fa(array $user): void
    {
        $data = $this->input();
        $stmt = $this->db->prepare('SELECT totp_secret FROM users WHERE id = ?');
        $stmt->execute([(int)$user['id']]);
        $secret = $stmt->fetchColumn();
        if (!$secret || !Totp::verify($this->crypto->decrypt($secret), $data['code'] ?? '')) throw new RuntimeException('Invalid code');
        $this->db->prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?')->execute([(int)$user['id']]);
        $codes = $this->generateRecoveryCodes((int)$user['id']);
        $this->audit((int)$user['id'], '2fa.enabled', 'user', (int)$user['id']);
        $this->json(['ok' => true, 'recovery_codes' => $codes]);
    }

    private function regenerateRecoveryCodes(array $user): void
    {
        $data = $this->input();
        $this->requireCurrentPassword($user, $data['current_password'] ?? '');
        $codes = $this->generateRecoveryCodes((int)$user['id']);
        $this->audit((int)$user['id'], '2fa.recovery_regenerated', 'user', (int)$user['id']);
        $this->json(['recovery_codes' => $codes]);
    }

    private function webauthnRegisterOptions(array $user): void
    {
        $data = $this->input();
        $this->requireCurrentPassword($user, $data['current_password'] ?? '');
        $challenge = $this->base64UrlEncode(random_bytes(32));
        $this->saveWebauthnChallenge('register', (int)$user['id'], $challenge);
        $this->json([
            'challenge' => $challenge,
            'rp' => ['name' => 'DiVault'],
            'user' => ['id' => $this->base64UrlEncode((string)$user['id']), 'name' => $user['email'], 'displayName' => $user['name']],
            'pubKeyCredParams' => [['type' => 'public-key', 'alg' => -7], ['type' => 'public-key', 'alg' => -257]],
            'authenticatorSelection' => ['residentKey' => 'preferred', 'userVerification' => 'required'],
            'timeout' => 60000,
            'attestation' => 'none',
            'excludeCredentials' => array_map(fn($row) => ['type' => 'public-key', 'id' => $row['credential_id']], $this->webauthnCredentials((int)$user['id'])),
        ]);
    }

    private function listWebauthnCredentials(array $user): void
    {
        $this->json(['credentials' => $this->webauthnCredentialList((int)$user['id'])]);
    }

    private function webauthnRegister(array $user): void
    {
        $data = $this->input();
        $challenge = $this->webauthnChallenge('register', (int)$user['id']);
        $this->deleteSetting($this->webauthnChallengeKey('register', (int)$user['id']));
        $this->verifyWebauthnClientData($data['clientDataJSON'] ?? '', 'webauthn.create', $challenge);
        $attestationAuthData = $this->base64UrlDecode((string)($data['authenticatorData'] ?? ''));
        $this->requireWebauthnUserVerification($attestationAuthData);
        $credentialId = (string)($data['id'] ?? '');
        $publicKey = $this->spkiToPem($this->base64UrlDecode((string)($data['publicKey'] ?? '')));
        $label = trim((string)($data['label'] ?? '')) ?: 'Passkey';
        if ($credentialId === '' || $publicKey === '') throw new RuntimeException('Passkey registration failed');
        $this->db->prepare('INSERT INTO webauthn_credentials (user_id, label, credential_id, public_key) VALUES (?, ?, ?, ?)')->execute([(int)$user['id'], substr($label, 0, 80), $credentialId, $publicKey]);
        $this->db->prepare('UPDATE users SET passkey_enabled = 1 WHERE id = ?')->execute([(int)$user['id']]);
        $this->audit((int)$user['id'], 'passkey.enrolled', 'user', (int)$user['id']);
        $this->json(['ok' => true, 'credentials' => $this->webauthnCredentialList((int)$user['id'])]);
    }

    private function deleteWebauthnCredential(array $user, int $id): void
    {
        $this->db->prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?')->execute([$id, (int)$user['id']]);
        $remaining = count($this->webauthnCredentials((int)$user['id']));
        if ($remaining === 0) $this->db->prepare('UPDATE users SET passkey_enabled = 0 WHERE id = ?')->execute([(int)$user['id']]);
        $this->audit((int)$user['id'], 'passkey.deleted', 'user', (int)$user['id']);
        $this->json(['ok' => true, 'credentials' => $this->webauthnCredentialList((int)$user['id'])]);
    }

    private function audit($user = null, string $action = null, string $type = null, int $id = null): void
    {
        if ($action !== null) {
            $userId = is_array($user) ? (int)$user['id'] : $user;
            $this->db->prepare('INSERT INTO audit_log (user_id, action, subject_type, subject_id, ip) VALUES (?, ?, ?, ?, ?)')->execute([$userId, $action, $type, $id, $this->ip()]);
            $this->recordSyncEvent($userId, $action, $type, $id);
            return;
        }
        $this->requireAdmin($user);
        $rows = $this->db->query('SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 200')->fetchAll(PDO::FETCH_ASSOC);
        $this->json(['audit' => $rows]);
    }

    private function recordSyncEvent(?int $userId, string $action, ?string $type, ?int $id): void
    {
        if (!in_array($type, ['note', 'category', 'asset', 'client', 'file'], true)) return;
        if (!preg_match('/\.(created|updated|deleted|archived|restored|uploaded|permanently_deleted)$/', $action)) return;
        $this->db->prepare('INSERT INTO sync_events (user_id, entity_type, entity_id, action) VALUES (?, ?, ?, ?)')->execute([$userId, $type, $id, $action]);
    }

    private function export(array $user): void
    {
        $this->requireAdmin($user);
        $this->audit((int)$user['id'], 'export.created', 'export', null);
        $data = [
            'exported_at' => gmdate('c'),
            'notes' => $this->db->query('SELECT * FROM notes WHERE deleted = 0 ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'assets' => $this->db->query('SELECT id, client_id, type, name, status, asset_type, os, primary_ip, serial_number, expires_at, location, contact, username, notes, data_json, archived, created_at, updated_at FROM asset_records ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'clients' => $this->db->query('SELECT * FROM clients ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'files' => $this->db->query('SELECT id, note_id, original_name, mime, size, created_at FROM files ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'calendars' => $this->db->query('SELECT * FROM calendars ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'calendar_shares' => $this->db->query('SELECT * FROM calendar_shares ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'events' => $this->db->query('SELECT * FROM calendar_events ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'tasks' => $this->db->query('SELECT * FROM tasks ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
        ];
        header('Content-Type: application/json');
        header('Content-Disposition: ' . $this->contentDisposition('attachment', 'divault-export.json'));
        echo json_encode($data, JSON_PRETTY_PRINT);
        exit;
    }

    private function import(array $user): void
    {
        $this->requireAdmin($user);
        $data = $this->input();
        if (empty($data['notes']) || !is_array($data['notes'])) throw new RuntimeException('Import JSON must contain notes array');
        $count = 0;
        $categoryCount = 0;
        foreach ($data['notes'] as $note) {
            $categoryId = $this->importCategoryPath($note['category_path'] ?? ($note['category'] ?? null), $categoryCount);
            $category = $note['category'] ?? null;
            if (is_array($note['category_path'] ?? null) && count($note['category_path']) > 0) {
                $category = end($note['category_path']);
            }
            $createdAt = $this->cleanImportedDate($note['created_at'] ?? null);
            $updatedAt = $this->cleanImportedDate($note['updated_at'] ?? null) ?: $createdAt;
            $tags = $note['tags'] ?? null;
            if (is_array($tags)) $tags = implode(', ', array_filter(array_map('trim', $tags)));
            $this->db->prepare('INSERT INTO notes (user_id, title, body, type, section, category_id, category, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))')->execute([
                (int)$user['id'],
                trim((string)($note['title'] ?? '')) ?: 'Imported note',
                (string)($note['body'] ?? ''),
                trim((string)($note['type'] ?? 'text')) ?: 'text',
                trim((string)($note['section'] ?? 'All')) ?: 'All',
                $categoryId,
                $category,
                $tags,
                $createdAt,
                $updatedAt,
            ]);
            $count++;
        }
        $this->audit((int)$user['id'], 'import.completed', 'import', null);
        $this->json(['imported' => $count, 'categories_created' => $categoryCount]);
    }

    private function importCategoryPath($path, int &$created): ?int
    {
        if ($path === null || $path === '') return null;
        $parts = is_array($path) ? $path : explode('/', (string)$path);
        $parentId = null;
        $lastId = null;
        foreach ($parts as $part) {
            $name = trim((string)$part);
            if ($name === '') continue;
            $stmt = $this->db->prepare('SELECT id FROM asset_categories WHERE name = ?');
            $stmt->execute([$name]);
            $existing = $stmt->fetchColumn();
            if ($existing) {
                $lastId = (int)$existing;
                $parentId = $lastId;
                continue;
            }
            $slug = $this->slugify($name);
            $insert = $this->db->prepare('INSERT INTO asset_categories (parent_id, name, slug) VALUES (?, ?, ?)');
            $insert->execute([$parentId, $name, $slug]);
            $lastId = (int)$this->db->lastInsertId();
            $parentId = $lastId;
            $created++;
        }
        return $lastId;
    }

    private function cleanImportedDate($value): ?string
    {
        if (!is_string($value) || trim($value) === '') return null;
        $time = strtotime($value);
        return $time ? gmdate('Y-m-d H:i:s', $time) : null;
    }

    private function backup(array $user): void
    {
        $this->requireAdmin($user);
        $data = $this->input();
        $passphrase = (string)($data['passphrase'] ?? '');
        $encrypt = $passphrase !== '';
        $name = 'backup-' . gmdate('Ymd-His') . '.zip';
        $zipPath = Config::dir() . '/backups/' . $name;
        $zip = new ZipArchive();
        if ($zip->open($zipPath, ZipArchive::CREATE) !== true) throw new RuntimeException('Backup failed');
        if ($encrypt && !$zip->setPassword($passphrase)) {
            $zip->close();
            @unlink($zipPath);
            throw new RuntimeException('Backup encryption failed');
        }
        try {
            foreach (['app.sqlite', 'keys/master.key'] as $file) {
                $path = Config::dir() . '/' . $file;
                if (file_exists($path)) $this->addBackupFile($zip, $path, $file, $encrypt);
            }
            $filesDir = Config::dir() . '/files';
            foreach (glob($filesDir . '/*') ?: [] as $file) {
                if (is_file($file)) $this->addBackupFile($zip, $file, 'files/' . basename($file), $encrypt);
            }
        } catch (Throwable $e) {
            $zip->close();
            @unlink($zipPath);
            throw $e;
        }
        if (!$zip->close()) {
            @unlink($zipPath);
            throw new RuntimeException($encrypt ? 'Backup encryption failed' : 'Backup failed');
        }
        $this->audit((int)$user['id'], 'backup.created', 'backup', null);
        $this->pruneBackups(10);
        $this->json(['file' => $name, 'path' => '/config/backups/' . $name, 'encrypted' => $encrypt]);
    }

    private function backups(array $user): void
    {
        $this->requireAdmin($user);
        $rows = [];
        foreach (glob(Config::dir() . '/backups/backup-*.zip') ?: [] as $file) {
            $rows[] = ['file' => basename($file), 'size' => filesize($file), 'created_at' => date('c', filemtime($file))];
        }
        usort($rows, fn ($a, $b) => strcmp($b['file'], $a['file']));
        $this->json(['backups' => $rows, 'pending_restore' => file_exists(Config::dir() . '/restore-pending.zip')]);
    }

    private function restore(array $user): void
    {
        $this->requireAdmin($user);
        $data = $this->input();
        $name = basename($data['file'] ?? '');
        $source = Config::dir() . '/backups/' . $name;
        if (!preg_match('/^backup-\d{8}-\d{6}\.zip$/', $name) || !is_file($source)) {
            throw new RuntimeException('Valid backup file required');
        }
        $passphrase = (string)($data['passphrase'] ?? '');
        $this->validateBackupZip($source, $passphrase);
        copy($source, Config::dir() . '/restore-pending.zip');
        $this->writeRestorePassphrase($passphrase);
        $this->audit((int)$user['id'], 'restore.scheduled', 'backup', null);
        $this->json(['ok' => true, 'message' => 'Restore scheduled. Restart the container to apply it.']);
    }

    private function restoreUpload(array $user): void
    {
        $this->requireAdmin($user);
        if (empty($_FILES['backup'])) throw new RuntimeException('No backup uploaded');
        $file = $_FILES['backup'];
        if (($file['error'] ?? UPLOAD_ERR_OK) !== UPLOAD_ERR_OK) throw new RuntimeException('Upload failed');
        if (($file['size'] ?? 0) <= 0 || (int)$file['size'] > 200 * 1024 * 1024) throw new RuntimeException('Invalid backup size');
        $passphrase = (string)($_POST['passphrase'] ?? '');
        $this->validateBackupZip($file['tmp_name'], $passphrase);
        copy($file['tmp_name'], Config::dir() . '/restore-pending.zip');
        $this->writeRestorePassphrase($passphrase);
        $this->audit((int)$user['id'], 'restore.upload_scheduled', 'backup', null);
        $this->json(['ok' => true, 'message' => 'Uploaded backup scheduled. Restart the container to apply it.']);
    }

    private function addBackupFile(ZipArchive $zip, string $path, string $entry, bool $encrypt): void
    {
        if (!$zip->addFile($path, $entry)) throw new RuntimeException('Backup failed');
        if ($encrypt) {
            if (!method_exists($zip, 'setEncryptionName') || !defined('ZipArchive::EM_AES_256')) {
                throw new RuntimeException('Backup encryption is not supported by this PHP ZIP extension');
            }
            if (!$zip->setEncryptionName($entry, constant('ZipArchive::EM_AES_256'))) {
                throw new RuntimeException('Backup encryption failed');
            }
        }
    }

    private function validateBackupZip(string $path, string $passphrase = ''): void
    {
        $zip = new ZipArchive();
        if ($zip->open($path) !== true) throw new RuntimeException('Invalid backup ZIP');
        if ($passphrase !== '' && !$zip->setPassword($passphrase)) {
            $zip->close();
            throw new RuntimeException('Invalid backup passphrase');
        }
        $hasDb = false;
        $dbIndex = false;
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $entry = $zip->getNameIndex($i);
            if ($entry === false || str_contains($entry, '\\') || str_contains($entry, '..')) {
                $zip->close();
                throw new RuntimeException('Backup ZIP contains invalid entries');
            }
            if ($zip->getExternalAttributesIndex($i, $opsys, $attrs) && $opsys === 3) {
                $mode = ($attrs >> 16) & 0170000;
                if ($mode !== 0 && !in_array($mode, [0040000, 0100000], true)) {
                    $zip->close();
                    throw new RuntimeException('Backup ZIP contains unsafe file types');
                }
            }
            if ($entry === 'app.sqlite') {
                $hasDb = true;
                $dbIndex = $i;
                continue;
            }
            if ($entry === 'keys/master.key') continue;
            if (preg_match('#^files/[^/]+$#', $entry)) continue;
            $zip->close();
            throw new RuntimeException('Backup ZIP contains unexpected entries');
        }
        if (!$hasDb) {
            $zip->close();
            throw new RuntimeException('Backup ZIP must contain app.sqlite');
        }
        if ($zip->statIndex((int)$dbIndex) === false || $zip->getFromIndex((int)$dbIndex, 1) === false) {
            $zip->close();
            throw new RuntimeException($passphrase !== '' ? 'Invalid backup passphrase' : 'Backup ZIP is encrypted; passphrase required');
        }
        $zip->close();
    }

    private function writeRestorePassphrase(string $passphrase): void
    {
        $path = Config::dir() . '/restore-passphrase';
        if ($passphrase === '') {
            @unlink($path);
            return;
        }
        if (file_put_contents($path, $passphrase) === false) throw new RuntimeException('Unable to write restore passphrase');
        @chmod($path, 0600);
    }

    private function applyBackupZip(string $path, string $passphrase = ''): void
    {
        $zip = new ZipArchive();
        if ($zip->open($path) !== true) throw new RuntimeException('Invalid backup ZIP');
        if ($passphrase !== '') $zip->setPassword($passphrase);
        $configDir = Config::dir();
        foreach (['files', 'keys'] as $dir) {
            if (!is_dir($configDir . '/' . $dir) && !mkdir($configDir . '/' . $dir, 0775, true)) {
                $zip->close();
                throw new RuntimeException('Unable to prepare restore directory');
            }
        }
        $db = $zip->getFromName('app.sqlite');
        if ($db === false) {
            $zip->close();
            throw new RuntimeException('Unable to read backup database');
        }
        if (file_put_contents($configDir . '/app.sqlite', $db) === false) {
            $zip->close();
            throw new RuntimeException('Unable to restore database');
        }
        @chmod($configDir . '/app.sqlite', 0600);
        $key = $zip->getFromName('keys/master.key');
        if ($key !== false) {
            if (file_put_contents($configDir . '/keys/master.key', $key) === false) {
                $zip->close();
                throw new RuntimeException('Unable to restore encryption key');
            }
            @chmod($configDir . '/keys/master.key', 0600);
        }
        foreach (glob($configDir . '/files/*') ?: [] as $oldFile) {
            if (is_file($oldFile)) @unlink($oldFile);
        }
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $entry = $zip->getNameIndex($i);
            if (!is_string($entry) || !preg_match('#^files/[^/]+$#', $entry)) continue;
            $content = $zip->getFromIndex($i);
            if ($content === false) {
                $zip->close();
                throw new RuntimeException('Unable to restore file attachment');
            }
            if (file_put_contents($configDir . '/' . $entry, $content) === false) {
                $zip->close();
                throw new RuntimeException('Unable to restore file attachment');
            }
            @chmod($configDir . '/' . $entry, 0600);
        }
        $zip->close();
    }

    private function downloadBackup(array $user, string $name): void
    {
        $this->requireAdmin($user);
        $name = basename($name);
        $path = Config::dir() . '/backups/' . $name;
        if (!preg_match('/^backup-\d{8}-\d{6}\.zip$/', $name) || !is_file($path)) {
            throw new RuntimeException('Backup not found');
        }
        $this->audit((int)$user['id'], 'backup.downloaded', 'backup', null);
        header_remove('Content-Type');
        header('Content-Type: application/zip');
        header('Content-Disposition: ' . $this->contentDisposition('attachment', $name));
        header('Content-Length: ' . filesize($path));
        readfile($path);
        exit;
    }

    private function extractSecrets(string $body, int $noteId = 0): array
    {
        $secrets = [];
        $existing = [];
        if ($noteId > 0) {
            $stmt = $this->db->prepare('SELECT label, ciphertext FROM note_secrets WHERE note_id = ? ORDER BY id');
            $stmt->execute([$noteId]);
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $key = strtolower(trim($row['label']));
                $existing[$key][] = $row['ciphertext'];
            }
        }
        $lines = preg_split('/\R/', $body);
        foreach ($lines as &$line) {
            if (preg_match('/^\s*(?:🔒\s*)?([^:\r\n]{0,80}(?:\b(?:password|pwd|pass|secret|token|key)\b|api\s*key)[^:\r\n]{0,80})\s*:\s*(.+)$/iu', $line, $m)) {
                $label = trim($m[1]);
                $value = trim($m[2]);
                $key = strtolower($label);
                if (strtolower($value) === '[hidden secret]' && !empty($existing[$key])) {
                    $secrets[] = ['label' => $label, 'ciphertext' => array_shift($existing[$key])];
                } elseif (strtolower($value) !== '[hidden secret]') {
                    $secrets[] = ['label' => $label, 'value' => $value];
                }
                $line = preg_replace('/:\s*.+$/', ': [hidden secret]', $line);
            }
        }
        return ['body' => implode("\n", $lines), 'secrets' => $secrets];
    }

    private function note(int $id): array
    {
        $stmt = $this->db->prepare('SELECT * FROM notes WHERE id = ?');
        $stmt->execute([$id]);
        $note = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$note) throw new RuntimeException('Note not found');
        return $note;
    }

    private function noteOrNull(int $id): ?array
    {
        $stmt = $this->db->prepare('SELECT * FROM notes WHERE id = ?');
        $stmt->execute([$id]);
        $note = $stmt->fetch(PDO::FETCH_ASSOC);
        return $note ?: null;
    }

    private function category(int $id): array
    {
        $stmt = $this->db->prepare('SELECT * FROM asset_categories WHERE id = ?');
        $stmt->execute([$id]);
        $category = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$category) throw new RuntimeException('Category not found');
        return $category;
    }

    private function requireUser(): array
    {
        $token = $_COOKIE['divault_session'] ?? $_COOKIE['qv_session'] ?? '';
        if (!$token) throw new RuntimeException('Authentication required');
        $stmt = $this->db->prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP AND u.disabled = 0');
        $stmt->execute([hash('sha256', $token)]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$user) throw new RuntimeException('Authentication required');
        return $user;
    }

    private function requireAiReviewUser(): array
    {
        $configuredToken = $this->configuredAiReviewToken();
        if ($configuredToken === '') throw new RuntimeException('AI review API is not configured');
        $header = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
        $provided = '';
        if (preg_match('/^Bearer\s+(.+)$/i', $header, $m)) $provided = trim($m[1]);
        if ($provided === '') $provided = trim($_SERVER['HTTP_X_DIVAULT_AI_TOKEN'] ?? '');
        if ($provided === '' || !hash_equals($configuredToken, $provided)) throw new RuntimeException('AI review API token required');

        $email = Config::aiReviewUserEmail();
        if ($email !== '') {
            $stmt = $this->db->prepare('SELECT * FROM users WHERE email = ? AND disabled = 0');
            $stmt->execute([$email]);
        } else {
            $stmt = $this->db->query("SELECT * FROM users WHERE disabled = 0 AND role IN ('owner', 'admin', 'editor') ORDER BY CASE role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END, id LIMIT 1");
        }
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$user) throw new RuntimeException('AI review user not found');
        return $user;
    }

    private function configuredAiReviewToken(): string
    {
        $envToken = Config::aiReviewApiToken();
        if ($envToken !== '') return $envToken;
        return $this->aiReviewFileToken();
    }

    private function aiReviewFileToken(): string
    {
        $path = $this->aiReviewTokenPath();
        if (!is_file($path)) return '';
        return trim((string)file_get_contents($path));
    }

    private function aiReviewTokenPath(): string
    {
        return Config::dir() . '/ai-review-api-token.txt';
    }

    private function requireCsrf(): void
    {
        $cookie = $_COOKIE['divault_csrf'] ?? $_COOKIE['qv_csrf'] ?? '';
        $header = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
        if (!$cookie || !$header || !hash_equals($cookie, $header)) {
            throw new RuntimeException('CSRF token required');
        }
    }

    private function requireCurrentPassword(array $user, string $password): void
    {
        if ($password === '' || !password_verify($password, $user['password_hash'] ?? '')) {
            throw new RuntimeException('Current password required');
        }
    }

    private function createSession(array $user): void
    {
        $token = bin2hex(random_bytes(32));
        $stmt = $this->db->prepare('INSERT INTO sessions (user_id, token_hash, user_agent, ip, expires_at) VALUES (?, ?, ?, ?, datetime("now", "+30 days"))');
        $stmt->execute([(int)$user['id'], hash('sha256', $token), $_SERVER['HTTP_USER_AGENT'] ?? '', $this->ip()]);
        setcookie('divault_session', $token, $this->cookieOptions(time() + 2592000));
        $this->setCsrfCookie();
    }

    private function securityHeaders(): void
    {
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: DENY');
        header('Referrer-Policy: same-origin');
        header('Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
        header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
        if ($this->isSecureRequest()) {
            header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
        }
    }

    private function webauthnCredentials(int $userId): array
    {
        $stmt = $this->db->prepare('SELECT id, label, credential_id, created_at, last_used_at FROM webauthn_credentials WHERE user_id = ? ORDER BY id DESC');
        $stmt->execute([$userId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    private function webauthnCredentialList(int $userId): array
    {
        return array_map(fn($row) => ['id' => (int)$row['id'], 'label' => $row['label'], 'created_at' => $row['created_at'], 'last_used_at' => $row['last_used_at'] ?? null], $this->webauthnCredentials($userId));
    }

    private function verifyWebauthnAssertion(array $data, string $challenge, string $publicKey): void
    {
        $clientDataJson = $this->base64UrlDecode((string)($data['clientDataJSON'] ?? ''));
        $authenticatorData = $this->base64UrlDecode((string)($data['authenticatorData'] ?? ''));
        $signature = $this->base64UrlDecode((string)($data['signature'] ?? ''));
        $this->verifyWebauthnClientData($data['clientDataJSON'] ?? '', 'webauthn.get', $challenge);
        $this->requireWebauthnUserVerification($authenticatorData);
        $signed = $authenticatorData . hash('sha256', $clientDataJson, true);
        $ok = openssl_verify($signed, $signature, $publicKey, OPENSSL_ALGO_SHA256);
        if ($ok !== 1) throw new RuntimeException('Passkey verification failed');
    }

    private function verifyWebauthnClientData(string $encoded, string $type, string $challenge): array
    {
        if ($challenge === '') throw new RuntimeException('Passkey challenge expired');
        $clientData = json_decode($this->base64UrlDecode($encoded), true) ?: [];
        if (($clientData['type'] ?? '') !== $type) throw new RuntimeException('Invalid passkey response');
        if (!hash_equals($challenge, (string)($clientData['challenge'] ?? ''))) throw new RuntimeException('Invalid passkey challenge');
        if (!hash_equals($this->origin(), (string)($clientData['origin'] ?? ''))) throw new RuntimeException('Invalid passkey origin');
        return $clientData;
    }

    private function requireWebauthnUserVerification(string $authenticatorData): void
    {
        if (strlen($authenticatorData) < 33) throw new RuntimeException('Invalid passkey response');
        $flags = ord($authenticatorData[32]);
        if (($flags & 0x01) !== 0x01 || ($flags & 0x04) !== 0x04) throw new RuntimeException('Biometric or device PIN verification required');
    }

    private function spkiToPem(string $spki): string
    {
        if ($spki === '') return '';
        return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($spki), 64, "\n") . "-----END PUBLIC KEY-----\n";
    }

    private function webauthnChallengeKey(string $purpose, int $userId): string
    {
        return 'webauthn.' . $purpose . '.' . $userId;
    }

    private function saveWebauthnChallenge(string $purpose, int $userId, string $challenge): void
    {
        $this->saveSetting($this->webauthnChallengeKey($purpose, $userId), (string)json_encode(['challenge' => $challenge, 'expires_at' => time() + 300]));
    }

    private function webauthnChallenge(string $purpose, int $userId): string
    {
        $raw = $this->setting($this->webauthnChallengeKey($purpose, $userId));
        $data = json_decode($raw, true);
        if (!is_array($data)) return $raw;
        if ((int)($data['expires_at'] ?? 0) < time()) return '';
        return is_string($data['challenge'] ?? null) ? $data['challenge'] : '';
    }

    private function setting(string $key): string
    {
        $stmt = $this->db->prepare('SELECT value FROM app_settings WHERE key = ?');
        $stmt->execute([$key]);
        return (string)($stmt->fetchColumn() ?: '');
    }

    private function saveSetting(string $key, string $value): void
    {
        $this->db->prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')->execute([$key, $value]);
    }

    private function deleteSetting(string $key): void
    {
        $this->db->prepare('DELETE FROM app_settings WHERE key = ?')->execute([$key]);
    }

    private function base64UrlEncode(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }

    private function base64UrlDecode(string $value): string
    {
        $value = strtr($value, '-_', '+/');
        $padding = strlen($value) % 4;
        if ($padding) $value .= str_repeat('=', 4 - $padding);
        $decoded = base64_decode($value, true);
        if ($decoded === false) throw new RuntimeException('Invalid passkey data');
        return $decoded;
    }

    private function requireAdmin(array $user): void
    {
        if (!in_array($user['role'], ['owner', 'admin'], true)) throw new RuntimeException('Admin required');
    }

    private function requireEditor(array $user): void
    {
        if (!in_array($user['role'], ['owner', 'admin', 'editor'], true)) throw new RuntimeException('Editor required');
    }

    private function isPreviewable(string $mime): bool
    {
        if (in_array($mime, ['image/svg+xml', 'text/html', 'application/xhtml+xml'], true)) return false;
        return str_starts_with($mime, 'image/') || in_array($mime, ['application/pdf', 'text/plain', 'text/markdown'], true);
    }

    private function contentDisposition(string $mode, string $filename): string
    {
        $filename = trim(str_replace(["\r", "\n", '"', '\\'], '_', basename($filename))) ?: 'download';
        $ascii = preg_replace('/[^A-Za-z0-9._-]/', '_', $filename) ?: 'download';
        return $mode . '; filename="' . $ascii . '"; filename*=UTF-8\'\'' . rawurlencode($filename);
    }

    private function cleanAssetType(string $type): string
    {
        $type = strtolower(preg_replace('/[^a-z0-9_-]/', '', $type));
        return $type ?: 'general';
    }

    private function cleanCategoryIcon(string $icon): string
    {
        $icon = trim($icon);
        return substr($icon, 0, 16);
    }

    private function cleanSyncClientId(string $value): string
    {
        return substr(preg_replace('/[^A-Za-z0-9._:-]/', '', trim($value)), 0, 120);
    }

    private function cleanSyncMutationId(string $value): string
    {
        return substr(preg_replace('/[^A-Za-z0-9._:-]/', '', trim($value)), 0, 160);
    }

    private function slugify(string $name): string
    {
        $base = strtolower(trim(preg_replace('/[^a-zA-Z0-9]+/', '-', $name), '-')) ?: 'category';
        $slug = $base;
        $i = 2;
        while (true) {
            $stmt = $this->db->prepare('SELECT COUNT(*) FROM asset_categories WHERE slug = ?');
            $stmt->execute([$slug]);
            if ((int)$stmt->fetchColumn() === 0) return $slug;
            $slug = $base . '-' . $i++;
        }
    }

    private function createUserRow(string $email, string $name, string $password, string $role): int
    {
        $email = strtolower(trim($email));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) throw new RuntimeException('Valid email required');
        if (strlen($password) < 10) throw new RuntimeException('Password must be at least 10 characters');
        if (!in_array($role, ['owner', 'admin', 'editor', 'viewer'], true)) throw new RuntimeException('Invalid role');
        $stmt = $this->db->prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)');
        $stmt->execute([$email, trim($name) ?: $email, password_hash($password, PASSWORD_DEFAULT), $role]);
        return (int)$this->db->lastInsertId();
    }

    private function publicUser(array $user): array
    {
        return ['id' => (int)$user['id'], 'email' => $user['email'], 'name' => $user['name'], 'role' => $user['role'], 'totp_enabled' => (int)$user['totp_enabled'], 'passkey_enabled' => (int)$user['passkey_enabled'], 'avatar_data' => $user['avatar_data'] ?? null];
    }

    private function input(): array
    {
        $raw = file_get_contents('php://input');
        return $raw ? (json_decode($raw, true) ?: []) : $_POST;
    }

    private function json(array $data): void
    {
        echo json_encode($data);
        exit;
    }

    private function origin(): string
    {
        if (Config::appUrl() !== '') return Config::appUrl();
        $scheme = $this->isSecureRequest() ? 'https' : 'http';
        $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
        if (!preg_match('/^[A-Za-z0-9._:-]+$/', $host)) throw new RuntimeException('Invalid host header');
        return $scheme . '://' . $host;
    }

    private function isSecureRequest(): bool
    {
        if (Config::trustProxy()) {
            $forwardedProto = strtolower(trim(explode(',', $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')[0]));
            if ($forwardedProto === 'https') return true;
        }
        return !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
    }

    private function ip(): string
    {
        if (Config::trustProxy() && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
            $ip = trim(explode(',', $_SERVER['HTTP_X_FORWARDED_FOR'])[0]);
            if (filter_var($ip, FILTER_VALIDATE_IP)) return $ip;
        }
        $ip = $_SERVER['REMOTE_ADDR'] ?? '';
        return filter_var($ip, FILTER_VALIDATE_IP) ? $ip : '';
    }

    private function cookieOptions(int $expires): array
    {
        return ['expires' => $expires, 'path' => '/', 'secure' => Config::secureCookies(), 'httponly' => true, 'samesite' => 'Lax'];
    }

    private function setCsrfCookie(): void
    {
        setcookie('divault_csrf', bin2hex(random_bytes(24)), ['expires' => time() + 2592000, 'path' => '/', 'secure' => Config::secureCookies(), 'httponly' => false, 'samesite' => 'Lax']);
    }

    private function checkRateLimit(string $bucket, int $limit, int $seconds): void
    {
        $stmt = $this->db->prepare('SELECT attempts, reset_at FROM rate_limits WHERE bucket = ?');
        $stmt->execute([$bucket]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row && strtotime($row['reset_at']) > time() && (int)$row['attempts'] >= $limit) {
            throw new RuntimeException('Too many attempts. Try again later.');
        }
        if ($row && strtotime($row['reset_at']) <= time()) {
            $this->db->prepare('DELETE FROM rate_limits WHERE bucket = ?')->execute([$bucket]);
        }
    }

    private function hitRateLimit(string $bucket, int $seconds): void
    {
        $reset = gmdate('Y-m-d H:i:s', time() + $seconds);
        $this->db->prepare('INSERT INTO rate_limits (bucket, attempts, reset_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1, reset_at = excluded.reset_at')->execute([$bucket, $reset]);
    }

    private function generateRecoveryCodes(int $userId): array
    {
        $this->db->prepare('DELETE FROM recovery_codes WHERE user_id = ?')->execute([$userId]);
        $codes = [];
        for ($i = 0; $i < 10; $i++) {
            $code = strtoupper(substr(chunk_split(bin2hex(random_bytes(5)), 5, '-'), 0, 11));
            $codes[] = $code;
            $this->db->prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)')->execute([$userId, password_hash($code, PASSWORD_DEFAULT)]);
        }
        return $codes;
    }

    private function consumeRecoveryCode(int $userId, string $code): bool
    {
        $stmt = $this->db->prepare('SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL');
        $stmt->execute([$userId]);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            if (password_verify(strtoupper(trim($code)), $row['code_hash'])) {
                $this->db->prepare('UPDATE recovery_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([(int)$row['id']]);
                return true;
            }
        }
        return false;
    }

    private function pruneBackups(int $keep): void
    {
        $files = glob(Config::dir() . '/backups/backup-*.zip') ?: [];
        rsort($files);
        foreach (array_slice($files, $keep) as $file) {
            @unlink($file);
        }
    }

    private function seedOwnerIfNeeded(): void
    {
        $email = getenv('SEED_ADMIN_EMAIL');
        $password = getenv('SEED_ADMIN_PASSWORD');
        if ($email && $password && (int)$this->db->query('SELECT COUNT(*) FROM users')->fetchColumn() === 0) {
            $this->createUserRow($email, 'Owner', $password, 'owner');
        }
    }
}
