<#
.SYNOPSIS
    Bootstraps and starts scraperbase: installs dependencies, runs the DB
    migration, and launches the web UI dev server.

.PARAMETER SkipInstall
    Skip `npm install` even if node_modules is missing/stale.

.PARAMETER Web
    Which web mode to start: "dev" (default, Vite dev server) or "prod"
    (build then serve).

.PARAMETER NoWeb
    Only bootstrap (install + migrate); don't start the web server.
#>
param(
    [switch]$SkipInstall,
    [ValidateSet('dev', 'prod')]
    [string]$Web = 'dev',
    [switch]$NoWeb
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Write-Step($msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

# 1. Install dependencies
if (-not $SkipInstall) {
    if (-not (Test-Path 'node_modules')) {
        Write-Step 'Installing dependencies (npm install)...'
        npm install
    } else {
        Write-Step 'node_modules present, skipping install (use -SkipInstall:$false to force, or delete node_modules)'
    }
}

# 2. Run DB migration (creates data/ and db.sqlite if missing, no-op otherwise)
Write-Step 'Running database migration...'
npm run migrate

if ($NoWeb) {
    Write-Step 'Bootstrap complete (NoWeb set, not starting the web server).'
    exit 0
}

# 3. Start the web UI
if ($Web -eq 'prod') {
    Write-Step 'Building web UI for production...'
    npm run web:build
    Write-Step 'Starting web server (production)...'
    npm run web
} else {
    Write-Step 'Starting web server (dev mode)...'
    npm run web:dev
}
