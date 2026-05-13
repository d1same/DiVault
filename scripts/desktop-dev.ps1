param(
    [string]$PhpBin,
    [string]$ConfigDir,
    [string]$RemoteUrl
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'package.json'))) {
    throw "Could not find package.json from $projectRoot"
}

if ($PhpBin) {
    $env:DIVAULT_PHP_BIN = $PhpBin
}

if ($ConfigDir) {
    $env:DIVAULT_DESKTOP_CONFIG = $ConfigDir
}

if ($RemoteUrl) {
    $env:DIVAULT_REMOTE_URL = $RemoteUrl
}

Push-Location -LiteralPath $projectRoot
try {
    npm run desktop:dev
}
finally {
    Pop-Location
}
