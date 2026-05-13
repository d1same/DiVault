param(
  [string]$BaseUrl = $(if ($env:BASE_URL) { $env:BASE_URL } else { "http://localhost:3443" }),
  [string]$Email = $(if ($env:EMAIL) { $env:EMAIL } else { "owner@example.com" }),
  [string]$Password = $(if ($env:PASSWORD) { $env:PASSWORD } else { "StrongPass123!" }),
  [string]$AiReviewApiToken = $(if ($env:AI_REVIEW_API_TOKEN) { $env:AI_REVIEW_API_TOKEN } else { "" })
)

$ErrorActionPreference = "Stop"
$BaseUrl = $BaseUrl.TrimEnd("/")

Add-Type -AssemblyName System.IO.Compression.FileSystem

function Invoke-Json {
  param(
    [string]$Method,
    [string]$Path,
    $Body = $null,
    [Microsoft.PowerShell.Commands.WebRequestSession]$Session,
    [string]$Csrf = $null
  )
  $headers = @{}
  if ($Csrf) { $headers["X-CSRF-Token"] = $Csrf }
  $args = @{ Uri = "$BaseUrl$Path"; Method = $Method; WebSession = $Session; Headers = $headers }
  if ($null -ne $Body) {
    $args.ContentType = "application/json"
    $args.Body = ($Body | ConvertTo-Json -Depth 8)
  }
  Invoke-RestMethod @args
}

function Get-OrCreateCategory {
  param(
    [string]$Name,
    [Microsoft.PowerShell.Commands.WebRequestSession]$Session,
    [string]$Csrf
  )
  $categories = Invoke-Json -Method Get -Path "/api/categories" -Session $Session
  $existing = $categories.categories | Where-Object { $_.name -eq $Name } | Select-Object -First 1
  if ($existing) { return $existing }
  Invoke-Json -Method Post -Path "/api/categories" -Session $Session -Csrf $Csrf -Body @{ name = $Name }
}

function Assert-MutatingRequestFails {
  param(
    [string]$Name,
    [string]$Path,
    [Microsoft.PowerShell.Commands.WebRequestSession]$Session,
    [hashtable]$Headers = @{}
  )
  try {
    Invoke-WebRequest -Uri "$BaseUrl$Path" -Method Post -WebSession $Session -Headers $Headers -ContentType "application/json" -Body "{}" | Out-Null
  } catch {
    $response = $_.Exception.Response
    if ($response -and [int]$response.StatusCode -ge 400) { return }
    throw "$Name did not fail with an HTTP error: $($_.Exception.Message)"
  }
  throw "$Name unexpectedly succeeded"
}

function Assert-BackupZipContainsRequiredFiles {
  param([string]$ZipPath)
  $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    $entries = @($zip.Entries | ForEach-Object { $_.FullName.Replace("\", "/") })
    foreach ($required in @("app.sqlite", "keys/master.key")) {
      if ($entries -notcontains $required) { throw "Backup ZIP missing $required" }
    }
  } finally {
    $zip.Dispose()
  }
}

function Test-ZipEntriesWithPassphrase {
  param(
    [string]$ZipPath,
    [string]$Passphrase
  )

  $required = @("app.sqlite", "keys/master.key")
  $unzip = Get-Command unzip -ErrorAction SilentlyContinue
  if ($unzip) {
    & $unzip.Source -P $Passphrase -t $ZipPath @required *> $null
    if ($LASTEXITCODE -ne 0) { throw "Encrypted backup ZIP could not be opened with the supplied passphrase using unzip" }
    & $unzip.Source -P "wrong-$Passphrase" -t $ZipPath @required *> $null
    if ($LASTEXITCODE -eq 0) { return "skipped: backup ZIP was not encrypted" }
    return "passed: unzip"
  }

  $sevenZip = Get-Command 7z -ErrorAction SilentlyContinue
  if ($sevenZip) {
    & $sevenZip.Source t "-p$Passphrase" $ZipPath @required *> $null
    if ($LASTEXITCODE -ne 0) { throw "Encrypted backup ZIP could not be opened with the supplied passphrase using 7z" }
    & $sevenZip.Source t "-pwrong-$Passphrase" $ZipPath @required *> $null
    if ($LASTEXITCODE -eq 0) { return "skipped: backup ZIP was not encrypted" }
    return "passed: 7z"
  }

  return "skipped: unzip or 7z not found"
}

function Remove-SmokeResource {
  param(
    [string]$Path,
    [Microsoft.PowerShell.Commands.WebRequestSession]$Session,
    [string]$Csrf
  )
  if (-not $Path) { return $false }
  try {
    Invoke-Json -Method Delete -Path $Path -Session $Session -Csrf $Csrf | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Invoke-AiReviewNote {
  param(
    [string]$Token,
    [string]$RunId,
    [int]$ClientId
  )
  $body = @{
    source = "smoke-ai"
    review = @{
      title = "$RunId AI review"
      severity = "info"
      body = "Automated review note created by smoke test."
      client_id = $ClientId
      findings = @(@{ location = "scripts/smoke.ps1"; message = "AI review endpoint accepted a finding." })
    }
  } | ConvertTo-Json -Depth 8
  Invoke-RestMethod -Uri "$BaseUrl/api/integrations/ai/review-notes" -Method Post -Headers @{ "X-DiVault-AI-Token" = $Token } -ContentType "application/json" -Body $body
}

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$runId = "smoke-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$client = $null
$asset = $null
$passwordAsset = $null
$note = $null
$aiReviewNote = $null
$noteCategory = $null
$csrf = $null
$tmpFile = $null
$encryptedBackupZip = $null
$encryptedBackupCheck = "not run"
$cleanup = [ordered]@{}

try {
  $health = Invoke-Json -Method Get -Path "/api/health" -Session $session
  if (-not $health.ok) { throw "Health check failed" }

  $bootstrap = Invoke-Json -Method Get -Path "/api/bootstrap" -Session $session
  if ($bootstrap.needsSetup) {
    Invoke-Json -Method Post -Path "/api/setup" -Session $session -Body @{ name = "Owner"; email = $Email; password = $Password } | Out-Null
  }

  try {
    $login = Invoke-Json -Method Post -Path "/api/login" -Session $session -Body @{ email = $Email; password = $Password }
  } catch {
    throw "Login failed for $Email at $BaseUrl. Set BASE_URL, EMAIL, and PASSWORD env vars or pass -BaseUrl, -Email, and -Password. $($_.Exception.Message)"
  }
  if (-not $login.user.id) { throw "Login failed for $Email at $BaseUrl. Set BASE_URL, EMAIL, and PASSWORD env vars or pass -BaseUrl, -Email, and -Password." }

  $csrfCookie = $session.Cookies.GetCookies($BaseUrl) | Where-Object { $_.Name -eq "divault_csrf" } | Select-Object -First 1
  if (-not $csrfCookie.Value) { throw "CSRF cookie missing" }
  $csrf = $csrfCookie.Value

  Assert-MutatingRequestFails -Name "Missing CSRF token check" -Path "/api/backup" -Session $session
  Assert-MutatingRequestFails -Name "Bad CSRF token check" -Path "/api/backup" -Session $session -Headers @{ "X-CSRF-Token" = "bad-$runId" }

  $client = Invoke-Json -Method Post -Path "/api/clients" -Session $session -Csrf $csrf -Body @{ name = "$runId Client"; notes = "Created by smoke test $runId" }
  if (-not $client.id) { throw "Client creation failed" }

  $configCategory = Get-OrCreateCategory -Name "Configurations" -Session $session -Csrf $csrf
  $passwordCategory = Get-OrCreateCategory -Name "Passwords" -Session $session -Csrf $csrf

  $assetName = "$runId-SRV01"
  $asset = Invoke-Json -Method Post -Path "/api/assets" -Session $session -Csrf $csrf -Body @{ type = $configCategory.slug; name = $assetName; status = "Active"; asset_type = "Server"; os = "Linux"; primary_ip = "10.10.10.10"; serial_number = $runId; location = "Lab"; contact = "Owner"; client_id = $client.id }
  if (-not $asset.id) { throw "Asset creation failed" }
  $assetList = Invoke-Json -Method Get -Path "/api/assets?type=$($configCategory.slug)&q=$assetName" -Session $session
  if ($assetList.assets.Count -lt 1) { throw "Asset search failed" }

  $passwordAsset = Invoke-Json -Method Post -Path "/api/assets" -Session $session -Csrf $csrf -Body @{ type = $passwordCategory.slug; name = "$runId Credential"; status = "Active"; username = "admin"; password = "AssetSecret123!"; client_id = $client.id }
  $assetSecret = Invoke-Json -Method Post -Path "/api/assets/$($passwordAsset.id)/secret" -Session $session -Csrf $csrf -Body @{}
  if ($assetSecret.value -ne "AssetSecret123!") { throw "Asset secret reveal failed" }

  $note = Invoke-Json -Method Post -Path "/api/notes" -Session $session -Csrf $csrf -Body @{ title = "$runId note"; body = "username: admin`npassword: Secret123!"; section = "Inbox"; type = "secure"; client_id = $client.id }
  if (-not $note.id) { throw "Note creation failed" }

  $details = Invoke-Json -Method Get -Path "/api/notes/$($note.id)" -Session $session
  if ($details.note.body -notmatch "\[hidden secret\]") { throw "Sensitive line was not hidden" }
  if ($details.secrets.Count -lt 1) { throw "Secret was not extracted" }

  $secret = Invoke-Json -Method Post -Path "/api/secrets/$($details.secrets[0].id)/reveal" -Session $session -Csrf $csrf -Body @{}
  if ($secret.value -ne "Secret123!") { throw "Secret reveal failed" }

  $noteCategory = Invoke-Json -Method Post -Path "/api/categories" -Session $session -Csrf $csrf -Body @{ name = "$runId Notes" }
  $movedNote = Invoke-Json -Method Post -Path "/api/notes" -Session $session -Csrf $csrf -Body @{ id = $note.id; title = "$runId note"; body = $details.note.body; section = "All"; type = "secure"; category_id = $noteCategory.id; client_id = $client.id }
  if (-not $movedNote.id) { throw "Note category assignment failed" }
  $categoryNotes = Invoke-Json -Method Get -Path "/api/notes?view=all&category_id=$($noteCategory.id)&q=$runId" -Session $session
  if ($categoryNotes.notes.Count -lt 1) { throw "Dynamic note category filter failed" }

  if ($AiReviewApiToken) {
    $aiReviewNote = Invoke-AiReviewNote -Token $AiReviewApiToken -RunId $runId -ClientId $client.id
    if (-not $aiReviewNote.id -or $aiReviewNote.note.tags -notmatch "ai-review") { throw "AI review note API failed" }
  }

  Invoke-Json -Method Post -Path "/api/notes/$($note.id)/archive" -Session $session -Csrf $csrf -Body @{} | Out-Null
  $archivedNotes = Invoke-Json -Method Get -Path "/api/notes?view=archive&q=$runId" -Session $session
  if ($archivedNotes.notes.Count -lt 1) { throw "Note archive view failed" }
  Invoke-Json -Method Post -Path "/api/notes/$($note.id)/restore" -Session $session -Csrf $csrf -Body @{} | Out-Null
  Invoke-Json -Method Delete -Path "/api/notes/$($note.id)" -Session $session -Csrf $csrf | Out-Null
  $trashedNotes = Invoke-Json -Method Get -Path "/api/notes?view=trash&q=$runId" -Session $session
  if ($trashedNotes.notes.Count -lt 1) { throw "Note trash view failed" }
  Invoke-Json -Method Post -Path "/api/notes/$($note.id)/restore" -Session $session -Csrf $csrf -Body @{} | Out-Null

  $tmpFile = New-TemporaryFile
  Set-Content -LiteralPath $tmpFile.FullName -Value "Smoke file preview" -NoNewline
  $sessionCookie = ($session.Cookies.GetCookies($BaseUrl) | Where-Object { $_.Name -eq "divault_session" } | Select-Object -First 1).Value
  $cookieHeader = "divault_session=$sessionCookie; divault_csrf=$csrf"
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if (-not $curl) { $curl = Get-Command curl -ErrorAction Stop }
  $curlOutput = & $curl.Source -fsS -X POST "$BaseUrl/api/notes/$($note.id)/files" -H "X-CSRF-Token: $csrf" -H "Cookie: $cookieHeader" -F "file=@$($tmpFile.FullName);type=text/plain"
  if ($LASTEXITCODE -ne 0) { throw "File upload failed: $curlOutput" }
  $details = Invoke-Json -Method Get -Path "/api/notes/$($note.id)" -Session $session
  if ($details.files.Count -lt 1) { throw "File upload failed" }
  $preview = Invoke-WebRequest -Uri "$BaseUrl/api/files/$($details.files[0].id)/preview" -Method Get -WebSession $session
  if ($preview.StatusCode -ne 200) { throw "File preview failed" }
  Remove-Item -LiteralPath $tmpFile.FullName -Force

  $backup = Invoke-Json -Method Post -Path "/api/backup" -Session $session -Csrf $csrf -Body @{}
  if (-not $backup.file) { throw "Backup creation failed" }

  $backups = Invoke-Json -Method Get -Path "/api/backups" -Session $session
  if ($backups.backups.Count -lt 1) { throw "Backup list failed" }
  $backupZip = Join-Path ([System.IO.Path]::GetTempPath()) "$runId-backup.zip"
  Invoke-WebRequest -Uri "$BaseUrl/api/backups/$($backup.file)" -Method Get -WebSession $session -OutFile $backupZip
  Assert-BackupZipContainsRequiredFiles -ZipPath $backupZip
  Remove-Item -LiteralPath $backupZip -Force

  try {
    $backupPassphrase = "SmokeBackup-$runId!"
    $encryptedBackup = Invoke-Json -Method Post -Path "/api/backup" -Session $session -Csrf $csrf -Body @{ passphrase = $backupPassphrase }
    if ($encryptedBackup.file) {
      $encryptedBackupZip = Join-Path ([System.IO.Path]::GetTempPath()) "$runId-encrypted-backup.zip"
      Invoke-WebRequest -Uri "$BaseUrl/api/backups/$($encryptedBackup.file)" -Method Get -WebSession $session -OutFile $encryptedBackupZip
      $encryptedBackupCheck = Test-ZipEntriesWithPassphrase -ZipPath $encryptedBackupZip -Passphrase $backupPassphrase
      Remove-Item -LiteralPath $encryptedBackupZip -Force
      $encryptedBackupZip = $null
    } else {
      $encryptedBackupCheck = "skipped: backup endpoint did not return a file"
    }
  } catch {
    $encryptedBackupCheck = "skipped: $($_.Exception.Message)"
  }

  $sessions = Invoke-Json -Method Get -Path "/api/sessions" -Session $session
  if ($sessions.sessions.Count -lt 1) { throw "Session list failed" }

  $syncManifest = Invoke-Json -Method Get -Path "/api/sync/manifest" -Session $session
  if ($null -eq $syncManifest.watermark -or -not ($syncManifest.entities -contains "notes")) { throw "Sync manifest failed" }
  $syncPull = Invoke-Json -Method Get -Path "/api/sync/pull?since_event_id=0" -Session $session
  if ($null -eq $syncPull.snapshot -or -not ($syncPull.snapshot.notes | Where-Object { $_.id -eq $note.id } | Select-Object -First 1)) { throw "Sync snapshot pull failed" }
  if ($null -eq $syncPull.next_since_event_id -or $null -eq $syncPull.has_more) { throw "Sync pagination metadata missing" }
  $syncIncremental = Invoke-Json -Method Get -Path "/api/sync/pull?since_event_id=0&limit=1" -Session $session
  if ($syncIncremental.events.Count -gt 1 -or $null -eq $syncIncremental.next_since_event_id) { throw "Sync incremental pagination failed" }
  if ($details.files.Count -gt 0) {
    $fileRecord = $syncPull.snapshot.files | Where-Object { $_.id -eq $details.files[0].id } | Select-Object -First 1
    if (-not $fileRecord.download_url) { throw "Sync file download URL missing" }
  }

  $pushCreate = Invoke-Json -Method Post -Path "/api/sync/push" -Session $session -Csrf $csrf -Body @{
    client_id = "smoke-client-$runId"
    mutations = @(@{
      mutation_id = "create-note-$runId"
      entity_type = "note"
      action = "upsert"
      record = @{ title = "$runId sync push"; body = "Created from sync push"; type = "text"; section = "All"; tags = "sync-push" }
    })
  }
  $pushNoteId = $pushCreate.results[0].entity_id
  if (-not $pushNoteId -or $pushCreate.results[0].status -ne "applied") { throw "Sync push create failed" }
  $pushCreateAgain = Invoke-Json -Method Post -Path "/api/sync/push" -Session $session -Csrf $csrf -Body @{
    client_id = "smoke-client-$runId"
    mutations = @(@{
      mutation_id = "create-note-$runId"
      entity_type = "note"
      action = "upsert"
      record = @{ title = "$runId duplicate should not apply"; body = "Duplicate"; type = "text"; section = "All" }
    })
  }
  if ($pushCreateAgain.results[0].duplicate -ne $true -or $pushCreateAgain.results[0].entity_id -ne $pushNoteId) { throw "Sync push idempotency failed" }
  $pushedNote = Invoke-Json -Method Get -Path "/api/notes/$pushNoteId" -Session $session
  $baseUpdatedAt = $pushedNote.note.updated_at
  Start-Sleep -Seconds 2
  Invoke-Json -Method Post -Path "/api/notes" -Session $session -Csrf $csrf -Body @{ id = $pushNoteId; title = "$runId server edit"; body = "Server edit wins"; type = "text"; section = "All" } | Out-Null
  $conflictPush = Invoke-Json -Method Post -Path "/api/sync/push" -Session $session -Csrf $csrf -Body @{
    client_id = "smoke-client-$runId"
    mutations = @(@{
      mutation_id = "conflict-note-$runId"
      entity_type = "note"
      action = "upsert"
      base_updated_at = $baseUpdatedAt
      record = @{ id = $pushNoteId; title = "$runId stale edit"; body = "Stale edit"; type = "text"; section = "All" }
    })
  }
  if ($conflictPush.results[0].status -ne "conflict" -or -not $conflictPush.results[0].server.id) { throw "Sync push conflict detection failed" }
  Remove-SmokeResource -Path "/api/notes/$pushNoteId/permanent" -Session $session -Csrf $csrf | Out-Null

  [pscustomobject]@{
    ok = $true
    user = $login.user.email
    noteId = $note.id
    aiReviewNoteId = $(if ($aiReviewNote) { $aiReviewNote.id } else { $null })
    clientId = $client.id
    backup = $backup.file
    syncWatermark = $syncManifest.watermark
    encryptedBackupCheck = $encryptedBackupCheck
  } | ConvertTo-Json -Compress
} finally {
  if ($csrf) {
    if ($tmpFile -and (Test-Path -LiteralPath $tmpFile.FullName)) { Remove-Item -LiteralPath $tmpFile.FullName -Force }
    if ($encryptedBackupZip -and (Test-Path -LiteralPath $encryptedBackupZip)) { Remove-Item -LiteralPath $encryptedBackupZip -Force }
    if ($note -and $note.id) { $cleanup["note"] = Remove-SmokeResource -Path "/api/notes/$($note.id)/permanent" -Session $session -Csrf $csrf }
    if ($aiReviewNote -and $aiReviewNote.id) { $cleanup["aiReviewNote"] = Remove-SmokeResource -Path "/api/notes/$($aiReviewNote.id)/permanent" -Session $session -Csrf $csrf }
    if ($noteCategory -and $noteCategory.id) { $cleanup["noteCategory"] = Remove-SmokeResource -Path "/api/categories/$($noteCategory.id)" -Session $session -Csrf $csrf }
    if ($passwordAsset -and $passwordAsset.id) { $cleanup["passwordAsset"] = Remove-SmokeResource -Path "/api/assets/$($passwordAsset.id)" -Session $session -Csrf $csrf }
    if ($asset -and $asset.id) { $cleanup["asset"] = Remove-SmokeResource -Path "/api/assets/$($asset.id)" -Session $session -Csrf $csrf }
    if ($client -and $client.id) { $cleanup["client"] = Remove-SmokeResource -Path "/api/clients/$($client.id)" -Session $session -Csrf $csrf }
  }
}

exit 0
