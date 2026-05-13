<?php

final class App
{
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
        $path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/';
        if (!str_starts_with($path, '/api')) {
            $shell = rtrim($_SERVER['DOCUMENT_ROOT'] ?? '', '/\\') . '/app.html';
            if (!is_file($shell)) $shell = dirname(__DIR__) . '/public/app.html';
            require $shell;
            return;
        }

        header('Content-Type: application/json');
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
        if ($method === 'POST' && $path === '/logout') $this->logout();
        if ($method === 'POST' && $path === '/integrations/ai/review-notes') $this->createAiReviewNote();

        $user = $this->requireUser();
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
        if ($method === 'GET' && preg_match('#^/sync/files/(\d+)$#', $path, $m)) $this->downloadFile($user, (int)$m[1]);
        if ($method === 'GET' && $path === '/integrations/ai/status') $this->aiReviewStatus($user);
        if ($method === 'POST' && $path === '/integrations/ai/enable') $this->enableAiReviewApi($user);
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
        $this->json(['server_url' => $this->desktopServerUrl()]);
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
        $token = bin2hex(random_bytes(32));
        $stmt = $this->db->prepare('INSERT INTO sessions (user_id, token_hash, user_agent, ip, expires_at) VALUES (?, ?, ?, ?, datetime("now", "+30 days"))');
        $stmt->execute([(int)$user['id'], hash('sha256', $token), $_SERVER['HTTP_USER_AGENT'] ?? '', $this->ip()]);
        setcookie('divault_session', $token, $this->cookieOptions(time() + 2592000));
        $this->setCsrfCookie();
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
        $snapshot = $since === 0 ? $this->syncSnapshot() : null;
        $stmt = $this->db->prepare('SELECT * FROM sync_events WHERE id > ? ORDER BY id ASC LIMIT ?');
        $stmt->bindValue(1, $since, PDO::PARAM_INT);
        $stmt->bindValue(2, $limit + 1, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $hasMore = count($rows) > $limit;
        $rows = array_slice($rows, 0, $limit);
        $events = [];
        foreach ($rows as $event) {
            $events[] = $this->syncEventPayload($event);
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

    private function syncSnapshot(): array
    {
        return [
            'categories' => $this->db->query('SELECT id, parent_id, name, icon, slug, created_at FROM asset_categories ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'clients' => $this->db->query('SELECT * FROM clients ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'notes' => $this->db->query('SELECT * FROM notes ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'assets' => $this->db->query('SELECT id, user_id, client_id, type, name, status, asset_type, os, primary_ip, serial_number, expires_at, location, contact, username, notes, data_json, archived, created_at, updated_at FROM asset_records ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'files' => array_map(fn ($row) => $this->syncFilePayload($row), $this->db->query('SELECT id, note_id, user_id, original_name, mime, size, created_at FROM files ORDER BY id')->fetchAll(PDO::FETCH_ASSOC)),
        ];
    }

    private function syncEventPayload(array $event): array
    {
        $type = (string)$event['entity_type'];
        $id = isset($event['entity_id']) ? (int)$event['entity_id'] : null;
        $row = $id ? $this->syncEntityRow($type, $id) : null;
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

    private function syncEntityRow(string $type, int $id): ?array
    {
        $queries = [
            'note' => 'SELECT * FROM notes WHERE id = ?',
            'category' => 'SELECT id, parent_id, name, icon, slug, created_at FROM asset_categories WHERE id = ?',
            'asset' => 'SELECT id, user_id, client_id, type, name, status, asset_type, os, primary_ip, serial_number, expires_at, location, contact, username, notes, data_json, archived, created_at, updated_at FROM asset_records WHERE id = ?',
            'client' => 'SELECT * FROM clients WHERE id = ?',
            'file' => 'SELECT id, note_id, user_id, original_name, mime, size, created_at FROM files WHERE id = ?',
        ];
        if (empty($queries[$type])) return null;
        $stmt = $this->db->prepare($queries[$type]);
        $stmt->execute([$id]);
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
        $sql = 'SELECT n.*, ac.name AS category_name, ac.slug AS category_slug, c.name AS client_name, (SELECT COUNT(*) FROM files f WHERE f.note_id = n.id) AS file_count, (SELECT COUNT(*) FROM note_secrets s WHERE s.note_id = n.id) AS secret_count FROM notes n LEFT JOIN asset_categories ac ON ac.id = n.category_id LEFT JOIN clients c ON c.id = n.client_id WHERE ' . implode(' AND ', $where) . ' ORDER BY n.pinned DESC, n.updated_at DESC LIMIT 200';
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

    private function disableAiReviewApi(array $user): void
    {
        $this->requireAdmin($user);
        if (Config::aiReviewApiToken() !== '') throw new RuntimeException('AI API is configured by environment variable');
        $path = $this->aiReviewTokenPath();
        if (is_file($path)) unlink($path);
        $this->audit((int)$user['id'], 'integration.ai_review_disabled', 'integration', null);
        $this->json(['enabled' => false]);
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
        $this->audit((int)$user['id'], 'file.downloaded', 'file', $id);
        header_remove('Content-Type');
        header('Content-Type: ' . ($file['mime'] ?: 'application/octet-stream'));
        $mode = $inline && $this->isPreviewable($file['mime'] ?? '') ? 'inline' : 'attachment';
        header('Content-Disposition: ' . $this->contentDisposition($mode, $file['original_name']));
        header('X-Content-Type-Options: nosniff');
        readfile(Config::dir() . '/files/' . $file['stored_name']);
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
        $this->audit((int)$user['id'], 'export.created', 'export', null);
        $data = [
            'exported_at' => gmdate('c'),
            'notes' => $this->db->query('SELECT * FROM notes WHERE deleted = 0 ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'assets' => $this->db->query('SELECT id, client_id, type, name, status, asset_type, os, primary_ip, serial_number, expires_at, location, contact, username, notes, data_json, archived, created_at, updated_at FROM asset_records ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'clients' => $this->db->query('SELECT * FROM clients ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
            'files' => $this->db->query('SELECT id, note_id, original_name, mime, size, created_at FROM files ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
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
        foreach ($data['notes'] as $note) {
            $this->db->prepare('INSERT INTO notes (user_id, title, body, type, section, category, tags) VALUES (?, ?, ?, ?, ?, ?, ?)')->execute([(int)$user['id'], $note['title'] ?? 'Imported note', $note['body'] ?? '', $note['type'] ?? 'text', $note['section'] ?? 'Imported', $note['category'] ?? null, $note['tags'] ?? null]);
            $count++;
        }
        $this->audit((int)$user['id'], 'import.completed', 'import', null);
        $this->json(['imported' => $count]);
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
        if (empty($_SERVER['HTTP_HOST'])) return Config::appUrl() ?: 'http://localhost';
        $forwardedProto = Config::trustProxy() ? strtolower(trim(explode(',', $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')[0])) : '';
        $scheme = in_array($forwardedProto, ['http', 'https'], true) ? $forwardedProto : ((!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http');
        $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
        return $scheme . '://' . $host;
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
