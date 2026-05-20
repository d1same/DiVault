param(
    [string]$PhpBin
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$runtimeName = "php-$($package.version)"
$resourcesDir = Join-Path $projectRoot 'src-tauri\resources'
$runtimeDir = Join-Path $resourcesDir $runtimeName

if (-not $PhpBin -and $env:DIVAULT_PHP_BIN) {
    $PhpBin = $env:DIVAULT_PHP_BIN
}

if (-not $PhpBin) {
    $phpCommand = Get-Command php -ErrorAction Stop
    $PhpBin = $phpCommand.Source
}

if (-not (Test-Path -LiteralPath $PhpBin)) {
    throw "PHP executable not found at $PhpBin"
}

$phpSourceDir = Split-Path -Parent $PhpBin
if (-not (Test-Path -LiteralPath (Join-Path $phpSourceDir 'php.exe'))) {
    throw "PHP runtime folder must contain php.exe: $phpSourceDir"
}

if (-not (Test-Path -LiteralPath $resourcesDir)) {
    New-Item -ItemType Directory -Path $resourcesDir | Out-Null
}

Get-ChildItem -LiteralPath $resourcesDir -Directory -Filter 'php-*' -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -ne $runtimeName
} | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $runtimeDir) {
    Remove-Item -LiteralPath $runtimeDir -Recurse -Force
}

New-Item -ItemType Directory -Path $runtimeDir | Out-Null

$excludeNames = @('dev', 'extras', 'lib', 'phpdbg.exe', 'php8embed.lib', 'deplister.exe')
Get-ChildItem -LiteralPath $phpSourceDir -Force | Where-Object {
    $excludeNames -notcontains $_.Name
} | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $runtimeDir -Recurse -Force
}

if (-not (Test-Path -LiteralPath (Join-Path $runtimeDir 'php.ini'))) {
    $productionIni = Join-Path $runtimeDir 'php.ini-production'
    if (Test-Path -LiteralPath $productionIni) {
        Copy-Item -LiteralPath $productionIni -Destination (Join-Path $runtimeDir 'php.ini') -Force
    }
}

$phpIni = Join-Path $runtimeDir 'php.ini'
$modules = & (Join-Path $runtimeDir 'php.exe') -c $runtimeDir -m
if ($LASTEXITCODE -ne 0) {
    throw 'Bundled PHP runtime did not start correctly.'
}

$settings = @('', '; DiVault desktop runtime requirements', 'extension_dir = "ext"')
foreach ($module in @('pdo_sqlite', 'sqlite3', 'zip', 'fileinfo', 'openssl')) {
    if ($modules -notcontains $module) {
        $settings += "extension=$module"
    }
}
if ($settings.Count -gt 3) {
    Add-Content -LiteralPath $phpIni -Value ($settings -join "`n")
}

$modules = & (Join-Path $runtimeDir 'php.exe') -c $runtimeDir -m
if ($LASTEXITCODE -ne 0) {
    throw 'Bundled PHP runtime did not start correctly.'
}

foreach ($module in @('PDO', 'pdo_sqlite', 'sqlite3', 'zip', 'fileinfo', 'openssl')) {
    if ($modules -notcontains $module) {
        throw "Bundled PHP runtime is missing required module: $module"
    }
}

"Prepared desktop PHP runtime at $runtimeDir"
