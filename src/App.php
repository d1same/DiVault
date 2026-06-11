<?php

final class App
{
    private const ICS_IMPORT_MAX_BYTES = 5242880;
    private const ICS_IMPORT_MAX_EVENTS = 10000;
    private const ICS_FEED_MAX_EVENTS = 5000;

    private PDO $db;
    private Crypto $crypto;
    private ?array $inputOverride = null;

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
            $status = $clientError ? 400 : 500;
            $method = $_SERVER['REQUEST_METHOD'] ?? 'unknown';
            error_log(sprintf('[DiVault] API error method=%s path=%s status=%d class=%s message=%s', $method, $this->logSafePath($path), $status, get_class($e), $e->getMessage()));
            if (!$clientError && strtolower((string)(getenv('DIVAULT_LOG_LEVEL') ?: 'info')) === 'debug') {
                error_log($e->getTraceAsString());
            }
            http_response_code($status);
            echo json_encode(['error' => $clientError ? $e->getMessage() : 'Unexpected server error']);
        }
    }

    private function logSafePath(string $path): string
    {
        return preg_replace('#^/api/integrations/onlyoffice/(download|callback)/[^/]+$#', '/api/integrations/onlyoffice/$1/[redacted]', $path) ?? $path;
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
        if ($method === 'POST' && in_array($path, ['/integrations/ai/review-notes', '/integrations/ai/review-notes/'], true)) $this->createAiReviewNote();
        if ($path === '/integrations/assistant' || str_starts_with($path, '/integrations/assistant/')) $this->routeAssistantApi($method, $path);
        if ($method === 'GET' && preg_match('#^/integrations/onlyoffice/download/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$#', $path, $m)) $this->onlyOfficeDownloadSigned($m[1]);
        if ($method === 'POST' && preg_match('#^/integrations/onlyoffice/callback/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$#', $path, $m)) $this->onlyOfficeCallback($m[1]);

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
        if ($method === 'GET' && $path === '/search') $this->globalSearch($user);
        if ($method === 'GET' && $path === '/home-summary') $this->homeSummary($user);
        if ($method === 'GET' && preg_match('#^/sync/files/(\d+)$#', $path, $m)) $this->downloadFile($user, (int)$m[1]);
        if ($method === 'GET' && $path === '/drive/storage-settings') $this->driveStorageSettings($user);
        if ($method === 'POST' && $path === '/drive/storage-settings') $this->saveDriveStorageSettings($user);
        if (str_starts_with($path, '/drive')) $this->requireFeatureEnabled($user, 'drive', 'Files are disabled');
        if ($method === 'POST' && $path === '/drive/source-sync') $this->driveSyncSources($user);
        if ($method === 'GET' && in_array($path, ['/drive', '/drive/folders', '/drive/files'], true)) $this->driveList($user);
        if ($method === 'GET' && $path === '/drive/folders/tree') $this->driveFolderTree($user);
        if ($method === 'POST' && $path === '/drive/zip') $this->driveZipSelection($user);
        if ($method === 'POST' && $path === '/drive/folders') $this->driveCreateFolder($user);
        if ($method === 'POST' && preg_match('#^/drive/folders/(\d+)/zip$#', $path, $m)) $this->driveZipFolder($user, (int)$m[1]);
        if ($method === 'PATCH' && preg_match('#^/drive/folders/(\d+)$#', $path, $m)) $this->driveUpdateFolder($user, (int)$m[1]);
        if ($method === 'DELETE' && preg_match('#^/drive/folders/(\d+)$#', $path, $m)) $this->driveDeleteFolder($user, (int)$m[1]);
        if ($method === 'POST' && $path === '/drive/files') $this->driveUploadFile($user);
        if ($method === 'POST' && $path === '/drive/files/upload') $this->driveUploadFile($user);
        if ($method === 'POST' && preg_match('#^/drive/files/(\d+)/zip$#', $path, $m)) $this->driveZipFile($user, (int)$m[1]);
        if ($method === 'POST' && preg_match('#^/drive/files/(\d+)/extract$#', $path, $m)) $this->driveExtractZipFile($user, (int)$m[1]);
        if ($method === 'PATCH' && preg_match('#^/drive/files/(\d+)/content$#', $path, $m)) $this->driveUpdateFileContent($user, (int)$m[1]);
        if ($method === 'PATCH' && preg_match('#^/drive/files/(\d+)$#', $path, $m)) $this->driveUpdateFile($user, (int)$m[1]);
        if ($method === 'DELETE' && preg_match('#^/drive/files/(\d+)$#', $path, $m)) $this->driveDeleteFile($user, (int)$m[1]);
        if ($method === 'GET' && preg_match('#^/drive/files/(\d+)/metadata$#', $path, $m)) $this->driveFileMetadata($user, (int)$m[1]);
        if ($method === 'GET' && preg_match('#^/drive/files/(\d+)/office$#', $path, $m)) $this->driveOnlyOfficeConfig($user, (int)$m[1]);
        if ($method === 'GET' && preg_match('#^/drive/files/(\d+)$#', $path, $m)) $this->driveDownloadFile($user, (int)$m[1], false);
        if ($method === 'GET' && preg_match('#^/drive/files/(\d+)/(download|preview)$#', $path, $m)) $this->driveDownloadFile($user, (int)$m[1], $m[2] === 'preview');
        if ($method === 'GET' && preg_match('#^/drive/(folders|files)/(\d+)/shares$#', $path, $m)) $this->driveListShares($user, $m[1], (int)$m[2]);
        if ($method === 'POST' && preg_match('#^/drive/(folders|files)/(\d+)/shares$#', $path, $m)) $this->driveShare($user, $m[1], (int)$m[2]);
        if ($method === 'DELETE' && preg_match('#^/drive/(folders|files)/(\d+)/shares/(\d+)$#', $path, $m)) $this->driveUnshare($user, $m[1], (int)$m[2], (int)$m[3]);
        if ($method === 'GET' && $path === '/integrations/ai/status') $this->aiReviewStatus($user);
        if ($method === 'POST' && $path === '/integrations/ai/enable') $this->enableAiReviewApi($user);
        if ($method === 'POST' && $path === '/integrations/ai/reveal') $this->revealAiReviewApiToken($user);
        if ($method === 'POST' && $path === '/integrations/ai/test') $this->testAiReviewApiToken($user);
        if ($method === 'POST' && $path === '/integrations/ai/disable') $this->disableAiReviewApi($user);
        if ($method === 'GET' && $path === '/integrations/onlyoffice/status') $this->onlyOfficeStatus($user);
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
        if ($method === 'PATCH' && preg_match('#^/users/(\d+)$#', $path, $m)) $this->updateUserAdmin($user, (int)$m[1]);
        if ($method === 'DELETE' && preg_match('#^/users/(\d+)$#', $path, $m)) $this->deleteUserAdmin($user, (int)$m[1]);
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

    private function routeAssistantApi(string $method, string $path): void
    {
        $assistantPath = substr($path, strlen('/integrations/assistant')) ?: '/';
        $assistantPath = rtrim($assistantPath, '/') ?: '/';
        $user = $this->requireAssistantUser();

        if ($method === 'GET' && in_array($assistantPath, ['/', '/status'], true)) $this->assistantStatus($user);
        if ($method === 'GET' && $assistantPath === '/me') $this->json(['user' => $this->publicUser($user)]);
        if ($method === 'GET' && $assistantPath === '/daily') $this->assistantDailySummary($user);

        if ($method === 'GET' && $assistantPath === '/notes') $this->listNotes($user);
        if ($method === 'POST' && $assistantPath === '/notes') $this->saveNote($user);
        if ($method === 'GET' && preg_match('#^/notes/(\d+)$#', $assistantPath, $m)) $this->getNote($user, (int)$m[1]);
        if ($method === 'PUT' && preg_match('#^/notes/(\d+)$#', $assistantPath, $m)) $this->saveNote($user, (int)$m[1]);
        if ($method === 'PATCH' && preg_match('#^/notes/(\d+)$#', $assistantPath, $m)) $this->patchAssistantNote($user, (int)$m[1]);
        if ($method === 'DELETE' && preg_match('#^/notes/(\d+)$#', $assistantPath, $m)) $this->deleteNote($user, (int)$m[1]);

        if ($method === 'GET' && $assistantPath === '/calendars') $this->listCalendars($user);
        if ($method === 'POST' && $assistantPath === '/calendars') $this->saveCalendar($user);
        if ($method === 'PUT' && preg_match('#^/calendars/(\d+)$#', $assistantPath, $m)) $this->saveCalendar($user, (int)$m[1]);
        if ($method === 'PATCH' && preg_match('#^/calendars/(\d+)$#', $assistantPath, $m)) $this->patchAssistantCalendar($user, (int)$m[1]);
        if ($method === 'DELETE' && preg_match('#^/calendars/(\d+)$#', $assistantPath, $m)) $this->deleteCalendar($user, (int)$m[1]);

        if ($method === 'GET' && $assistantPath === '/events') $this->listEvents($user);
        if ($method === 'POST' && $assistantPath === '/events') $this->saveEvent($user);
        if ($method === 'GET' && preg_match('#^/events/(\d+)$#', $assistantPath, $m)) $this->getEvent($user, (int)$m[1]);
        if ($method === 'PUT' && preg_match('#^/events/(\d+)$#', $assistantPath, $m)) $this->saveEvent($user, (int)$m[1]);
        if ($method === 'PATCH' && preg_match('#^/events/(\d+)$#', $assistantPath, $m)) $this->patchAssistantEvent($user, (int)$m[1]);
        if ($method === 'DELETE' && preg_match('#^/events/(\d+)$#', $assistantPath, $m)) $this->deleteEvent($user, (int)$m[1]);

        if ($method === 'GET' && $assistantPath === '/tasks') $this->listTasks($user);
        if ($method === 'POST' && $assistantPath === '/tasks') $this->saveTask($user);
        if ($method === 'GET' && preg_match('#^/tasks/(\d+)$#', $assistantPath, $m)) $this->getTask($user, (int)$m[1]);
        if ($method === 'PUT' && preg_match('#^/tasks/(\d+)$#', $assistantPath, $m)) $this->saveTask($user, (int)$m[1]);
        if ($method === 'PATCH' && preg_match('#^/tasks/(\d+)$#', $assistantPath, $m)) $this->patchAssistantTask($user, (int)$m[1]);
        if ($method === 'DELETE' && preg_match('#^/tasks/(\d+)$#', $assistantPath, $m)) $this->deleteTask($user, (int)$m[1]);

        throw new RuntimeException('Assistant API route not found');
    }

    private function assistantStatus(array $user): void
    {
        $this->json([
            'ok' => true,
            'user' => $this->publicUser($user),
            'endpoints' => [
                '/integrations/assistant/daily',
                '/integrations/assistant/notes',
                '/integrations/assistant/calendars',
                '/integrations/assistant/events',
                '/integrations/assistant/tasks',
            ],
        ]);
    }

    private function patchAssistantNote(array $user, int $id): void
    {
        $current = $this->note($id, $user);
        $data = $this->input();
        $merged = array_merge([
            'client_id' => $current['client_id'] ?? null,
            'body' => $current['body'] ?? '',
            'title' => $current['title'] ?? 'Quick note',
            'type' => $current['type'] ?? 'text',
            'section' => $current['section'] ?? 'All',
            'category_id' => $current['category_id'] ?? null,
            'category' => $current['category'] ?? null,
            'tags' => $current['tags'] ?? null,
            'pinned' => (int)($current['pinned'] ?? 0),
            'archived' => (int)($current['archived'] ?? 0),
        ], $data);
        $this->withInput($merged, fn() => $this->saveNote($user, $id));
    }

    private function patchAssistantCalendar(array $user, int $id): void
    {
        $current = $this->calendarAccess($user, $id, 'admin');
        $data = $this->input();
        $merged = array_merge([
            'name' => $current['name'] ?? 'Calendar',
            'color' => $current['color'] ?? '#635bff',
            'description' => $current['description'] ?? null,
        ], $data);
        $this->withInput($merged, fn() => $this->saveCalendar($user, $id));
    }

    private function patchAssistantEvent(array $user, int $id): void
    {
        $current = $this->eventAccess($user, $id, 'edit');
        $data = $this->input();
        $merged = array_merge([
            'calendar_id' => $current['calendar_id'] ?? null,
            'title' => $current['title'] ?? 'Untitled event',
            'starts_at' => $current['starts_at'] ?? gmdate('Y-m-d H:i:s'),
            'ends_at' => $current['ends_at'] ?? ($current['starts_at'] ?? gmdate('Y-m-d H:i:s')),
            'all_day' => (int)($current['all_day'] ?? 0),
            'description' => $current['description'] ?? '',
            'location' => $current['location'] ?? '',
            'recurrence_rule' => $current['recurrence_rule'] ?? null,
            'reminder_minutes' => $this->eventReminderMinutes($user, $id) ?? -1,
            'note_ids' => array_map(fn($note) => (int)$note['id'], $this->linkedNotes('event', $id, $user)),
        ], $data);
        $this->withInput($merged, fn() => $this->saveEvent($user, $id));
    }

    private function patchAssistantTask(array $user, int $id): void
    {
        $current = $this->taskAccess($user, $id, 'edit');
        $data = $this->input();
        $merged = array_merge([
            'calendar_id' => $current['calendar_id'] ?? null,
            'shared' => empty($current['private']),
            'title' => $current['title'] ?? 'Untitled task',
            'description' => $current['description'] ?? '',
            'location' => $current['location'] ?? '',
            'status' => $current['status'] ?? 'open',
            'priority' => (int)($current['priority'] ?? 0),
            'due_at' => $current['due_at'] ?? null,
            'reminder_minutes' => $this->taskReminderMinutes($user, $id) ?? -1,
            'note_ids' => array_map(fn($note) => (int)$note['id'], $this->linkedNotes('task', $id, $user)),
        ], $data);
        $this->withInput($merged, fn() => $this->saveTask($user, $id));
    }

    private function withInput(array $data, callable $callback): void
    {
        $previous = $this->inputOverride;
        $this->inputOverride = $data;
        try {
            $callback();
        } finally {
            $this->inputOverride = $previous;
        }
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
            $current = $id > 0 ? $this->noteOrNull($id, $user) : null;
            if ($current && $baseUpdatedAt !== '' && (string)$current['updated_at'] !== $baseUpdatedAt) {
                $this->db->rollBack();
                return ['status' => 'conflict', 'entity_type' => 'note', 'entity_id' => $id, 'server' => $current];
            }

            if ($action === 'delete') {
                if (!$current) throw new RuntimeException('Note not found');
                $this->db->prepare('UPDATE notes SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')->execute([$id, (int)$user['id']]);
                $this->audit((int)$user['id'], 'note.deleted', 'note', $id);
            } elseif ($action === 'archive') {
                if (!$current) throw new RuntimeException('Note not found');
                $this->db->prepare('UPDATE notes SET archived = 1, deleted = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')->execute([$id, (int)$user['id']]);
                $this->audit((int)$user['id'], 'note.archived', 'note', $id);
            } elseif ($action === 'restore') {
                if (!$current) throw new RuntimeException('Note not found');
                $this->db->prepare('UPDATE notes SET archived = 0, deleted = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')->execute([$id, (int)$user['id']]);
                $this->audit((int)$user['id'], 'note.restored', 'note', $id);
            } elseif ($action === 'upsert') {
                $id = $this->upsertNoteFromSync($user, $record, $current);
            } else {
                throw new RuntimeException('Unsupported note sync action');
            }

            $fresh = $this->noteOrNull($id, $user);
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
            $stmt = $this->db->prepare('UPDATE notes SET title=?, body=?, type=?, section=?, category_id=?, category=?, tags=?, client_id=?, pinned=?, archived=?, deleted=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?');
            $stmt->execute([$fields['title'], $fields['body'], $fields['type'], $fields['section'], $fields['category_id'], $fields['category'], $fields['tags'], $fields['client_id'], $fields['pinned'], $fields['archived'], $fields['deleted'], $id, (int)$user['id']]);
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

    private function globalSearch(array $user): void
    {
        $q = trim((string)($_GET['q'] ?? ''));
        $limit = min(12, max(3, (int)($_GET['limit'] ?? 6)));
        if ($q === '') {
            $this->json(['query' => '', 'results' => [], 'total' => 0]);
        }

        $like = '%' . $q . '%';
        $groups = [
            'notes' => $this->searchNotes($user, $q, $like, $limit),
            'events' => $this->searchEvents($user, $like, $limit),
            'tasks' => $this->searchTasks($user, $like, $limit),
            'drive' => $this->searchDrive($user, $like, $limit),
            'assets' => $this->searchAssets($user, $like, $limit),
            'clients' => $this->searchClients($user, $like, $limit),
        ];
        $results = [];
        foreach ($groups as $items) {
            foreach ($items as $item) $results[] = $item;
        }
        $this->json(['query' => $q, 'groups' => $groups, 'results' => $results, 'total' => count($results)]);
    }

    private function homeSummary(array $user): void
    {
        $recentFiles = [];
        $stmt = $this->db->query('SELECT id FROM drive_files WHERE deleted = 0 ORDER BY updated_at DESC, id DESC LIMIT 60');
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $id) {
            try {
                $file = $this->driveFileAccess($user, (int)$id, 'view');
            } catch (RuntimeException) {
                continue;
            }
            $recentFiles[] = [
                'id' => (int)$file['id'],
                'folder_id' => $file['folder_id'] === null ? null : (int)$file['folder_id'],
                'original_name' => (string)$file['original_name'],
                'mime' => (string)($file['mime'] ?? ''),
                'size' => (int)($file['size'] ?? 0),
                'updated_at' => (string)($file['updated_at'] ?? $file['created_at'] ?? ''),
            ];
            if (count($recentFiles) >= 6) break;
        }

        $backup = null;
        $backupCount = null;
        if (in_array((string)($user['role'] ?? ''), ['owner', 'admin'], true)) {
            $backups = [];
            foreach (glob(Config::dir() . '/backups/backup-*.zip') ?: [] as $file) {
                $backups[] = ['file' => basename($file), 'size' => filesize($file), 'created_at' => date('c', filemtime($file))];
            }
            usort($backups, fn ($a, $b) => strcmp($b['created_at'], $a['created_at']));
            $backup = $backups[0] ?? null;
            $backupCount = count($backups);
        }

        $this->json(['recent_drive_files' => $recentFiles, 'latest_backup' => $backup, 'backup_count' => $backupCount]);
    }

    private function searchNotes(array $user, string $q, string $like, int $limit): array
    {
        $where = ['n.user_id = ?', 'n.deleted = 0'];
        $args = [(int)$user['id']];
        $ftsQuery = $this->noteFtsQuery($q);
        if ($ftsQuery !== null && $this->notesFtsAvailable()) {
            $where[] = '(n.id IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?) OR ns.label LIKE ? OR ac.name LIKE ? OR c.name LIKE ?)';
            array_push($args, $ftsQuery, $like, $like, $like);
        } else {
            $where[] = '(n.title LIKE ? OR n.body LIKE ? OR n.tags LIKE ? OR ns.label LIKE ? OR ac.name LIKE ? OR c.name LIKE ?)';
            array_push($args, $like, $like, $like, $like, $like, $like);
        }
        $stmt = $this->db->prepare('SELECT DISTINCT n.id, n.title, n.body, n.tags, n.pinned, n.updated_at, ac.name AS category_name, c.name AS client_name FROM notes n LEFT JOIN asset_categories ac ON ac.id = n.category_id LEFT JOIN clients c ON c.id = n.client_id LEFT JOIN note_secrets ns ON ns.note_id = n.id WHERE ' . implode(' AND ', $where) . ' ORDER BY n.pinned DESC, n.updated_at DESC, n.id DESC LIMIT ' . $limit);
        $stmt->execute($args);
        return array_map(fn ($row) => [
            'type' => 'note',
            'id' => (int)$row['id'],
            'title' => (string)($row['title'] ?: 'Untitled note'),
            'subtitle' => trim(implode(' / ', array_filter([(string)($row['category_name'] ?? ''), (string)($row['client_name'] ?? '')]))) ?: 'Note',
            'snippet' => $this->searchSnippet((string)($row['body'] ?? ''), $q),
            'updated_at' => (string)($row['updated_at'] ?? ''),
            'pinned' => (int)($row['pinned'] ?? 0),
        ], $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    private function searchEvents(array $user, string $like, int $limit): array
    {
        $rangeStart = gmdate('Y-m-d 00:00:00', strtotime('-2 years') ?: time());
        $rangeEnd = gmdate('Y-m-d 23:59:59', strtotime('+5 years') ?: time());
        $stmt = $this->db->prepare('SELECT e.*, c.name AS calendar_name, c.color AS calendar_color FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id LEFT JOIN calendar_shares s ON s.calendar_id = c.id AND s.user_id = ? WHERE c.archived = 0 AND (c.owner_user_id = ? OR s.user_id = ?) AND ((e.recurrence_rule IS NULL AND e.starts_at <= ? AND COALESCE(e.ends_at, e.starts_at) >= ?) OR (e.recurrence_rule IS NOT NULL AND e.starts_at <= ?)) AND (e.title LIKE ? OR e.description LIKE ? OR e.location LIKE ? OR c.name LIKE ?) ORDER BY e.starts_at ASC LIMIT 120');
        $stmt->execute([(int)$user['id'], (int)$user['id'], (int)$user['id'], $rangeEnd, $rangeStart, $rangeEnd, $like, $like, $like, $like]);
        $events = $this->expandRecurringEvents($stmt->fetchAll(PDO::FETCH_ASSOC), $rangeStart, $rangeEnd);
        $now = time();
        usort($events, function ($a, $b) use ($now) {
            $left = strtotime((string)($a['starts_at'] ?? '')) ?: 0;
            $right = strtotime((string)($b['starts_at'] ?? '')) ?: 0;
            $leftFuture = $left >= $now;
            $rightFuture = $right >= $now;
            if ($leftFuture !== $rightFuture) return $leftFuture ? -1 : 1;
            return $leftFuture ? ($left <=> $right) : ($right <=> $left);
        });
        $events = array_slice($events, 0, $limit);
        return array_map(fn ($row) => [
            'type' => 'event',
            'id' => (int)$row['id'],
            'series_id' => isset($row['series_id']) ? (int)$row['series_id'] : null,
            'title' => (string)($row['title'] ?: 'Untitled event'),
            'subtitle' => trim(implode(' / ', array_filter([(string)($row['calendar_name'] ?? ''), (string)($row['location'] ?? '')]))) ?: 'Event',
            'snippet' => $this->searchSnippet((string)($row['description'] ?? ''), ''),
            'starts_at' => (string)($row['starts_at'] ?? ''),
            'updated_at' => (string)($row['updated_at'] ?? $row['starts_at'] ?? ''),
        ], $events);
    }

    private function searchTasks(array $user, string $like, int $limit): array
    {
        $where = ['(t.user_id = ? OR (t.private = 0 AND t.calendar_id IN (SELECT c.id FROM calendars c LEFT JOIN calendar_shares s ON s.calendar_id = c.id AND s.user_id = ? WHERE c.archived = 0 AND (c.owner_user_id = ? OR s.user_id = ?))))', '(t.title LIKE ? OR t.description LIKE ? OR t.location LIKE ? OR c.name LIKE ?)'];
        $args = [(int)$user['id'], (int)$user['id'], (int)$user['id'], (int)$user['id'], $like, $like, $like, $like];
        $stmt = $this->db->prepare('SELECT t.*, c.name AS calendar_name FROM tasks t LEFT JOIN calendars c ON c.id = t.calendar_id WHERE ' . implode(' AND ', $where) . ' ORDER BY CASE WHEN t.status = \'done\' THEN 1 ELSE 0 END, t.due_at IS NULL, t.due_at ASC, t.priority DESC, t.id DESC LIMIT ' . $limit);
        $stmt->execute($args);
        return array_map(fn ($row) => [
            'type' => 'task',
            'id' => (int)$row['id'],
            'title' => (string)($row['title'] ?: 'Untitled task'),
            'subtitle' => trim(implode(' / ', array_filter([(string)($row['status'] ?? ''), (string)($row['calendar_name'] ?? '')]))) ?: 'Task',
            'snippet' => $this->searchSnippet((string)($row['description'] ?? ''), ''),
            'due_at' => (string)($row['due_at'] ?? ''),
            'updated_at' => (string)($row['updated_at'] ?? ''),
        ], $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    private function searchDrive(array $user, string $like, int $limit): array
    {
        $items = [];
        $folderStmt = $this->db->prepare('SELECT id FROM drive_folders WHERE deleted = 0 AND name LIKE ? ORDER BY updated_at DESC, name COLLATE NOCASE LIMIT 80');
        $folderStmt->execute([$like]);
        foreach ($folderStmt->fetchAll(PDO::FETCH_COLUMN) as $id) {
            try {
                $folder = $this->driveFolderAccess($user, (int)$id, 'view');
            } catch (RuntimeException) {
                continue;
            }
            $items[] = [
                'type' => 'drive_folder',
                'id' => (int)$folder['id'],
                'title' => (string)$folder['name'],
                'subtitle' => 'Drive folder',
                'snippet' => $this->drivePathLabel($user, (int)$folder['id']),
                'updated_at' => (string)($folder['updated_at'] ?? $folder['created_at'] ?? ''),
            ];
            if (count($items) >= $limit) return $items;
        }
        $fileStmt = $this->db->prepare('SELECT id FROM drive_files WHERE deleted = 0 AND (original_name LIKE ? OR mime LIKE ?) ORDER BY updated_at DESC, original_name COLLATE NOCASE LIMIT 80');
        $fileStmt->execute([$like, $like]);
        foreach ($fileStmt->fetchAll(PDO::FETCH_COLUMN) as $id) {
            try {
                $file = $this->driveFileAccess($user, (int)$id, 'view');
            } catch (RuntimeException) {
                continue;
            }
            $items[] = [
                'type' => 'drive_file',
                'id' => (int)$file['id'],
                'folder_id' => $file['folder_id'] === null ? null : (int)$file['folder_id'],
                'title' => (string)$file['original_name'],
                'subtitle' => trim((string)($file['mime'] ?? '')) ?: 'Drive file',
                'snippet' => $this->drivePathLabel($user, $file['folder_id'] === null ? null : (int)$file['folder_id']),
                'mime' => (string)($file['mime'] ?? ''),
                'size' => (int)($file['size'] ?? 0),
                'updated_at' => (string)($file['updated_at'] ?? $file['created_at'] ?? ''),
            ];
            if (count($items) >= $limit) break;
        }
        return $items;
    }

    private function searchAssets(array $user, string $like, int $limit): array
    {
        $stmt = $this->db->prepare('SELECT a.id, a.name, a.type, a.status, a.asset_type, a.primary_ip, a.serial_number, a.location, a.contact, a.username, a.notes, a.updated_at, c.name AS client_name FROM asset_records a LEFT JOIN clients c ON c.id = a.client_id WHERE a.user_id = ? AND a.archived = 0 AND (a.name LIKE ? OR a.status LIKE ? OR a.asset_type LIKE ? OR a.primary_ip LIKE ? OR a.serial_number LIKE ? OR a.location LIKE ? OR a.contact LIKE ? OR a.username LIKE ? OR a.notes LIKE ? OR c.name LIKE ?) ORDER BY a.updated_at DESC, a.name LIMIT ' . $limit);
        $stmt->execute([(int)$user['id'], $like, $like, $like, $like, $like, $like, $like, $like, $like, $like]);
        return array_map(fn ($row) => [
            'type' => 'asset',
            'id' => (int)$row['id'],
            'asset_type' => (string)($row['type'] ?? ''),
            'title' => (string)($row['name'] ?: 'Untitled asset'),
            'subtitle' => trim(implode(' / ', array_filter([(string)($row['type'] ?? ''), (string)($row['client_name'] ?? '')]))) ?: 'Asset',
            'snippet' => $this->searchSnippet((string)($row['notes'] ?? ''), ''),
            'updated_at' => (string)($row['updated_at'] ?? ''),
        ], $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    private function searchClients(array $user, string $like, int $limit): array
    {
        $stmt = $this->db->prepare('SELECT DISTINCT c.id, c.name, c.notes, c.created_at FROM clients c WHERE (c.name LIKE ? OR c.notes LIKE ?) AND (EXISTS (SELECT 1 FROM notes n WHERE n.client_id = c.id AND n.user_id = ? AND n.deleted = 0) OR EXISTS (SELECT 1 FROM asset_records a WHERE a.client_id = c.id AND a.user_id = ? AND a.archived = 0)) ORDER BY c.name COLLATE NOCASE LIMIT ' . $limit);
        $stmt->execute([$like, $like, (int)$user['id'], (int)$user['id']]);
        return array_map(fn ($row) => [
            'type' => 'client',
            'id' => (int)$row['id'],
            'title' => (string)($row['name'] ?: 'Client'),
            'subtitle' => 'Organization',
            'snippet' => $this->searchSnippet((string)($row['notes'] ?? ''), ''),
            'updated_at' => (string)($row['created_at'] ?? ''),
        ], $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    private function searchSnippet(string $value, string $query): string
    {
        $plain = trim(preg_replace('/\s+/', ' ', strip_tags($value)) ?? '');
        if ($plain === '') return '';
        $query = trim($query);
        if ($query !== '') {
            $pos = stripos($plain, $query);
            if ($pos !== false) {
                $start = max(0, $pos - 60);
                $snippet = substr($plain, $start, 180);
                return ($start > 0 ? '...' : '') . $snippet . (strlen($plain) > $start + 180 ? '...' : '');
            }
        }
        return strlen($plain) > 180 ? substr($plain, 0, 177) . '...' : $plain;
    }

    private function drivePathLabel(array $user, ?int $folderId): string
    {
        if (!$folderId) return 'Drive / Root';
        try {
            $crumbs = $this->driveBreadcrumbs($user, $folderId);
        } catch (RuntimeException) {
            return 'Drive';
        }
        $names = array_map(fn ($crumb) => (string)($crumb['name'] ?? 'Folder'), $crumbs);
        return 'Drive / ' . implode(' / ', $names);
    }

    private function listNotes(array $user): void
    {
        $q = trim($_GET['q'] ?? '');
        $view = trim($_GET['view'] ?? 'all');
        $categoryId = isset($_GET['category_id']) && $_GET['category_id'] !== '' ? (int)$_GET['category_id'] : null;
        $limit = min(1000, max(50, (int)($_GET['limit'] ?? 200)));
        $fetchLimit = $limit + 1;
        $where = ['n.user_id = ?'];
        $args = [(int)$user['id']];
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
        $ftsQuery = $q !== '' ? $this->noteFtsQuery($q) : null;
        if ($ftsQuery !== null && $this->notesFtsAvailable()) {
            $where[] = 'n.id IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)';
            $args[] = $ftsQuery;
        } elseif ($q !== '') {
            $where[] = '(n.title LIKE ? OR n.body LIKE ? OR n.tags LIKE ?)';
            array_push($args, "%$q%", "%$q%", "%$q%");
        }
        if (!empty($_GET['has_file'])) $where[] = 'EXISTS (SELECT 1 FROM files f WHERE f.note_id = n.id AND f.user_id = n.user_id)';
        if (!empty($_GET['has_secret'])) $where[] = 'EXISTS (SELECT 1 FROM note_secrets s WHERE s.note_id = n.id)';
        if (!empty($_GET['has_code'])) $where[] = "n.body LIKE '%```%'";
        if (!empty($_GET['pinned'])) $where[] = 'n.pinned = 1';
        $sort = $_GET['sort'] ?? 'updated_desc';
        $order = match ($sort) {
            'updated_asc' => 'n.pinned DESC, n.updated_at ASC, n.id ASC',
            'created_desc' => 'n.pinned DESC, n.created_at DESC, n.id DESC',
            'created_asc' => 'n.pinned DESC, n.created_at ASC, n.id ASC',
            'title_asc' => 'n.pinned DESC, lower(n.title) ASC, n.updated_at DESC',
            'title_desc' => 'n.pinned DESC, lower(n.title) DESC, n.updated_at DESC',
            default => 'n.pinned DESC, n.updated_at DESC, n.id DESC',
        };
        $sql = 'SELECT n.*, ac.name AS category_name, ac.slug AS category_slug, c.name AS client_name, (SELECT COUNT(*) FROM files f WHERE f.note_id = n.id AND f.user_id = n.user_id) AS file_count, (SELECT COUNT(*) FROM note_secrets s WHERE s.note_id = n.id) AS secret_count FROM notes n LEFT JOIN asset_categories ac ON ac.id = n.category_id LEFT JOIN clients c ON c.id = n.client_id WHERE ' . implode(' AND ', $where) . ' ORDER BY ' . $order . ' LIMIT ' . $fetchLimit;
        $stmt = $this->db->prepare($sql);
        $stmt->execute($args);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $hasMore = count($rows) > $limit;
        if ($hasMore) $rows = array_slice($rows, 0, $limit);
        $this->json(['notes' => $rows, 'has_more' => $hasMore, 'limit' => $limit, 'visible_count' => count($rows)]);
    }

    private function notesFtsAvailable(): bool
    {
        static $available = null;
        if ($available !== null) return $available;
        try {
            $stmt = $this->db->query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts' LIMIT 1");
            $available = (bool)$stmt->fetchColumn();
        } catch (Throwable) {
            $available = false;
        }
        return $available;
    }

    private function noteFtsQuery(string $query): ?string
    {
        $parts = [];
        $normalized = preg_replace('/[^\p{L}\p{N}_]+/u', ' ', trim($query)) ?? '';
        foreach (preg_split('/\s+/', trim($normalized)) ?: [] as $term) {
            if ($term !== '') $parts[] = $term . '*';
        }
        return $parts ? implode(' AND ', $parts) : null;
    }

    private function assetCounts(array $user): void
    {
        $counts = [];
        $stmt = $this->db->prepare('SELECT type, COUNT(*) AS count FROM asset_records WHERE user_id = ? AND archived = 0 GROUP BY type');
        $stmt->execute([(int)$user['id']]);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $counts[$row['type']] = (int)$row['count'];
        }
        $countStmt = $this->db->prepare('SELECT COUNT(*) FROM notes WHERE user_id = ? AND deleted = ? AND archived = ?');
        $countStmt->execute([(int)$user['id'], 0, 0]);
        $counts['notes:all'] = (int)$countStmt->fetchColumn();
        $quickStmt = $this->db->prepare('SELECT COUNT(*) FROM notes WHERE user_id = ? AND deleted = 0 AND archived = 0 AND category_id IS NULL');
        $quickStmt->execute([(int)$user['id']]);
        $counts['notes:quick'] = (int)$quickStmt->fetchColumn();
        $countStmt->execute([(int)$user['id'], 0, 1]);
        $counts['notes:archive'] = (int)$countStmt->fetchColumn();
        $trashStmt = $this->db->prepare('SELECT COUNT(*) FROM notes WHERE user_id = ? AND deleted = 1');
        $trashStmt->execute([(int)$user['id']]);
        $counts['notes:trash'] = (int)$trashStmt->fetchColumn();
        $noteCountsStmt = $this->db->prepare('SELECT category_id, COUNT(*) AS count FROM notes WHERE user_id = ? AND deleted = 0 AND archived = 0 AND category_id IS NOT NULL GROUP BY category_id');
        $noteCountsStmt->execute([(int)$user['id']]);
        $noteCounts = $noteCountsStmt->fetchAll(PDO::FETCH_ASSOC);
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
        $this->db->prepare('UPDATE asset_records SET archived = 1 WHERE type = ? AND user_id = ?')->execute([$slug, (int)$user['id']]);
        $this->db->prepare('UPDATE notes SET category_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE category_id = ? AND user_id = ?')->execute([$id, (int)$user['id']]);
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
        $where = ['a.user_id = ?', 'a.type = ?'];
        $args = [(int)$user['id'], $type];
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
        $stmt = $this->db->prepare('SELECT a.id, a.client_id, c.name AS client_name, a.type, a.name, a.status, a.asset_type, a.os, a.primary_ip, a.serial_number, a.expires_at, a.location, a.contact, a.username, a.notes, a.data_json, a.archived, a.created_at, a.updated_at, CASE WHEN a.secret_ciphertext IS NULL THEN 0 ELSE 1 END AS has_secret FROM asset_records a LEFT JOIN clients c ON c.id = a.client_id WHERE a.id = ? AND a.user_id = ?');
        $stmt->execute([$id, (int)$user['id']]);
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
            $stmt = $this->db->prepare('SELECT secret_ciphertext FROM asset_records WHERE id = ? AND user_id = ?');
            $stmt->execute([$id, (int)$user['id']]);
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
            $stmt = $this->db->prepare('UPDATE asset_records SET client_id=?, type=?, name=?, status=?, asset_type=?, os=?, primary_ip=?, serial_number=?, expires_at=?, location=?, contact=?, username=?, secret_ciphertext=?, notes=?, data_json=?, archived=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?');
            $stmt->execute([$fields['client_id'], $type, $fields['name'], $fields['status'], $fields['asset_type'], $fields['os'], $fields['primary_ip'], $fields['serial_number'], $fields['expires_at'], $fields['location'], $fields['contact'], $fields['username'], $secretCipher, $fields['notes'], $fields['data_json'], $fields['archived'], $id, (int)$user['id']]);
            if ($stmt->rowCount() === 0) throw new RuntimeException('Asset not found');
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
        $stmt = $this->db->prepare('UPDATE asset_records SET archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, (int)$user['id']]);
        if ($stmt->rowCount() === 0) throw new RuntimeException('Asset not found');
        $this->audit((int)$user['id'], 'asset.archived', 'asset', $id);
        $this->json(['ok' => true]);
    }

    private function revealAssetSecret(array $user, int $id): void
    {
        $this->requireEditor($user);
        $stmt = $this->db->prepare('SELECT secret_ciphertext FROM asset_records WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, (int)$user['id']]);
        $cipher = $stmt->fetchColumn();
        if (!$cipher) throw new RuntimeException('No secret stored');
        $this->audit((int)$user['id'], 'asset.secret_revealed', 'asset', $id);
        $this->json(['value' => $this->crypto->decrypt($cipher)]);
    }

    private function getNote(array $user, int $id): void
    {
        $note = $this->note($id, $user);
        $files = $this->db->prepare('SELECT id, original_name, mime, size, created_at FROM files WHERE note_id = ? AND user_id = ? ORDER BY id DESC');
        $files->execute([$id, (int)$user['id']]);
        $secrets = $this->db->prepare('SELECT id, label, created_at FROM note_secrets WHERE note_id = ? ORDER BY id');
        $secrets->execute([$id]);
        $versions = $this->db->prepare('SELECT id, title, created_at FROM note_versions WHERE note_id = ? ORDER BY id DESC LIMIT 20');
        $versions->execute([$id]);
        $this->json(['note' => $note, 'files' => $files->fetchAll(PDO::FETCH_ASSOC), 'secrets' => $secrets->fetchAll(PDO::FETCH_ASSOC), 'versions' => $versions->fetchAll(PDO::FETCH_ASSOC)]);
    }

    private function noteSummary(int $id, array $user): array
    {
        $stmt = $this->db->prepare('SELECT n.*, ac.name AS category_name, ac.slug AS category_slug, c.name AS client_name, (SELECT COUNT(*) FROM files f WHERE f.note_id = n.id AND f.user_id = n.user_id) AS file_count, (SELECT COUNT(*) FROM note_secrets s WHERE s.note_id = n.id) AS secret_count FROM notes n LEFT JOIN asset_categories ac ON ac.id = n.category_id LEFT JOIN clients c ON c.id = n.client_id WHERE n.id = ? AND n.user_id = ?');
        $stmt->execute([$id, (int)$user['id']]);
        $note = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$note) throw new RuntimeException('Note not found');
        return $note;
    }

    private function saveNote(array $user, int $id = 0): void
    {
        $this->requireEditor($user);
        $data = $this->input();
        $id = $id > 0 ? $id : (isset($data['id']) ? (int)$data['id'] : 0);
        $autosave = !empty($data['autosave']);
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
                $old = $this->note($id, $user);
                if ($this->shouldSnapshotNoteVersion($id, $autosave)) {
                    $this->db->prepare('INSERT INTO note_versions (note_id, user_id, title, body) VALUES (?, ?, ?, ?)')->execute([$id, (int)$user['id'], $old['title'], $old['body']]);
                    $this->pruneNoteVersions($id);
                }
                $stmt = $this->db->prepare('UPDATE notes SET title=?, body=?, type=?, section=?, category_id=?, category=?, tags=?, client_id=?, pinned=?, archived=?, deleted=0, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?');
                $stmt->execute([$title, $parsed['body'], $type, $section, $categoryId, $category, $tags, $clientId, $pinned, $archived, $id, (int)$user['id']]);
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
        $this->json(['id' => $id, 'note' => $this->noteSummary($id, $user)]);
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
        $this->json(['ok' => true, 'id' => $id, 'note' => $this->note($id, $user)]);
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

    private function onlyOfficeStatus(array $user): void
    {
        $this->requireAdmin($user);
        $url = Config::onlyOfficeUrl();
        $publicUrl = Config::onlyOfficePublicUrl();
        $callbackBaseUrl = Config::onlyOfficeCallbackBaseUrl();
        $ready = $url !== '' && $publicUrl !== '' && $callbackBaseUrl !== '' && Config::onlyOfficeJwtSecret() !== '';
        $this->json([
            'enabled' => $ready,
            'configured' => $url !== '',
            'url' => $url,
            'public_url' => $publicUrl,
            'callback_base_url' => $callbackBaseUrl,
            'jwt_configured' => Config::onlyOfficeJwtSecret() !== '',
            'recommended_internal_url' => 'http://onlyoffice',
            'compose_file' => 'docker-compose.onlyoffice.yml',
            'profiles' => [],
            'message' => $ready
                ? 'OnlyOffice is ready. Drive documents can open in the sidecar editor when this browser can reach the public URL and the Document Server can reach the callback URL.'
                : 'OnlyOffice is not enabled. Set ONLYOFFICE_URL, ONLYOFFICE_PUBLIC_URL, ONLYOFFICE_CALLBACK_BASE_URL, and ONLYOFFICE_JWT_SECRET, then start the optional sidecar compose file.',
        ]);
    }

    private function featureSettings(array $user): void
    {
        $this->json(['features' => $this->userFeatures((int)$user['id'])]);
    }

    private function saveFeatureSettings(array $user): void
    {
        $data = $this->input();
        $features = $this->userFeatures((int)$user['id']);
        foreach (['calendar', 'tasks', 'home', 'drive'] as $feature) {
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
        $q = trim((string)($_GET['q'] ?? ''));
        if ($q !== '' && !isset($_GET['start']) && !isset($_GET['end'])) {
            $start = gmdate('Y-m-d 00:00:00', strtotime('-2 years') ?: time());
            $end = gmdate('Y-m-d 23:59:59', strtotime('+5 years') ?: time());
        } else {
            [$start, $end] = $this->dateRangeFromQuery();
        }
        $where = [
            'c.archived = 0',
            '(c.owner_user_id = ? OR s.user_id = ?)',
            '((e.recurrence_rule IS NULL AND e.starts_at <= ? AND COALESCE(e.ends_at, e.starts_at) >= ?) OR (e.recurrence_rule IS NOT NULL AND e.starts_at <= ?))',
        ];
        $args = [(int)$user['id'], (int)$user['id'], (int)$user['id'], $end, $start, $end];
        if ($q !== '') {
            $where[] = '(e.title LIKE ? OR e.description LIKE ? OR e.location LIKE ? OR c.name LIKE ?)';
            array_push($args, "%$q%", "%$q%", "%$q%", "%$q%");
        }
        $stmt = $this->db->prepare('SELECT e.*, c.name AS calendar_name, c.color AS calendar_color FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id LEFT JOIN calendar_shares s ON s.calendar_id = c.id AND s.user_id = ? WHERE ' . implode(' AND ', $where) . ' ORDER BY e.starts_at ASC LIMIT 500');
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
        $q = trim((string)($_GET['q'] ?? ''));
        $where = ['(t.user_id = ? OR (t.private = 0 AND t.calendar_id IN (SELECT c.id FROM calendars c LEFT JOIN calendar_shares s ON s.calendar_id = c.id AND s.user_id = ? WHERE c.archived = 0 AND (c.owner_user_id = ? OR s.user_id = ?))))'];
        $args = [(int)$user['id'], (int)$user['id'], (int)$user['id'], (int)$user['id']];
        if ($view !== 'all') $where[] = $view === 'done' ? "t.status = 'done'" : "t.status != 'done'";
        if ($q !== '') {
            $where[] = '(t.title LIKE ? OR t.description LIKE ? OR t.location LIKE ? OR c.name LIKE ?)';
            array_push($args, "%$q%", "%$q%", "%$q%", "%$q%");
        }
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

    private function assistantDailySummary(array $user): void
    {
        $this->ensureDefaultCalendar($user);
        $this->syncDueCalendarFeeds($user);
        $userId = (int)$user['id'];

        $briefTz = new DateTimeZone('America/New_York');
        $utcTz = new DateTimeZone('UTC');
        $now = new DateTimeImmutable('now', $briefTz);
        $defaultStart = $now->setTime(0, 0, 0)->setTimezone($utcTz)->format('Y-m-d H:i:s');
        $defaultEnd = $now->setTime(23, 59, 59)->setTimezone($utcTz)->format('Y-m-d H:i:s');
        $overdueCutoff = $now->setTimezone($utcTz)->format('Y-m-d H:i:s');
        $start = $this->cleanDateTime($_GET['start'] ?? '') ?: $defaultStart;
        $end = $this->cleanDateTime($_GET['end'] ?? '') ?: $defaultEnd;

        $calendarStmt = $this->db->prepare("SELECT c.id, c.name, c.color, c.description, CASE WHEN c.owner_user_id = ? THEN 'owner' ELSE s.permission END AS permission, u.name AS owner_name FROM calendars c JOIN users u ON u.id = c.owner_user_id LEFT JOIN calendar_shares s ON s.calendar_id = c.id AND s.user_id = ? WHERE c.archived = 0 AND (c.owner_user_id = ? OR s.user_id = ?) ORDER BY c.owner_user_id = ? DESC, c.name COLLATE NOCASE");
        $calendarStmt->execute([$userId, $userId, $userId, $userId, $userId]);

        $noteStmt = $this->db->prepare('SELECT n.id, n.title, n.type, n.section, n.category, n.tags, n.pinned, n.archived, n.created_at, n.updated_at, c.name AS category_name, cl.name AS client_name FROM notes n LEFT JOIN asset_categories c ON c.id = n.category_id LEFT JOIN clients cl ON cl.id = n.client_id WHERE n.user_id = ? AND n.deleted = 0 ORDER BY n.pinned DESC, n.updated_at DESC LIMIT 15');
        $noteStmt->execute([$userId]);

        $eventStmt = $this->db->prepare("SELECT e.*, c.name AS calendar_name, c.color AS calendar_color FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id LEFT JOIN calendar_shares s ON s.calendar_id = c.id AND s.user_id = ? WHERE c.archived = 0 AND (c.owner_user_id = ? OR s.user_id = ?) AND ((e.recurrence_rule IS NULL AND e.starts_at <= ? AND COALESCE(e.ends_at, e.starts_at) >= ?) OR (e.recurrence_rule IS NOT NULL AND e.starts_at <= ?)) ORDER BY e.starts_at ASC");
        $eventStmt->execute([$userId, $userId, $userId, $end, $start, $end]);

        $taskBaseWhere = '(t.user_id = ? OR (t.private = 0 AND t.calendar_id IN (SELECT c2.id FROM calendars c2 LEFT JOIN calendar_shares s ON s.calendar_id = c2.id AND s.user_id = ? WHERE c2.archived = 0 AND (c2.owner_user_id = ? OR s.user_id = ?))))';
        $taskArgs = [$userId, $userId, $userId, $userId];
        $overdueTaskStmt = $this->db->prepare('SELECT t.*, c.name AS calendar_name, c.color AS calendar_color FROM tasks t LEFT JOIN calendars c ON c.id = t.calendar_id WHERE t.status != \'done\' AND t.due_at IS NOT NULL AND t.due_at < ? AND ' . $taskBaseWhere . ' ORDER BY t.due_at ASC, t.priority DESC, t.id DESC LIMIT 25');
        $overdueTaskStmt->execute(array_merge([$overdueCutoff], $taskArgs));
        $upcomingTaskStmt = $this->db->prepare('SELECT t.*, c.name AS calendar_name, c.color AS calendar_color FROM tasks t LEFT JOIN calendars c ON c.id = t.calendar_id WHERE t.status != \'done\' AND (t.due_at IS NULL OR t.due_at >= ?) AND ' . $taskBaseWhere . ' ORDER BY t.due_at IS NULL, t.due_at ASC, t.priority DESC, t.id DESC LIMIT 25');
        $upcomingTaskStmt->execute(array_merge([$overdueCutoff], $taskArgs));
        $taskStmt = $this->db->prepare('SELECT t.*, c.name AS calendar_name, c.color AS calendar_color FROM tasks t LEFT JOIN calendars c ON c.id = t.calendar_id WHERE t.status != \'done\' AND ' . $taskBaseWhere . ' ORDER BY CASE WHEN t.due_at IS NOT NULL AND t.due_at < ? THEN 0 ELSE 1 END, t.due_at IS NULL, t.due_at ASC, t.priority DESC, t.id DESC LIMIT 25');
        $taskStmt->execute(array_merge($taskArgs, [$overdueCutoff]));

        $eventReminderStmt = $this->db->prepare("SELECT r.id, 'event' AS kind, r.remind_at, e.title, e.starts_at AS due_at FROM calendar_event_reminders r JOIN calendar_events e ON e.id = r.event_id JOIN calendars c ON c.id = e.calendar_id LEFT JOIN calendar_shares s ON s.calendar_id = c.id AND s.user_id = ? WHERE r.user_id = ? AND c.archived = 0 AND (c.owner_user_id = ? OR s.user_id = ?) AND r.dismissed_at IS NULL AND r.sent_at IS NULL AND r.remind_at <= CURRENT_TIMESTAMP ORDER BY r.remind_at LIMIT 25");
        $eventReminderStmt->execute([$userId, $userId, $userId, $userId]);
        $taskReminderStmt = $this->db->prepare("SELECT r.id, 'task' AS kind, r.remind_at, t.title, t.due_at FROM task_reminders r JOIN tasks t ON t.id = r.task_id LEFT JOIN calendars c ON c.id = t.calendar_id LEFT JOIN calendar_shares s ON s.calendar_id = c.id AND s.user_id = ? WHERE r.user_id = ? AND (t.user_id = ? OR (t.private = 0 AND c.archived = 0 AND (c.owner_user_id = ? OR s.user_id = ?))) AND r.dismissed_at IS NULL AND r.sent_at IS NULL AND r.remind_at <= CURRENT_TIMESTAMP ORDER BY r.remind_at LIMIT 25");
        $taskReminderStmt->execute([$userId, $userId, $userId, $userId, $userId]);

        $this->json([
            'range' => ['start' => $start, 'end' => $end],
            'calendars' => $calendarStmt->fetchAll(PDO::FETCH_ASSOC),
            'events' => $this->expandRecurringEvents($eventStmt->fetchAll(PDO::FETCH_ASSOC), $start, $end),
            'overdue_tasks' => $overdueTaskStmt->fetchAll(PDO::FETCH_ASSOC),
            'upcoming_tasks' => $upcomingTaskStmt->fetchAll(PDO::FETCH_ASSOC),
            'tasks' => $taskStmt->fetchAll(PDO::FETCH_ASSOC),
            'recent_notes' => $noteStmt->fetchAll(PDO::FETCH_ASSOC),
            'reminders' => array_merge($eventReminderStmt->fetchAll(PDO::FETCH_ASSOC), $taskReminderStmt->fetchAll(PDO::FETCH_ASSOC)),
        ]);
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
        $addresses = filter_var($host, FILTER_VALIDATE_IP) ? [$host] : $this->resolveCalendarFeedHost($host);
        if (!$addresses) throw new RuntimeException('Calendar feed host could not be resolved');
        foreach ($addresses as $address) {
            if (!filter_var($address, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) throw new RuntimeException('Private network calendar feed URLs are not allowed');
        }
    }

    private function resolveCalendarFeedHost(string $host): array
    {
        $records = @dns_get_record($host, DNS_A | DNS_AAAA) ?: [];
        $addresses = [];
        foreach ($records as $record) {
            foreach (['ip', 'ipv6'] as $key) {
                if (!empty($record[$key]) && is_string($record[$key])) $addresses[] = $record[$key];
            }
        }
        return array_values(array_unique($addresses));
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
        $this->note($id, $user);
        $this->db->prepare('UPDATE notes SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')->execute([$id, (int)$user['id']]);
        $this->audit((int)$user['id'], 'note.deleted', 'note', $id);
        $this->json(['ok' => true]);
    }

    private function restoreNoteVersion(array $user, int $noteId, int $versionId): void
    {
        $this->requireEditor($user);
        $note = $this->note($noteId, $user);
        $stmt = $this->db->prepare('SELECT * FROM note_versions WHERE id = ? AND note_id = ?');
        $stmt->execute([$versionId, $noteId]);
        $version = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$version) throw new RuntimeException('Version not found');
        $this->db->beginTransaction();
        try {
            $this->db->prepare('INSERT INTO note_versions (note_id, user_id, title, body) VALUES (?, ?, ?, ?)')->execute([$noteId, (int)$user['id'], $note['title'], $note['body']]);
            $this->pruneNoteVersions($noteId);
            $this->db->prepare('UPDATE notes SET title = ?, body = ?, deleted = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')->execute([$version['title'], $version['body'], $noteId, (int)$user['id']]);
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
        $this->note($noteId, $user);
        $stmt = $this->db->prepare('SELECT id, note_id, title, body, created_at FROM note_versions WHERE id = ? AND note_id = ?');
        $stmt->execute([$versionId, $noteId]);
        $version = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$version) throw new RuntimeException('Version not found');
        $this->json(['version' => $version]);
    }

    private function archiveNote(array $user, int $id): void
    {
        $this->requireEditor($user);
        $this->note($id, $user);
        $this->db->prepare('UPDATE notes SET archived = 1, deleted = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')->execute([$id, (int)$user['id']]);
        $this->audit((int)$user['id'], 'note.archived', 'note', $id);
        $this->json(['ok' => true]);
    }

    private function restoreNote(array $user, int $id): void
    {
        $this->requireEditor($user);
        $this->note($id, $user);
        $this->db->prepare('UPDATE notes SET archived = 0, deleted = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')->execute([$id, (int)$user['id']]);
        $this->audit((int)$user['id'], 'note.restored', 'note', $id);
        $this->json(['ok' => true]);
    }

    private function permanentlyDeleteNote(array $user, int $id): void
    {
        $this->requireEditor($user);
        $this->note($id, $user);
        $this->db->prepare('DELETE FROM notes WHERE id = ? AND user_id = ?')->execute([$id, (int)$user['id']]);
        $this->audit((int)$user['id'], 'note.permanently_deleted', 'note', $id);
        $this->json(['ok' => true]);
    }

    private function emptyTrash(array $user): void
    {
        $this->requireEditor($user);
        $stmt = $this->db->prepare('DELETE FROM notes WHERE deleted = 1 AND user_id = ?');
        $stmt->execute([(int)$user['id']]);
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
            'calendar' => ['enabled' => true, 'settings' => ['home_enabled' => true, 'reminders_enabled' => true, 'default_reminder_minutes' => 10, 'default_calendar_id' => null]],
            'tasks' => ['enabled' => true, 'settings' => ['home_enabled' => true, 'reminders_enabled' => true, 'default_reminder_minutes' => 10, 'shared_calendar_tasks' => false]],
            'home' => ['enabled' => true, 'settings' => ['notes_enabled' => true]],
            'drive' => ['enabled' => true, 'settings' => []],
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

    private function requireFeatureEnabled(array $user, string $feature, string $message): void
    {
        if (empty($this->userFeatures((int)$user['id'])[$feature]['enabled'])) throw new RuntimeException($message);
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
            $this->note($noteId, $user);
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
        $lastRun = (int)$this->setting('retention.last_pruned_at');
        if ($lastRun > 0 && $lastRun > time() - 3600) return;
        $this->pruneTrashByPolicy();
        $this->saveSetting('retention.last_pruned_at', (string)time());
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

    private function shouldSnapshotNoteVersion(int $noteId, bool $autosave): bool
    {
        if (!$autosave) return true;
        $stmt = $this->db->prepare('SELECT created_at FROM note_versions WHERE note_id = ? ORDER BY id DESC LIMIT 1');
        $stmt->execute([$noteId]);
        $last = $stmt->fetchColumn();
        if (!$last) return true;
        $lastTime = strtotime((string)$last);
        return !$lastTime || $lastTime < time() - 300;
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
        $this->note($noteId, $user);
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
        $stmt = $this->db->prepare('SELECT * FROM files WHERE id = ? AND user_id = ?');
        $stmt->execute([$id, (int)$user['id']]);
        $file = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$file) throw new RuntimeException('File not found');
        $path = Config::dir() . '/files/' . basename((string)$file['stored_name']);
        if (!is_file($path)) throw new RuntimeException('File not found');
        $this->audit((int)$user['id'], 'file.downloaded', 'file', $id);
        header_remove('Content-Type');
        header('Content-Type: ' . ($file['mime'] ?: 'application/octet-stream'));
        $mode = $inline && $this->isPreviewable($file['mime'] ?? '') ? 'inline' : 'attachment';
        header('Content-Disposition: ' . $this->contentDisposition($mode, $file['original_name']));
        if ($mode === 'inline') {
            header_remove('X-Frame-Options');
            header_remove('Content-Security-Policy');
            header("Content-Security-Policy: default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; frame-ancestors 'self'");
        }
        header('X-Content-Type-Options: nosniff');
        readfile($path);
        exit;
    }

    private function driveList(array $user): void
    {
        $parentId = isset($_GET['parent_id']) && $_GET['parent_id'] !== '' ? (int)$_GET['parent_id'] : (isset($_GET['folder_id']) && $_GET['folder_id'] !== '' ? (int)$_GET['folder_id'] : null);
        $q = trim((string)($_GET['q'] ?? ''));
        $scopeAll = $q !== '' && (string)($_GET['scope'] ?? '') === 'all';
        $userId = (int)$user['id'];
        if ($parentId) $this->driveFolderAccess($user, $parentId, 'view');
        if ($scopeAll) {
            $folderStmt = $this->db->prepare('SELECT id FROM drive_folders WHERE deleted = 0 AND name LIKE ? ORDER BY updated_at DESC, name COLLATE NOCASE LIMIT 200');
            $folderStmt->execute(['%' . $q . '%']);
            $folders = [];
            foreach ($folderStmt->fetchAll(PDO::FETCH_COLUMN) as $folderId) {
                try {
                    $folders[] = $this->driveFolderAccess($user, (int)$folderId, 'view');
                } catch (RuntimeException) {
                    continue;
                }
                if (count($folders) >= 100) break;
            }
            $fileStmt = $this->db->prepare('SELECT id FROM drive_files WHERE deleted = 0 AND (original_name LIKE ? OR mime LIKE ?) ORDER BY updated_at DESC, original_name COLLATE NOCASE LIMIT 200');
            $fileStmt->execute(['%' . $q . '%', '%' . $q . '%']);
            $files = [];
            foreach ($fileStmt->fetchAll(PDO::FETCH_COLUMN) as $fileId) {
                try {
                    $file = $this->driveFileAccess($user, (int)$fileId, 'view');
                } catch (RuntimeException) {
                    continue;
                }
                $files[] = [
                    'id' => (int)$file['id'],
                    'owner_user_id' => (int)$file['owner_user_id'],
                    'folder_id' => $file['folder_id'] === null ? null : (int)$file['folder_id'],
                    'original_name' => (string)$file['original_name'],
                    'mime' => (string)($file['mime'] ?? ''),
                    'size' => (int)($file['size'] ?? 0),
                    'created_at' => (string)($file['created_at'] ?? ''),
                    'updated_at' => (string)($file['updated_at'] ?? ''),
                    'permission' => (string)($file['permission'] ?? 'view'),
                ];
                if (count($files) >= 100) break;
            }
            $this->json(['folders' => $folders, 'files' => $files, 'breadcrumbs' => $this->driveBreadcrumbs($user, $parentId), 'search_scope' => 'all']);
        }
        if ($parentId) {
            $folderSql = "SELECT f.*, CASE WHEN f.owner_user_id = ? THEN 'owner' ELSE COALESCE(s.permission, 'view') END AS permission FROM drive_folders f LEFT JOIN drive_shares s ON s.item_type = 'folder' AND s.item_id = f.id AND s.user_id = ? WHERE f.deleted = 0 AND f.parent_id = ?";
            $folderArgs = [$userId, $userId, $parentId];
            $fileSql = "SELECT f.id, f.owner_user_id, f.folder_id, f.original_name, f.mime, f.size, f.created_at, f.updated_at, CASE WHEN f.owner_user_id = ? THEN 'owner' ELSE COALESCE(s.permission, 'view') END AS permission FROM drive_files f LEFT JOIN drive_shares s ON s.item_type = 'file' AND s.item_id = f.id AND s.user_id = ? WHERE f.deleted = 0 AND f.folder_id = ?";
            $fileArgs = [$userId, $userId, $parentId];
        } else {
            $folderSql = "SELECT f.*, CASE WHEN f.owner_user_id = ? THEN 'owner' ELSE s.permission END AS permission FROM drive_folders f LEFT JOIN drive_shares s ON s.item_type = 'folder' AND s.item_id = f.id AND s.user_id = ? WHERE f.deleted = 0 AND ((f.owner_user_id = ? AND f.parent_id IS NULL) OR s.user_id = ?)";
            $folderArgs = [$userId, $userId, $userId, $userId];
            $fileSql = "SELECT f.id, f.owner_user_id, f.folder_id, f.original_name, f.mime, f.size, f.created_at, f.updated_at, CASE WHEN f.owner_user_id = ? THEN 'owner' ELSE s.permission END AS permission FROM drive_files f LEFT JOIN drive_shares s ON s.item_type = 'file' AND s.item_id = f.id AND s.user_id = ? WHERE f.deleted = 0 AND ((f.owner_user_id = ? AND f.folder_id IS NULL) OR s.user_id = ?)";
            $fileArgs = [$userId, $userId, $userId, $userId];
        }
        if ($q !== '') {
            $folderSql .= ' AND f.name LIKE ?';
            $folderArgs[] = '%' . $q . '%';
            $fileSql .= ' AND (f.original_name LIKE ? OR f.mime LIKE ?)';
            array_push($fileArgs, '%' . $q . '%', '%' . $q . '%');
        }
        $folders = $this->db->prepare($folderSql . ' ORDER BY f.name COLLATE NOCASE');
        $folders->execute($folderArgs);
        $files = $this->db->prepare($fileSql . ' ORDER BY f.original_name COLLATE NOCASE');
        $files->execute($fileArgs);
        $this->json(['folders' => $folders->fetchAll(PDO::FETCH_ASSOC), 'files' => $files->fetchAll(PDO::FETCH_ASSOC), 'breadcrumbs' => $this->driveBreadcrumbs($user, $parentId)]);
    }

    private function driveFolderTree(array $user): void
    {
        $this->requireEditor($user);
        $stmt = $this->db->query('SELECT id FROM drive_folders WHERE deleted = 0 ORDER BY name COLLATE NOCASE');
        $folders = [];
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $folderId) {
            try {
                $folder = $this->driveFolderAccess($user, (int)$folderId, 'edit');
            } catch (RuntimeException $e) {
                continue;
            }
            $breadcrumbs = $this->driveBreadcrumbs($user, (int)$folder['id']);
            $path = implode(' / ', array_map(fn($crumb) => (string)($crumb['name'] ?? 'Folder'), $breadcrumbs));
            $folders[] = [
                'id' => (int)$folder['id'],
                'parent_id' => $folder['parent_id'] === null ? null : (int)$folder['parent_id'],
                'name' => (string)$folder['name'],
                'path' => $path ?: (string)$folder['name'],
                'permission' => (string)($folder['permission'] ?? ''),
            ];
        }
        $this->json(['folders' => $folders]);
    }

    private function driveStorageSettings(array $user): void
    {
        $this->requireAdmin($user);
        $settings = Config::driveStorageSettings();
        $dir = Config::driveFilesDir();
        $storageStats = $this->driveStorageStats($dir);
        $sourceCounts = $this->driveSourceCounts((int)$user['id']);
        $this->json([
            'drive_files_dir' => $dir,
            'drive_upload_max_mb' => (int)round(Config::driveUploadMaxBytes() / 1024 / 1024),
            'configured_drive_files_dir' => (string)($settings['drive_files_dir'] ?? ''),
            'configured_drive_upload_max_mb' => (int)($settings['drive_upload_max_mb'] ?? 0),
            'writable' => is_dir($dir) && is_writable($dir),
            'exists' => is_dir($dir),
            'storage_total_bytes' => $storageStats['total'],
            'storage_free_bytes' => $storageStats['free'],
            'storage_used_bytes' => $storageStats['used'],
            'source_file_count' => $sourceCounts['files'],
            'source_folder_count' => $sourceCounts['folders'],
            'last_source_sync_at' => (string)($settings['last_source_sync_at'] ?? ''),
            'recommended_mount' => '/media',
        ]);
    }

    private function driveStorageStats(string $dir): array
    {
        if (!is_dir($dir)) return ['total' => null, 'free' => null, 'used' => null];
        $total = @disk_total_space($dir);
        $free = @disk_free_space($dir);
        if ($total === false || $free === false) return ['total' => null, 'free' => null, 'used' => null];
        $totalBytes = max(0, (int)$total);
        $freeBytes = max(0, (int)$free);
        return ['total' => $totalBytes, 'free' => $freeBytes, 'used' => max(0, $totalBytes - $freeBytes)];
    }

    private function driveSourceCounts(int $userId): array
    {
        $folders = $this->db->prepare('SELECT COUNT(*) FROM drive_folders WHERE owner_user_id = ? AND source_path IS NOT NULL AND deleted = 0');
        $folders->execute([$userId]);
        $files = $this->db->prepare('SELECT COUNT(*) FROM drive_files WHERE owner_user_id = ? AND source_path IS NOT NULL AND deleted = 0');
        $files->execute([$userId]);
        return ['folders' => (int)$folders->fetchColumn(), 'files' => (int)$files->fetchColumn()];
    }

    private function saveDriveStorageSettings(array $user): void
    {
        $this->requireAdmin($user);
        $data = $this->input();
        $currentDir = Config::driveFilesDir();
        $dir = rtrim(trim((string)($data['drive_files_dir'] ?? '')), '/');
        if ($dir === '') $dir = Config::dir() . '/drive-files';
        if (!str_starts_with($dir, '/') || in_array($dir, ['/', '/proc', '/sys', '/dev'], true)) throw new RuntimeException('Use a safe absolute container path such as /media');
        $uploadMaxMb = max(1, min(2048, (int)($data['drive_upload_max_mb'] ?? round(Config::driveUploadMaxBytes() / 1024 / 1024))));
        if (!is_dir($dir) && !mkdir($dir, 0770, true)) throw new RuntimeException('Drive storage path could not be created');
        if (!is_writable($dir)) throw new RuntimeException('Drive storage path is not writable');

        if ($dir !== $currentDir) $this->migrateDriveFiles($currentDir, $dir);

        $settings = Config::driveStorageSettings();
        Config::saveDriveStorageSettings(array_merge($settings, [
            'drive_files_dir' => $dir,
            'drive_upload_max_mb' => $uploadMaxMb,
            'last_source_sync_at' => $dir === $currentDir ? (string)($settings['last_source_sync_at'] ?? '') : '',
            'last_source_sync_by' => $dir === $currentDir ? (int)($settings['last_source_sync_by'] ?? 0) : 0,
            'updated_at' => gmdate('c'),
            'updated_by' => (int)$user['id'],
        ]));
        $this->audit((int)$user['id'], 'settings.drive_storage_updated', 'settings', null);
        $this->driveStorageSettings($user);
    }

    private function driveSyncSources(array $user): void
    {
        $this->requireAdmin($user);
        $result = $this->syncDriveSourceFiles($user);
        Config::saveDriveStorageSettings(array_merge(Config::driveStorageSettings(), [
            'last_source_sync_at' => gmdate('c'),
            'last_source_sync_by' => (int)$user['id'],
        ]));
        $this->audit((int)$user['id'], 'drive_source.synced', 'drive', null);
        $this->json(['ok' => true, 'synced' => $result]);
    }

    private function driveCreateFolder(array $user): void
    {
        $this->requireEditor($user);
        $data = $this->input();
        $name = $this->driveName($data['name'] ?? 'New folder');
        $parentId = !empty($data['parent_id']) ? (int)$data['parent_id'] : null;
        if ($parentId) $this->driveFolderAccess($user, $parentId, 'edit');
        $stmt = $this->db->prepare('INSERT INTO drive_folders (owner_user_id, parent_id, name) VALUES (?, ?, ?)');
        $stmt->execute([(int)$user['id'], $parentId, $name]);
        $id = (int)$this->db->lastInsertId();
        $this->audit((int)$user['id'], 'drive_folder.created', 'drive_folder', $id);
        $this->json(['folder' => $this->driveFolderAccess($user, $id, 'view')]);
    }

    private function driveUpdateFolder(array $user, int $id): void
    {
        $this->requireEditor($user);
        $folder = $this->driveFolderAccess($user, $id, 'edit');
        $data = $this->input();
        $name = array_key_exists('name', $data) ? $this->driveName($data['name']) : $folder['name'];
        $parentId = array_key_exists('parent_id', $data) && $data['parent_id'] !== '' ? (int)$data['parent_id'] : null;
        if ($parentId) {
            if ($parentId === $id || $this->driveFolderHasAncestor($parentId, $id)) throw new RuntimeException('Folder cannot be moved into itself');
            $this->driveFolderAccess($user, $parentId, 'edit');
        }
        $this->db->prepare('UPDATE drive_folders SET name = ?, parent_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([$name, $parentId, $id]);
        $this->audit((int)$user['id'], 'drive_folder.updated', 'drive_folder', $id);
        $this->json(['folder' => $this->driveFolderAccess($user, $id, 'view')]);
    }

    private function driveDeleteFolder(array $user, int $id): void
    {
        $this->requireEditor($user);
        $this->driveFolderAccess($user, $id, 'edit');
        $stmt = $this->db->prepare('WITH RECURSIVE tree(id) AS (SELECT id FROM drive_folders WHERE id = ? UNION ALL SELECT f.id FROM drive_folders f JOIN tree t ON f.parent_id = t.id) UPDATE drive_folders SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id IN (SELECT id FROM tree)');
        $stmt->execute([$id]);
        $fileStmt = $this->db->prepare('WITH RECURSIVE tree(id) AS (SELECT id FROM drive_folders WHERE id = ? UNION ALL SELECT f.id FROM drive_folders f JOIN tree t ON f.parent_id = t.id) UPDATE drive_files SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE folder_id IN (SELECT id FROM tree)');
        $fileStmt->execute([$id]);
        $this->audit((int)$user['id'], 'drive_folder.deleted', 'drive_folder', $id);
        $this->json(['ok' => true]);
    }

    private function driveUploadFile(array $user): void
    {
        $this->requireEditor($user);
        $folderId = !empty($_POST['folder_id']) ? (int)$_POST['folder_id'] : null;
        if ($folderId) $this->driveFolderAccess($user, $folderId, 'edit');
        if (empty($_FILES['file'])) throw new RuntimeException('No file uploaded');
        $file = $_FILES['file'];
        $error = $file['error'] ?? UPLOAD_ERR_OK;
        if ($error !== UPLOAD_ERR_OK) {
            if (in_array($error, [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true)) {
                throw new RuntimeException('Upload failed: file exceeds the server upload limit');
            }
            throw new RuntimeException('Upload failed');
        }
        if (($file['size'] ?? 0) <= 0 || (int)$file['size'] > Config::driveUploadMaxBytes()) throw new RuntimeException('Invalid file size');
        $dir = Config::driveFilesDir();
        if (!is_dir($dir) && !mkdir($dir, 0775, true)) throw new RuntimeException('Upload storage unavailable');
        $mime = (new finfo(FILEINFO_MIME_TYPE))->file($file['tmp_name']) ?: 'application/octet-stream';
        $name = preg_replace('/[^a-zA-Z0-9._-]/', '_', basename((string)$file['name'])) ?: 'upload.bin';
        $stored = bin2hex(random_bytes(16)) . '-' . $name;
        if (!move_uploaded_file($file['tmp_name'], $dir . '/' . $stored)) throw new RuntimeException('Upload failed');
        @chmod($dir . '/' . $stored, 0600);
        $stmt = $this->db->prepare('INSERT INTO drive_files (owner_user_id, folder_id, original_name, stored_name, mime, size) VALUES (?, ?, ?, ?, ?, ?)');
        $stmt->execute([(int)$user['id'], $folderId, (string)$file['name'], $stored, $mime, (int)$file['size']]);
        $id = (int)$this->db->lastInsertId();
        $this->audit((int)$user['id'], 'drive_file.uploaded', 'drive_file', $id);
        $this->json(['file' => $this->driveFileAccess($user, $id, 'view')]);
    }

    private function driveUpdateFile(array $user, int $id): void
    {
        $this->requireEditor($user);
        $file = $this->driveFileAccess($user, $id, 'edit');
        $data = $this->input();
        $name = array_key_exists('name', $data) ? $this->driveName($data['name']) : $file['original_name'];
        $folderId = array_key_exists('folder_id', $data) ? ($data['folder_id'] !== '' ? (int)$data['folder_id'] : null) : ($file['folder_id'] !== null ? (int)$file['folder_id'] : null);
        if ($folderId) $this->driveFolderAccess($user, $folderId, 'edit');
        $this->db->prepare('UPDATE drive_files SET original_name = ?, folder_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([$name, $folderId, $id]);
        $this->audit((int)$user['id'], 'drive_file.updated', 'drive_file', $id);
        $this->json(['file' => $this->driveFileAccess($user, $id, 'view')]);
    }

    private function driveDeleteFile(array $user, int $id): void
    {
        $this->requireEditor($user);
        $this->driveFileAccess($user, $id, 'edit');
        $this->db->prepare('UPDATE drive_files SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([$id]);
        $this->audit((int)$user['id'], 'drive_file.deleted', 'drive_file', $id);
        $this->json(['ok' => true]);
    }

    private function driveZipSelection(array $user): void
    {
        $this->requireEditor($user);
        $data = $this->input();
        $fileIds = array_values(array_unique(array_map('intval', $data['file_ids'] ?? [])));
        $folderIds = array_values(array_unique(array_map('intval', $data['folder_ids'] ?? [])));
        if (!$fileIds && !$folderIds) throw new RuntimeException('Select files or folders to compress');
        $parentId = !empty($data['parent_id']) ? (int)$data['parent_id'] : null;
        if ($parentId) $this->driveFolderAccess($user, $parentId, 'edit');
        if (!class_exists('ZipArchive')) throw new RuntimeException('ZIP support unavailable');
        $dir = Config::driveFilesDir();
        if (!is_dir($dir) && !mkdir($dir, 0775, true)) throw new RuntimeException('Drive storage unavailable');
        $zipName = $this->driveZipName((string)($data['name'] ?? ('Selected files ' . gmdate('Ymd-His'))));
        $stored = bin2hex(random_bytes(16)) . '-' . preg_replace('/[^a-zA-Z0-9._-]/', '_', $zipName);
        $path = $dir . '/' . $stored;
        $zip = new ZipArchive();
        if ($zip->open($path, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) throw new RuntimeException('ZIP could not be created');
        foreach ($folderIds as $folderId) {
            $folder = $this->driveFolderAccess($user, $folderId, 'edit');
            $this->driveAddFolderToZip($zip, $folderId, (string)$folder['name']);
        }
        foreach ($fileIds as $fileId) {
            $file = $this->driveFileAccess($user, $fileId, 'edit');
            $source = $this->driveFilePath($file);
            if (!is_file($source)) continue;
            if (!$zip->addFile($source, $this->driveZipEntryName((string)$file['original_name']))) {
                $zip->close();
                @unlink($path);
                throw new RuntimeException('File could not be added to ZIP');
            }
        }
        if (!$zip->close()) {
            @unlink($path);
            throw new RuntimeException('ZIP could not be saved');
        }
        @chmod($path, 0600);
        $file = $this->driveStoreGeneratedFile($user, $parentId, $zipName, $stored, 'application/zip', filesize($path) ?: 0);
        $this->audit((int)$user['id'], 'drive_selection.zipped', 'drive_file', (int)$file['id']);
        $this->json(['file' => $file]);
    }

    private function driveZipFolder(array $user, int $id): void
    {
        $this->requireEditor($user);
        $folder = $this->driveFolderAccess($user, $id, 'edit');
        $parentId = $folder['parent_id'] !== null ? (int)$folder['parent_id'] : null;
        if ($parentId) $this->driveFolderAccess($user, $parentId, 'edit');
        if (!class_exists('ZipArchive')) throw new RuntimeException('ZIP support unavailable');
        $dir = Config::driveFilesDir();
        if (!is_dir($dir) && !mkdir($dir, 0775, true)) throw new RuntimeException('Drive storage unavailable');
        $zipName = $this->driveZipName((string)$folder['name']);
        $stored = bin2hex(random_bytes(16)) . '-' . preg_replace('/[^a-zA-Z0-9._-]/', '_', $zipName);
        $path = $dir . '/' . $stored;
        $zip = new ZipArchive();
        if ($zip->open($path, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) throw new RuntimeException('ZIP could not be created');
        $this->driveAddFolderToZip($zip, $id, (string)$folder['name']);
        if (!$zip->close()) {
            @unlink($path);
            throw new RuntimeException('ZIP could not be saved');
        }
        @chmod($path, 0600);
        $file = $this->driveStoreGeneratedFile($user, $parentId, $zipName, $stored, 'application/zip', filesize($path) ?: 0);
        $this->audit((int)$user['id'], 'drive_folder.zipped', 'drive_folder', $id);
        $this->json(['file' => $file]);
    }

    private function driveZipFile(array $user, int $id): void
    {
        $this->requireEditor($user);
        $file = $this->driveFileAccess($user, $id, 'edit');
        $folderId = $file['folder_id'] !== null ? (int)$file['folder_id'] : null;
        if ($folderId) $this->driveFolderAccess($user, $folderId, 'edit');
        if (!class_exists('ZipArchive')) throw new RuntimeException('ZIP support unavailable');
        $source = $this->driveFilePath($file);
        if (!is_file($source)) throw new RuntimeException('File not found');
        $dir = Config::driveFilesDir();
        $zipName = $this->driveZipName((string)$file['original_name']);
        $stored = bin2hex(random_bytes(16)) . '-' . preg_replace('/[^a-zA-Z0-9._-]/', '_', $zipName);
        $path = $dir . '/' . $stored;
        $zip = new ZipArchive();
        if ($zip->open($path, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) throw new RuntimeException('ZIP could not be created');
        $entry = $this->driveZipEntryName((string)$file['original_name']);
        if (!$zip->addFile($source, $entry)) {
            $zip->close();
            @unlink($path);
            throw new RuntimeException('File could not be added to ZIP');
        }
        if (!$zip->close()) {
            @unlink($path);
            throw new RuntimeException('ZIP could not be saved');
        }
        @chmod($path, 0600);
        $created = $this->driveStoreGeneratedFile($user, $folderId, $zipName, $stored, 'application/zip', filesize($path) ?: 0);
        $this->audit((int)$user['id'], 'drive_file.zipped', 'drive_file', $id);
        $this->json(['file' => $created]);
    }

    private function driveExtractZipFile(array $user, int $id): void
    {
        $this->requireEditor($user);
        $file = $this->driveFileAccess($user, $id, 'edit');
        $path = $this->driveFilePath($file);
        if (!is_file($path)) throw new RuntimeException('File not found');
        if (!$this->driveZipPreview($file, $path)) throw new RuntimeException('Only ZIP files can be extracted');
        $parentId = $file['folder_id'] !== null ? (int)$file['folder_id'] : null;
        if ($parentId) $this->driveFolderAccess($user, $parentId, 'edit');
        if (!class_exists('ZipArchive')) throw new RuntimeException('ZIP support unavailable');

        $zip = new ZipArchive();
        if ($zip->open($path) !== true) throw new RuntimeException('ZIP could not be read');
        $limit = Config::driveUploadMaxBytes();
        $total = 0;
        $createdFiles = 0;
        $folderMap = ['' => $this->driveCreateExtractFolder($user, $parentId, $this->driveExtractFolderName((string)$file['original_name']))];
        try {
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $entry = $this->driveSafeZipEntry($zip->getNameIndex($i) ?: '');
                if ($entry === '') continue;
                if (str_ends_with($entry, '/')) {
                    $this->driveEnsureExtractFolder($user, $folderMap, trim($entry, '/'));
                    continue;
                }
                $stat = $zip->statIndex($i) ?: [];
                $size = (int)($stat['size'] ?? 0);
                $total += $size;
                if ($total > $limit || $createdFiles >= 1000) throw new RuntimeException('ZIP extract limit exceeded');
                $parentPath = str_replace('\\', '/', dirname($entry));
                $targetFolderId = $this->driveEnsureExtractFolder($user, $folderMap, $parentPath === '.' ? '' : $parentPath);
                $content = $zip->getFromIndex($i);
                if ($content === false) throw new RuntimeException('ZIP entry could not be read');
                $this->driveStoreExtractedFile($user, $targetFolderId, basename($entry), $content);
                $createdFiles++;
            }
        } finally {
            $zip->close();
        }
        $this->audit((int)$user['id'], 'drive_file.extracted', 'drive_file', $id);
        $this->json(['folder' => $this->driveFolderAccess($user, $folderMap[''], 'view'), 'files' => $createdFiles]);
    }

    private function driveUpdateFileContent(array $user, int $id): void
    {
        $this->requireEditor($user);
        $file = $this->driveFileAccess($user, $id, 'edit');
        if (!$this->driveTextEditable($file)) throw new RuntimeException('This file type cannot be edited online');
        $data = $this->input();
        $content = (string)($data['content'] ?? '');
        if (strlen($content) > 2 * 1024 * 1024) throw new RuntimeException('Editable files must be 2 MB or smaller');
        $path = $this->driveFilePath($file);
        if (!is_file($path)) throw new RuntimeException('File not found');
        if (file_put_contents($path, $content, LOCK_EX) === false) throw new RuntimeException('File update failed');
        @chmod($path, 0600);
        $mime = $this->driveEditableMime((string)$file['original_name'], (string)($file['mime'] ?? ''));
        $size = filesize($path) ?: strlen($content);
        $this->updateDriveFileDiskMetadata($id, $path, $mime, $size);
        $this->audit((int)$user['id'], 'drive_file.content_updated', 'drive_file', $id);
        $this->json(['file' => $this->driveFileAccess($user, $id, 'view')]);
    }

    private function driveDownloadFile(array $user, int $id, bool $inline = false): void
    {
        $file = $this->driveFileAccess($user, $id, 'view');
        $path = $this->driveFilePath($file);
        if (!is_file($path)) throw new RuntimeException('File not found');
        $this->audit((int)$user['id'], $inline ? 'drive_file.previewed' : 'drive_file.downloaded', 'drive_file', $id);
        header_remove('Content-Type');
        header('Content-Type: ' . ($file['mime'] ?: 'application/octet-stream'));
        $mode = $inline && $this->isPreviewable($file['mime'] ?? '') ? 'inline' : 'attachment';
        header('Content-Disposition: ' . $this->contentDisposition($mode, $file['original_name']));
        header('X-Content-Type-Options: nosniff');
        header('Content-Length: ' . filesize($path));
        readfile($path);
        exit;
    }

    private function driveFileMetadata(array $user, int $id): void
    {
        $file = $this->driveFileAccess($user, $id, 'view');
        $path = $this->driveFilePath($file);
        if (!is_file($path)) throw new RuntimeException('File not found');
        unset($file['stored_name']);
        $file['size'] = filesize($path) ?: (int)($file['size'] ?? 0);
        $this->audit((int)$user['id'], 'drive_file.metadata_viewed', 'drive_file', $id);
        $this->json(['file' => $file, 'zip' => $this->driveZipPreview($file, $path), 'pdf' => $this->drivePdfPreview($file, $path)]);
    }

    private function driveOnlyOfficeConfig(array $user, int $id): void
    {
        $this->requireEditor($user);
        $file = $this->driveFileAccess($user, $id, 'edit');
        $office = $this->driveOfficeType($file);
        if (!$office) throw new RuntimeException('This file type cannot be edited with OnlyOffice');
        $publicUrl = Config::onlyOfficePublicUrl();
        if (Config::onlyOfficeUrl() === '' || $publicUrl === '') throw new RuntimeException('OnlyOffice is not configured');
        $secret = $this->onlyOfficeSecret();
        $baseUrl = Config::onlyOfficeCallbackBaseUrl() ?: $this->origin();
        $baseUrl = rtrim($baseUrl, '/');
        $downloadToken = $this->onlyOfficeSignedToken(['purpose' => 'download', 'file_id' => (int)$file['id'], 'user_id' => (int)$user['id'], 'exp' => time() + 12 * 3600]);
        $callbackToken = $this->onlyOfficeSignedToken(['purpose' => 'callback', 'file_id' => (int)$file['id'], 'user_id' => (int)$user['id'], 'exp' => time() + 12 * 3600]);
        $config = [
            'documentType' => $office['documentType'],
            'document' => [
                'fileType' => $office['fileType'],
                'key' => $this->onlyOfficeDocumentKey($file),
                'title' => (string)$file['original_name'],
                'url' => $baseUrl . '/api/integrations/onlyoffice/download/' . $downloadToken,
                'permissions' => ['edit' => true, 'download' => true, 'print' => true],
            ],
            'editorConfig' => [
                'callbackUrl' => $baseUrl . '/api/integrations/onlyoffice/callback/' . $callbackToken,
                'mode' => 'edit',
                'lang' => 'en',
                'user' => ['id' => (string)$user['id'], 'name' => (string)($user['name'] ?: $user['email'])],
                'customization' => ['compactToolbar' => true, 'forcesave' => true],
            ],
            'height' => '100%',
            'width' => '100%',
        ];
        $config['token'] = $this->onlyOfficeJwt($config, $secret);
        $this->audit((int)$user['id'], 'drive_file.office_opened', 'drive_file', $id);
        $this->json(['enabled' => true, 'public_url' => $publicUrl, 'api_script' => $publicUrl . '/web-apps/apps/api/documents/api.js', 'config' => $config]);
    }

    private function onlyOfficeDownloadSigned(string $token): void
    {
        $payload = $this->onlyOfficeTokenPayload($token, 'download');
        $file = $this->driveFileById((int)$payload['file_id']);
        $path = $this->driveFilePath($file);
        if (!is_file($path)) throw new RuntimeException('File not found');
        $this->audit((int)($payload['user_id'] ?? 0), 'drive_file.office_downloaded', 'drive_file', (int)$file['id']);
        header_remove('Content-Type');
        header('Content-Type: ' . ($file['mime'] ?: 'application/octet-stream'));
        header('Content-Disposition: ' . $this->contentDisposition('attachment', (string)$file['original_name']));
        header('X-Content-Type-Options: nosniff');
        header('Content-Length: ' . filesize($path));
        readfile($path);
        exit;
    }

    private function onlyOfficeCallback(string $token): void
    {
        $payload = $this->onlyOfficeTokenPayload($token, 'callback');
        $data = $this->input();
        $status = (int)($data['status'] ?? 0);
        if (!in_array($status, [2, 6], true)) $this->json(['error' => 0]);
        $url = trim((string)($data['url'] ?? ''));
        if ($url === '') throw new RuntimeException('OnlyOffice save URL missing');
        $file = $this->driveFileById((int)$payload['file_id']);
        if (!$this->driveOfficeType($file)) throw new RuntimeException('This file type cannot be saved by OnlyOffice');
        $size = $this->onlyOfficeStoreFromUrl($file, $url);
        $path = $this->driveFilePath($file);
        $mime = (new finfo(FILEINFO_MIME_TYPE))->file($path) ?: (string)($file['mime'] ?: 'application/octet-stream');
        $this->updateDriveFileDiskMetadata((int)$file['id'], $path, $mime, $size);
        $this->audit((int)($payload['user_id'] ?? 0), 'drive_file.office_saved', 'drive_file', (int)$file['id']);
        $this->json(['error' => 0]);
    }

    private function drivePdfPreview(array $file, string $path): ?array
    {
        $name = strtolower((string)($file['original_name'] ?? ''));
        $mime = strtolower((string)($file['mime'] ?? ''));
        if (!str_ends_with($name, '.pdf') && $mime !== 'application/pdf') return null;
        $fh = @fopen($path, 'rb');
        if (!$fh) return ['valid' => false, 'error' => 'PDF could not be read'];
        $head = fread($fh, 262144) ?: '';
        fclose($fh);
        if (!str_starts_with($head, '%PDF-')) return ['valid' => false, 'error' => 'File is not a valid PDF'];
        if (!preg_match('/\/Type\s*\/Pages?\b/', $head)) return ['valid' => false, 'error' => 'PDF has no readable pages'];
        return ['valid' => true];
    }

    private function driveZipPreview(array $file, string $path): ?array
    {
        $name = strtolower((string)($file['original_name'] ?? ''));
        $mime = strtolower((string)($file['mime'] ?? ''));
        if (!str_ends_with($name, '.zip') && !in_array($mime, ['application/zip', 'application/x-zip-compressed'], true)) return null;
        if (!class_exists('ZipArchive')) return ['available' => false, 'entries' => [], 'truncated' => false, 'error' => 'ZIP support unavailable'];
        $zip = new ZipArchive();
        if ($zip->open($path) !== true) return ['available' => false, 'entries' => [], 'truncated' => false, 'error' => 'ZIP could not be read'];
        $entries = [];
        $limit = min($zip->numFiles, 200);
        for ($i = 0; $i < $limit; $i++) {
            $stat = $zip->statIndex($i) ?: [];
            $entries[] = [
                'name' => (string)($stat['name'] ?? 'file'),
                'size' => (int)($stat['size'] ?? 0),
                'compressed_size' => (int)($stat['comp_size'] ?? 0),
            ];
        }
        $count = $zip->numFiles;
        $zip->close();
        return ['available' => true, 'entries' => $entries, 'truncated' => $count > $limit, 'count' => $count];
    }

    private function driveStoreGeneratedFile(array $user, ?int $folderId, string $name, string $stored, string $mime, int $size): array
    {
        $stmt = $this->db->prepare('INSERT INTO drive_files (owner_user_id, folder_id, original_name, stored_name, mime, size) VALUES (?, ?, ?, ?, ?, ?)');
        $stmt->execute([(int)$user['id'], $folderId, $name, $stored, $mime, $size]);
        $id = (int)$this->db->lastInsertId();
        return $this->driveFileAccess($user, $id, 'view');
    }

    private function syncDriveSourceFiles(array $user): array
    {
        if (!in_array((string)($user['role'] ?? ''), ['owner', 'admin'], true)) return ['folders' => 0, 'files' => 0];
        $root = rtrim(Config::driveFilesDir(), '/');
        if ($root === '' || !is_dir($root) || !is_readable($root)) return ['folders' => 0, 'files' => 0];
        $userId = (int)$user['id'];
        $seenFolders = [];
        $seenFiles = [];
        $opaqueStoredNames = $this->driveOpaqueStoredNames();
        $this->syncDriveDirectory($userId, $root, '', null, $seenFolders, $seenFiles, $opaqueStoredNames);
        $this->softDeleteMissingDriveSources('drive_files', $userId, $seenFiles);
        $this->softDeleteMissingDriveSources('drive_folders', $userId, $seenFolders);
        return ['folders' => count($seenFolders), 'files' => count($seenFiles)];
    }

    private function driveOpaqueStoredNames(): array
    {
        $stmt = $this->db->query("SELECT stored_name FROM drive_files WHERE deleted = 0 AND (source_path IS NULL OR source_path = '')");
        $names = [];
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $name) {
            $base = basename((string)$name);
            if ($base !== '') $names[$base] = true;
        }
        return $names;
    }

    private function syncDriveDirectory(int $userId, string $root, string $relativeDir, ?int $parentId, array &$seenFolders, array &$seenFiles, array $opaqueStoredNames): void
    {
        $dir = $relativeDir === '' ? $root : $this->driveSourcePath($relativeDir);
        $items = @scandir($dir);
        if ($items === false) return;
        natcasesort($items);
        foreach ($items as $name) {
            if ($name === '.' || $name === '..') continue;
            $relativePath = $relativeDir === '' ? $name : $relativeDir . '/' . $name;
            if (!$this->isSafeDriveSourcePath($relativePath)) continue;
            $path = $dir . '/' . $name;
            if (is_link($path)) continue;
            if (is_dir($path)) {
                $folderId = $this->upsertDriveSourceFolder($userId, $parentId, $name, $relativePath);
                $seenFolders[$relativePath] = true;
                $this->syncDriveDirectory($userId, $root, $relativePath, $folderId, $seenFolders, $seenFiles, $opaqueStoredNames);
                continue;
            }
            if (!is_file($path) || !is_readable($path)) continue;
            if ($relativeDir === '' && isset($opaqueStoredNames[$name])) continue;
            $this->upsertDriveSourceFile($userId, $parentId, $name, $relativePath, $path);
            $seenFiles[$relativePath] = true;
        }
    }

    private function upsertDriveSourceFolder(int $userId, ?int $parentId, string $name, string $sourcePath): int
    {
        $safeName = $this->driveName($name);
        $stmt = $this->db->prepare('SELECT id, parent_id, name, deleted FROM drive_folders WHERE owner_user_id = ? AND source_path = ?');
        $stmt->execute([$userId, $sourcePath]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row) {
            if ((int)$row['deleted'] !== 0 || (string)$row['name'] !== $safeName || (string)($row['parent_id'] ?? '') !== (string)($parentId ?? '')) {
                $this->db->prepare('UPDATE drive_folders SET parent_id = ?, name = ?, deleted = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([$parentId, $safeName, (int)$row['id']]);
            }
            return (int)$row['id'];
        }
        $stmt = $this->db->prepare('INSERT INTO drive_folders (owner_user_id, parent_id, name, source_path) VALUES (?, ?, ?, ?)');
        $stmt->execute([$userId, $parentId, $safeName, $sourcePath]);
        return (int)$this->db->lastInsertId();
    }

    private function upsertDriveSourceFile(int $userId, ?int $folderId, string $name, string $sourcePath, string $path): void
    {
        $safeName = $this->driveName($name);
        $size = filesize($path) ?: 0;
        $mtime = filemtime($path) ?: 0;
        $mime = (new finfo(FILEINFO_MIME_TYPE))->file($path) ?: 'application/octet-stream';
        $stmt = $this->db->prepare('SELECT id, folder_id, original_name, size, source_mtime, mime, deleted FROM drive_files WHERE owner_user_id = ? AND source_path = ?');
        $stmt->execute([$userId, $sourcePath]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row) {
            if ((int)$row['deleted'] !== 0 || (string)$row['original_name'] !== $safeName || (string)($row['folder_id'] ?? '') !== (string)($folderId ?? '') || (int)$row['size'] !== (int)$size || (int)($row['source_mtime'] ?? 0) !== (int)$mtime || (string)($row['mime'] ?? '') !== $mime) {
                $this->db->prepare('UPDATE drive_files SET folder_id = ?, original_name = ?, stored_name = ?, mime = ?, size = ?, source_mtime = ?, deleted = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([$folderId, $safeName, $sourcePath, $mime, (int)$size, (int)$mtime, (int)$row['id']]);
            }
            return;
        }
        $stmt = $this->db->prepare('INSERT INTO drive_files (owner_user_id, folder_id, original_name, stored_name, source_path, source_mtime, mime, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        $stmt->execute([$userId, $folderId, $safeName, $sourcePath, $sourcePath, (int)$mtime, $mime, (int)$size]);
    }

    private function softDeleteMissingDriveSources(string $table, int $userId, array $seen): void
    {
        if (!in_array($table, ['drive_files', 'drive_folders'], true)) throw new RuntimeException('Invalid Drive source table');
        $stmt = $this->db->prepare("SELECT id, source_path FROM $table WHERE owner_user_id = ? AND source_path IS NOT NULL AND deleted = 0");
        $stmt->execute([$userId]);
        $delete = $this->db->prepare("UPDATE $table SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            if (!isset($seen[(string)$row['source_path']])) $delete->execute([(int)$row['id']]);
        }
    }

    private function driveFilePath(array $file): string
    {
        $sourcePath = (string)($file['source_path'] ?? '');
        if ($sourcePath !== '') return $this->driveSourcePath($sourcePath);
        $stored = basename((string)($file['stored_name'] ?? ''));
        if ($stored === '') throw new RuntimeException('File not found');
        return rtrim(Config::driveFilesDir(), '/') . '/' . $stored;
    }

    private function driveSourcePath(string $relativePath): string
    {
        $relativePath = str_replace('\\', '/', trim($relativePath));
        if (!$this->isSafeDriveSourcePath($relativePath)) throw new RuntimeException('Unsafe Drive path');
        $root = rtrim(Config::driveFilesDir(), '/');
        $path = $root . '/' . $relativePath;
        $rootReal = realpath($root);
        $pathReal = realpath($path);
        if ($rootReal !== false && $pathReal !== false) {
            $rootPrefix = rtrim(str_replace('\\', '/', $rootReal), '/') . '/';
            $normalizedPath = str_replace('\\', '/', $pathReal);
            if (!str_starts_with($normalizedPath, $rootPrefix)) throw new RuntimeException('Unsafe Drive path');
        }
        $current = $root;
        foreach (explode('/', $relativePath) as $part) {
            $current .= '/' . $part;
            if (is_link($current)) throw new RuntimeException('Unsafe Drive path');
        }
        return $path;
    }

    private function isSafeDriveSourcePath(string $path): bool
    {
        $path = str_replace('\\', '/', trim($path));
        if ($path === '' || str_starts_with($path, '/') || preg_match('/^[a-zA-Z]:\//', $path)) return false;
        foreach (explode('/', $path) as $part) {
            if ($part === '' || $part === '.' || $part === '..' || str_starts_with($part, '.')) return false;
        }
        return true;
    }

    private function updateDriveFileDiskMetadata(int $id, string $path, string $mime, int $size): void
    {
        $mtime = filemtime($path) ?: null;
        $this->db->prepare('UPDATE drive_files SET mime = ?, size = ?, source_mtime = COALESCE(?, source_mtime), updated_at = CURRENT_TIMESTAMP WHERE id = ?')->execute([$mime, $size, $mtime, $id]);
    }

    private function migrateDriveFiles(string $fromDir, string $toDir): void
    {
        $stmt = $this->db->query("SELECT stored_name FROM drive_files WHERE deleted = 0 AND (source_path IS NULL OR source_path = '')");
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $storedName) {
            $name = basename((string)$storedName);
            if ($name === '') continue;
            $source = rtrim($fromDir, '/') . '/' . $name;
            $target = rtrim($toDir, '/') . '/' . $name;
            if (!is_file($source) || is_file($target)) continue;
            if (!copy($source, $target)) throw new RuntimeException('Drive files could not be migrated to the new storage path');
            @chmod($target, 0600);
        }
    }

    private function driveAddFolderToZip(ZipArchive $zip, int $folderId, string $entryPath): void
    {
        $entryPath = trim($this->driveZipPathName($entryPath), '/');
        if ($entryPath !== '') $zip->addEmptyDir($entryPath);
        $folderStmt = $this->db->prepare('SELECT id, name FROM drive_folders WHERE deleted = 0 AND parent_id = ? ORDER BY name COLLATE NOCASE');
        $folderStmt->execute([$folderId]);
        foreach ($folderStmt->fetchAll(PDO::FETCH_ASSOC) as $folder) {
            $this->driveAddFolderToZip($zip, (int)$folder['id'], $entryPath . '/' . (string)$folder['name']);
        }
        $fileStmt = $this->db->prepare('SELECT * FROM drive_files WHERE deleted = 0 AND folder_id = ? ORDER BY original_name COLLATE NOCASE');
        $fileStmt->execute([$folderId]);
        foreach ($fileStmt->fetchAll(PDO::FETCH_ASSOC) as $file) {
            $path = $this->driveFilePath($file);
            if (!is_file($path)) continue;
            $entry = trim($entryPath . '/' . $this->driveZipEntryName((string)$file['original_name']), '/');
            if (!$zip->addFile($path, $entry)) throw new RuntimeException('File could not be added to ZIP');
        }
    }

    private function driveZipName(string $name): string
    {
        $base = preg_replace('/\.zip$/i', '', $this->driveName($name));
        return substr($base ?: 'Archive', 0, 170) . '.zip';
    }

    private function driveExtractFolderName(string $name): string
    {
        $base = preg_replace('/\.zip$/i', '', $this->driveName($name));
        return substr($base ?: 'Extracted archive', 0, 170);
    }

    private function driveZipEntryName(string $name): string
    {
        return trim(str_replace(['\\', "\r", "\n"], ['/', '_', '_'], $this->driveName($name)), '/');
    }

    private function driveZipPathName(string $path): string
    {
        $parts = array_values(array_filter(explode('/', str_replace('\\', '/', $path)), static fn($part) => $part !== ''));
        return implode('/', array_map(fn($part) => $this->driveZipEntryName($part), $parts));
    }

    private function driveSafeZipEntry(string $entry): string
    {
        $entry = str_replace('\\', '/', trim($entry));
        if ($entry === '' || str_starts_with($entry, '/') || preg_match('/^[a-zA-Z]:\//', $entry)) throw new RuntimeException('ZIP contains an unsafe path');
        $parts = array_values(array_filter(explode('/', $entry), static fn($part) => $part !== '' && $part !== '.'));
        if (!$parts || in_array('..', $parts, true)) throw new RuntimeException('ZIP contains an unsafe path');
        return implode('/', array_map(fn($part) => $this->driveName($part), $parts)) . (str_ends_with($entry, '/') ? '/' : '');
    }

    private function driveCreateExtractFolder(array $user, ?int $parentId, string $name): int
    {
        $stmt = $this->db->prepare('INSERT INTO drive_folders (owner_user_id, parent_id, name) VALUES (?, ?, ?)');
        $stmt->execute([(int)$user['id'], $parentId, $name]);
        return (int)$this->db->lastInsertId();
    }

    private function driveEnsureExtractFolder(array $user, array &$folderMap, string $path): int
    {
        $path = trim(str_replace('\\', '/', $path), '/');
        if ($path === '') return $folderMap[''];
        $currentPath = '';
        foreach (explode('/', $path) as $part) {
            $parentPath = $currentPath;
            $currentPath = $currentPath === '' ? $part : $currentPath . '/' . $part;
            if (isset($folderMap[$currentPath])) continue;
            $folderMap[$currentPath] = $this->driveCreateExtractFolder($user, $folderMap[$parentPath], $this->driveName($part));
        }
        return $folderMap[$path];
    }

    private function driveStoreExtractedFile(array $user, int $folderId, string $name, string $content): void
    {
        $dir = Config::driveFilesDir();
        if (!is_dir($dir) && !mkdir($dir, 0775, true)) throw new RuntimeException('Drive storage unavailable');
        $safeName = $this->driveName($name);
        $stored = bin2hex(random_bytes(16)) . '-' . preg_replace('/[^a-zA-Z0-9._-]/', '_', $safeName);
        $path = $dir . '/' . $stored;
        if (file_put_contents($path, $content, LOCK_EX) === false) throw new RuntimeException('Extracted file could not be saved');
        @chmod($path, 0600);
        $mime = (new finfo(FILEINFO_MIME_TYPE))->file($path) ?: 'application/octet-stream';
        $this->driveStoreGeneratedFile($user, $folderId, $safeName, $stored, $mime, strlen($content));
    }

    private function driveListShares(array $user, string $kind, int $id): void
    {
        [$type, $subject] = $this->driveShareSubject($user, $kind, $id, 'admin');
        $stmt = $this->db->prepare('SELECT s.user_id, s.permission, u.email, u.name FROM drive_shares s JOIN users u ON u.id = s.user_id WHERE s.item_type = ? AND s.item_id = ? ORDER BY u.email');
        $stmt->execute([$type, $id]);
        $this->json(['shares' => $stmt->fetchAll(PDO::FETCH_ASSOC), 'item' => $subject]);
    }

    private function driveShare(array $user, string $kind, int $id): void
    {
        [$type] = $this->driveShareSubject($user, $kind, $id, 'admin');
        $data = $this->input();
        $email = strtolower(trim((string)($data['email'] ?? '')));
        $permission = (string)($data['permission'] ?? 'view');
        if (!in_array($permission, ['view', 'edit', 'admin'], true)) throw new RuntimeException('Invalid permission');
        $stmt = $this->db->prepare('SELECT id FROM users WHERE email = ? AND disabled = 0');
        $stmt->execute([$email]);
        $shareUserId = (int)$stmt->fetchColumn();
        if (!$shareUserId) throw new RuntimeException('User not found');
        if ($shareUserId === (int)$user['id']) throw new RuntimeException('Owner already has access');
        $this->db->prepare('INSERT INTO drive_shares (item_type, item_id, user_id, permission) VALUES (?, ?, ?, ?) ON CONFLICT(item_type, item_id, user_id) DO UPDATE SET permission = excluded.permission')->execute([$type, $id, $shareUserId, $permission]);
        $this->audit((int)$user['id'], 'drive_' . $type . '.shared', 'drive_' . $type, $id);
        $this->driveListShares($user, $kind, $id);
    }

    private function driveUnshare(array $user, string $kind, int $id, int $shareUserId): void
    {
        [$type] = $this->driveShareSubject($user, $kind, $id, 'admin');
        $this->db->prepare('DELETE FROM drive_shares WHERE item_type = ? AND item_id = ? AND user_id = ?')->execute([$type, $id, $shareUserId]);
        $this->audit((int)$user['id'], 'drive_' . $type . '.unshared', 'drive_' . $type, $id);
        $this->driveListShares($user, $kind, $id);
    }

    private function driveShareSubject(array $user, string $kind, int $id, string $level): array
    {
        if ($kind === 'folders') return ['folder', $this->driveFolderAccess($user, $id, $level)];
        if ($kind === 'files') return ['file', $this->driveFileAccess($user, $id, $level)];
        throw new RuntimeException('Invalid Drive item type');
    }

    private function driveFolderAccess(array $user, int $id, string $level): array
    {
        $stmt = $this->db->prepare('SELECT * FROM drive_folders WHERE id = ? AND deleted = 0');
        $stmt->execute([$id]);
        $folder = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$folder) throw new RuntimeException('Folder not found');
        $permission = $this->drivePermission($user, 'folder', $id, (int)$folder['owner_user_id']);
        if (!$permission && !empty($folder['parent_id'])) {
            $parent = $this->driveFolderAccess($user, (int)$folder['parent_id'], 'view');
            $permission = (string)($parent['permission'] ?? 'view');
        }
        $this->requireDrivePermission($permission, $level, 'Folder permission required');
        $folder['permission'] = $permission;
        return $folder;
    }

    private function driveFileAccess(array $user, int $id, string $level): array
    {
        $stmt = $this->db->prepare('SELECT * FROM drive_files WHERE id = ? AND deleted = 0');
        $stmt->execute([$id]);
        $file = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$file) throw new RuntimeException('File not found');
        $permission = $this->drivePermission($user, 'file', $id, (int)$file['owner_user_id']);
        if (!$permission && !empty($file['folder_id'])) {
            $folder = $this->driveFolderAccess($user, (int)$file['folder_id'], 'view');
            $permission = (string)($folder['permission'] ?? 'view');
        }
        $this->requireDrivePermission($permission, $level, 'File permission required');
        $file['permission'] = $permission;
        return $file;
    }

    private function drivePermission(array $user, string $type, int $id, int $ownerId): ?string
    {
        if ($ownerId === (int)$user['id']) return 'owner';
        $stmt = $this->db->prepare('SELECT permission FROM drive_shares WHERE item_type = ? AND item_id = ? AND user_id = ?');
        $stmt->execute([$type, $id, (int)$user['id']]);
        $permission = $stmt->fetchColumn();
        return $permission ? (string)$permission : null;
    }

    private function requireDrivePermission(?string $permission, string $level, string $message): void
    {
        $rank = ['view' => 1, 'read' => 1, 'edit' => 2, 'admin' => 3, 'owner' => 4];
        if (($rank[$permission ?? ''] ?? 0) < ($rank[$level] ?? 1)) throw new RuntimeException($message);
    }

    private function driveFolderHasAncestor(int $folderId, int $ancestorId): bool
    {
        $current = $folderId;
        while ($current > 0) {
            if ($current === $ancestorId) return true;
            $stmt = $this->db->prepare('SELECT parent_id FROM drive_folders WHERE id = ?');
            $stmt->execute([$current]);
            $current = (int)$stmt->fetchColumn();
        }
        return false;
    }

    private function driveBreadcrumbs(array $user, ?int $folderId): array
    {
        $crumbs = [];
        $current = $folderId ?: 0;
        while ($current > 0) {
            $folder = $this->driveFolderAccess($user, $current, 'view');
            array_unshift($crumbs, ['id' => (int)$folder['id'], 'name' => $folder['name']]);
            $current = (int)($folder['parent_id'] ?? 0);
        }
        return $crumbs;
    }

    private function driveName($value): string
    {
        $name = trim((string)$value);
        if ($name === '') throw new RuntimeException('Name required');
        return substr(str_replace(["\r", "\n", '/', '\\'], '_', $name), 0, 180);
    }

    private function driveTextEditable(array $file): bool
    {
        $name = strtolower((string)($file['original_name'] ?? ''));
        $mime = strtolower((string)($file['mime'] ?? ''));
        if (str_starts_with($mime, 'text/')) return true;
        if (in_array($mime, ['application/json', 'application/xml', 'application/csv', 'application/x-yaml'], true)) return true;
        return (bool)preg_match('/\.(txt|md|markdown|csv|json|xml|yaml|yml|log|html|css|js|ts)$/', $name);
    }

    private function driveOfficeType(array $file): ?array
    {
        $ext = strtolower(pathinfo((string)($file['original_name'] ?? ''), PATHINFO_EXTENSION));
        if (in_array($ext, ['doc', 'docx', 'docm', 'dot', 'dotx', 'odt', 'ott', 'rtf'], true)) return ['documentType' => 'word', 'fileType' => $ext];
        if (in_array($ext, ['xls', 'xlsx', 'xlsm', 'xlt', 'xltx', 'ods', 'ots'], true)) return ['documentType' => 'cell', 'fileType' => $ext];
        if (in_array($ext, ['ppt', 'pptx', 'pptm', 'pot', 'potx', 'odp', 'otp'], true)) return ['documentType' => 'slide', 'fileType' => $ext];
        return null;
    }

    private function driveFileById(int $id): array
    {
        $stmt = $this->db->prepare('SELECT * FROM drive_files WHERE id = ? AND deleted = 0');
        $stmt->execute([$id]);
        $file = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$file) throw new RuntimeException('File not found');
        return $file;
    }

    private function onlyOfficeSecret(): string
    {
        $secret = Config::onlyOfficeJwtSecret();
        if ($secret === '') throw new RuntimeException('OnlyOffice JWT secret is required');
        return $secret;
    }

    private function onlyOfficeSignedToken(array $payload): string
    {
        $body = $this->base64UrlEncode(json_encode($payload, JSON_UNESCAPED_SLASHES) ?: '{}');
        $sig = $this->base64UrlEncode(hash_hmac('sha256', $body, $this->onlyOfficeSecret(), true));
        return $body . '.' . $sig;
    }

    private function onlyOfficeTokenPayload(string $token, string $purpose): array
    {
        [$body, $sig] = array_pad(explode('.', $token, 2), 2, '');
        if ($body === '' || $sig === '') throw new RuntimeException('Invalid OnlyOffice token');
        $expected = $this->base64UrlEncode(hash_hmac('sha256', $body, $this->onlyOfficeSecret(), true));
        if (!hash_equals($expected, $sig)) throw new RuntimeException('Invalid OnlyOffice token');
        $payload = json_decode($this->base64UrlDecode($body), true);
        if (!is_array($payload) || ($payload['purpose'] ?? '') !== $purpose || empty($payload['file_id'])) throw new RuntimeException('Invalid OnlyOffice token');
        if ((int)($payload['exp'] ?? 0) < time()) throw new RuntimeException('OnlyOffice token expired');
        return $payload;
    }

    private function onlyOfficeJwt(array $payload, string $secret): string
    {
        $header = $this->base64UrlEncode(json_encode(['alg' => 'HS256', 'typ' => 'JWT'], JSON_UNESCAPED_SLASHES) ?: '{}');
        $body = $this->base64UrlEncode(json_encode($payload, JSON_UNESCAPED_SLASHES) ?: '{}');
        $sig = $this->base64UrlEncode(hash_hmac('sha256', $header . '.' . $body, $secret, true));
        return $header . '.' . $body . '.' . $sig;
    }

    private function onlyOfficeDocumentKey(array $file): string
    {
        return substr(preg_replace('/[^A-Za-z0-9_-]/', '', 'dv-' . (int)$file['id'] . '-' . hash('sha256', (string)$file['updated_at'] . ':' . (string)$file['size'])), 0, 64);
    }

    private function onlyOfficeStoreFromUrl(array $file, string $url): int
    {
        $parts = parse_url($url);
        if (!is_array($parts) || !in_array(strtolower((string)($parts['scheme'] ?? '')), ['http', 'https'], true)) throw new RuntimeException('Invalid OnlyOffice save URL');
        $source = @fopen($url, 'rb', false, stream_context_create(['http' => ['timeout' => 60, 'follow_location' => 0, 'ignore_errors' => false]]));
        if (!$source) throw new RuntimeException('OnlyOffice saved file could not be downloaded');
        $tmp = tempnam(Config::dir() . '/tmp', 'office-');
        if (!$tmp) {
            fclose($source);
            throw new RuntimeException('Temporary storage unavailable');
        }
        $target = @fopen($tmp, 'wb');
        if (!$target) {
            fclose($source);
            @unlink($tmp);
            throw new RuntimeException('Temporary storage unavailable');
        }
        $size = 0;
        $limit = Config::driveUploadMaxBytes();
        while (!feof($source)) {
            $chunk = fread($source, 1024 * 1024);
            if ($chunk === false) break;
            $size += strlen($chunk);
            if ($size > $limit) {
                fclose($source);
                fclose($target);
                @unlink($tmp);
                throw new RuntimeException('Saved document exceeds Drive upload limit');
            }
            if ($chunk !== '' && fwrite($target, $chunk) === false) {
                fclose($source);
                fclose($target);
                @unlink($tmp);
                throw new RuntimeException('Saved document could not be written');
            }
        }
        fclose($source);
        fclose($target);
        $path = $this->driveFilePath($file);
        if (!is_file($path)) {
            @unlink($tmp);
            throw new RuntimeException('File not found');
        }
        if (!@rename($tmp, $path)) {
            if (!@copy($tmp, $path)) {
                @unlink($tmp);
                throw new RuntimeException('Saved document could not be stored');
            }
            @unlink($tmp);
        }
        @chmod($path, 0600);
        return $size;
    }

    private function driveEditableMime(string $name, string $fallback): string
    {
        $lower = strtolower($name);
        return match (true) {
            str_ends_with($lower, '.md'), str_ends_with($lower, '.markdown') => 'text/markdown',
            str_ends_with($lower, '.csv') => 'text/csv',
            str_ends_with($lower, '.json') => 'application/json',
            str_ends_with($lower, '.xml') => 'application/xml',
            str_ends_with($lower, '.html') => 'text/html',
            str_ends_with($lower, '.css') => 'text/css',
            str_ends_with($lower, '.js') => 'text/javascript',
            default => $fallback !== '' ? $fallback : 'text/plain',
        };
    }

    private function revealSecret(array $user, int $id): void
    {
        $this->requireEditor($user);
        $stmt = $this->db->prepare('SELECT s.* FROM note_secrets s JOIN notes n ON n.id = s.note_id WHERE s.id = ? AND n.user_id = ?');
        $stmt->execute([$id, (int)$user['id']]);
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

    private function updateUserAdmin(array $user, int $id): void
    {
        $this->requireAdmin($user);
        $target = $this->userById($id);
        $this->assertCanManageUser($user, $target, 'reset password for');
        if ((int)$target['id'] === (int)$user['id']) throw new RuntimeException('Use Account settings to change your own password');
        if ((int)($target['disabled'] ?? 0) === 1) throw new RuntimeException('Disabled users cannot be updated');

        $data = $this->input();
        $password = (string)($data['password'] ?? '');
        if (strlen($password) < 10) throw new RuntimeException('Password must be at least 10 characters');
        if (($data['password_confirm'] ?? $password) !== $password) throw new RuntimeException('Passwords do not match');

        $this->db->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([password_hash($password, PASSWORD_DEFAULT), $id]);
        $this->db->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$id]);
        $this->audit((int)$user['id'], 'user.password_reset', 'user', $id);
        $this->json(['ok' => true]);
    }

    private function deleteUserAdmin(array $user, int $id): void
    {
        $this->requireAdmin($user);
        $target = $this->userById($id);
        $this->assertCanManageUser($user, $target, 'delete');
        if ((int)$target['id'] === (int)$user['id']) throw new RuntimeException('You cannot delete your own account');
        if ((string)$target['role'] === 'owner' && $this->activeOwnerCount() <= 1) throw new RuntimeException('Cannot delete the last active owner');

        $this->db->prepare('UPDATE users SET disabled = 1 WHERE id = ?')->execute([$id]);
        $this->db->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$id]);
        $this->audit((int)$user['id'], 'user.disabled', 'user', $id);
        $this->json(['ok' => true]);
    }

    private function userById(int $id): array
    {
        $stmt = $this->db->prepare('SELECT id, email, name, role, disabled FROM users WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) throw new RuntimeException('User not found');
        return $row;
    }

    private function assertCanManageUser(array $actor, array $target, string $action): void
    {
        if ((string)$target['role'] === 'owner' && (string)$actor['role'] !== 'owner') {
            throw new RuntimeException('Owner role required to ' . $action . ' an owner');
        }
    }

    private function activeOwnerCount(): int
    {
        return (int)$this->db->query("SELECT COUNT(*) FROM users WHERE role = 'owner' AND disabled = 0")->fetchColumn();
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
            foreach (['app.sqlite', 'drive-storage.json', 'keys/master.key'] as $file) {
                $path = Config::dir() . '/' . $file;
                if (file_exists($path)) $this->addBackupFile($zip, $path, $file, $encrypt);
            }
            $filesDir = Config::dir() . '/files';
            foreach (glob($filesDir . '/*') ?: [] as $file) {
                if (is_file($file)) $this->addBackupFile($zip, $file, 'files/' . basename($file), $encrypt);
            }
            $driveFilesDir = Config::driveFilesDir();
            $this->addBackupDirectoryFiles($zip, $driveFilesDir, 'drive-files', $encrypt);
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

    private function addBackupDirectoryFiles(ZipArchive $zip, string $root, string $entryRoot, bool $encrypt): void
    {
        if (!is_dir($root)) return;
        $root = rtrim($root, '/');
        $items = @scandir($root);
        if ($items === false) return;
        $stack = [''];
        while ($stack) {
            $relativeDir = array_pop($stack);
            $dir = $relativeDir === '' ? $root : $root . '/' . $relativeDir;
            $items = @scandir($dir);
            if ($items === false) continue;
            foreach ($items as $name) {
                if ($name === '.' || $name === '..') continue;
                $relativePath = $relativeDir === '' ? $name : $relativeDir . '/' . $name;
                if (!$this->isSafeDriveSourcePath($relativePath)) continue;
                $path = $dir . '/' . $name;
                if (is_link($path)) continue;
                if (is_dir($path)) {
                    $stack[] = $relativePath;
                    continue;
                }
                if (is_file($path)) $this->addBackupFile($zip, $path, $entryRoot . '/' . $relativePath, $encrypt);
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
            if ($entry === false || str_contains($entry, '\\') || str_starts_with($entry, '/')) {
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
            if ($entry === 'drive-storage.json') {
                $this->validateDriveStorageBackupSettings((string)($zip->getFromIndex($i) ?: ''));
                continue;
            }
            if (preg_match('#^files/[^/]+$#', $entry)) continue;
            if (preg_match('#^drive-files/(.+)$#', $entry, $m) && $this->isSafeDriveSourcePath((string)$m[1])) continue;
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

    private function validateDriveStorageBackupSettings(string $content): void
    {
        $settings = json_decode($content, true);
        if (!is_array($settings)) throw new RuntimeException('Backup ZIP contains invalid Drive storage settings');
        $dir = trim((string)($settings['drive_files_dir'] ?? ''));
        if ($dir === '') return;
        $dir = rtrim($dir, '/');
        if (!str_starts_with($dir, '/') || in_array($dir, ['/', '/proc', '/sys', '/dev'], true)) {
            throw new RuntimeException('Backup ZIP contains unsafe Drive storage settings');
        }
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
        $driveFilesDir = Config::driveFilesDir();
        foreach (['files', 'keys'] as $dir) {
            if (!is_dir($configDir . '/' . $dir) && !mkdir($configDir . '/' . $dir, 0775, true)) {
                $zip->close();
                throw new RuntimeException('Unable to prepare restore directory');
            }
        }
        if (!is_dir($driveFilesDir) && !mkdir($driveFilesDir, 0775, true)) {
            $zip->close();
            throw new RuntimeException('Unable to prepare restore directory');
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
        $driveStorage = $zip->getFromName('drive-storage.json');
        if ($driveStorage !== false) {
            if (file_put_contents($configDir . '/drive-storage.json', $driveStorage) === false) {
                $zip->close();
                throw new RuntimeException('Unable to restore Drive storage settings');
            }
            @chmod($configDir . '/drive-storage.json', 0600);
            $driveFilesDir = Config::driveFilesDir();
            if (!is_dir($driveFilesDir) && !mkdir($driveFilesDir, 0775, true)) {
                $zip->close();
                throw new RuntimeException('Unable to prepare restore directory');
            }
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
        $this->removeDirectoryFiles($driveFilesDir);
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $entry = $zip->getNameIndex($i);
            $driveMatch = [];
            if (!is_string($entry) || (!preg_match('#^files/[^/]+$#', $entry) && !preg_match('#^drive-files/(.+)$#', $entry, $driveMatch))) continue;
            $content = $zip->getFromIndex($i);
            if ($content === false) {
                $zip->close();
                throw new RuntimeException('Unable to restore file attachment');
            }
            if (!empty($driveMatch)) {
                $relativePath = (string)$driveMatch[1];
                if (!$this->isSafeDriveSourcePath($relativePath)) continue;
                $target = rtrim($driveFilesDir, '/') . '/' . $relativePath;
                $targetDir = dirname($target);
                if (!is_dir($targetDir) && !mkdir($targetDir, 0775, true)) {
                    $zip->close();
                    throw new RuntimeException('Unable to prepare restore directory');
                }
            } else {
                $target = $configDir . '/' . $entry;
            }
            if (file_put_contents($target, $content) === false) {
                $zip->close();
                throw new RuntimeException('Unable to restore file attachment');
            }
            @chmod($target, 0600);
        }
        $zip->close();
    }

    private function removeDirectoryFiles(string $root): void
    {
        if (!is_dir($root)) return;
        $items = @scandir($root);
        if ($items === false) return;
        foreach ($items as $name) {
            if ($name === '.' || $name === '..') continue;
            $path = rtrim($root, '/') . '/' . $name;
            if (is_link($path)) continue;
            if (is_dir($path)) {
                $this->removeDirectoryFiles($path);
                @rmdir($path);
                continue;
            }
            if (is_file($path)) @unlink($path);
        }
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

    private function note(int $id, ?array $user = null): array
    {
        $sql = 'SELECT * FROM notes WHERE id = ?';
        $args = [$id];
        if ($user !== null) {
            $sql .= ' AND user_id = ?';
            $args[] = (int)$user['id'];
        }
        $stmt = $this->db->prepare($sql);
        $stmt->execute($args);
        $note = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$note) throw new RuntimeException('Note not found');
        return $note;
    }

    private function noteOrNull(int $id, ?array $user = null): ?array
    {
        $sql = 'SELECT * FROM notes WHERE id = ?';
        $args = [$id];
        if ($user !== null) {
            $sql .= ' AND user_id = ?';
            $args[] = (int)$user['id'];
        }
        $stmt = $this->db->prepare($sql);
        $stmt->execute($args);
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
        if ($provided === '') $provided = trim($_SERVER['HTTP_X_API_KEY'] ?? '');
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

    private function requireAssistantUser(): array
    {
        $configuredToken = Config::assistantApiToken();
        if ($configuredToken === '') throw new RuntimeException('Assistant API is not configured');
        $provided = $this->apiTokenFromRequest();
        if ($provided === '' || !hash_equals($configuredToken, $provided)) throw new RuntimeException('Assistant API token required');

        $email = Config::assistantUserEmail();
        if ($email === '') throw new RuntimeException('Assistant user email is not configured');
        $stmt = $this->db->prepare('SELECT * FROM users WHERE email = ? AND disabled = 0');
        $stmt->execute([$email]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$user) throw new RuntimeException('Assistant user not found');
        return $user;
    }

    private function apiTokenFromRequest(): string
    {
        $header = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
        if (preg_match('/^Bearer\s+(.+)$/i', $header, $m)) return trim($m[1]);
        $provided = trim($_SERVER['HTTP_X_DIVAULT_AI_TOKEN'] ?? '');
        if ($provided !== '') return $provided;
        return trim($_SERVER['HTTP_X_API_KEY'] ?? '');
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
        $onlyOfficeSource = $this->onlyOfficeCspSource();
        $scriptSrc = "script-src 'self'" . ($onlyOfficeSource ? ' ' . $onlyOfficeSource : '');
        $connectSrc = "connect-src 'self'" . ($onlyOfficeSource ? ' ' . $onlyOfficeSource : '');
        $frameSrc = "frame-src 'self' blob:" . ($onlyOfficeSource ? ' ' . $onlyOfficeSource : '');

        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: SAMEORIGIN');
        header('Referrer-Policy: same-origin');
        header('Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
        header("Content-Security-Policy: default-src 'self'; {$scriptSrc}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; {$connectSrc}; media-src 'self' blob:; {$frameSrc}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
        if ($this->isSecureRequest()) {
            header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
        }
    }

    private function onlyOfficeCspSource(): string
    {
        $url = Config::onlyOfficePublicUrl();
        if ($url === '') return '';
        $parts = parse_url($url);
        $scheme = strtolower((string)($parts['scheme'] ?? ''));
        $host = (string)($parts['host'] ?? '');
        if (!in_array($scheme, ['http', 'https'], true) || $host === '') return '';
        $port = isset($parts['port']) ? ':' . (int)$parts['port'] : '';
        return $scheme . '://' . $host . $port;
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
        return str_starts_with($mime, 'image/') || str_starts_with($mime, 'audio/') || str_starts_with($mime, 'video/') || in_array($mime, ['application/pdf', 'text/plain', 'text/markdown'], true);
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
        $stmt = $this->db->prepare('SELECT COUNT(*) FROM users WHERE email = ?');
        $stmt->execute([$email]);
        if ((int)$stmt->fetchColumn() > 0) throw new RuntimeException('A user with this email already exists');
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
        if ($this->inputOverride !== null) return $this->inputOverride;
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
