param(
    [string]$ExePath,
    [string]$PhpBin,
    [string]$ConfigDir,
    [string]$RemoteUrl,
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ExePath) {
    $ExePath = Join-Path $projectRoot 'src-tauri\target\release\divault_desktop.exe'
}

if (-not (Test-Path -LiteralPath $ExePath)) {
    throw "Desktop executable not found at $ExePath. Run scripts\desktop-build.ps1 first."
}

if ($PhpBin) {
    $env:DIVAULT_PHP_BIN = $PhpBin
}

if ($ConfigDir) {
    $env:DIVAULT_DESKTOP_CONFIG = $ConfigDir
}

if ($RemoteUrl) {
    $env:DIVAULT_REMOTE_URL = $RemoteUrl
} else {
    $existing = Get-NetTCPConnection -LocalPort 3444 -ErrorAction SilentlyContinue
    if ($existing) {
        throw 'Port 3444 is already in use; close the other process before running the desktop smoke test.'
    }
}

$app = Start-Process -FilePath $ExePath -WorkingDirectory $projectRoot -PassThru
$ok = $false

try {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $healthUrl = if ($RemoteUrl) { "$($RemoteUrl.TrimEnd('/'))/api/health" } else { 'http://127.0.0.1:3444/api/health' }
            $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
            if ($response.ok -eq $true) {
                $ok = $true
                break
            }
        }
        catch {
            Start-Sleep -Milliseconds 500
        }
    }

    if (-not $ok) {
        throw 'Desktop health endpoint did not respond with ok=true.'
    }

    'desktop health ok'
}
finally {
    if ($app -and -not $app.HasExited) {
        Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $app.Id -Timeout 5 -ErrorAction SilentlyContinue
    }

    $leftover = Get-NetTCPConnection -LocalPort 3444 -ErrorAction SilentlyContinue
    if ($leftover) {
        $leftover | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
            Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
        }
    }
}
