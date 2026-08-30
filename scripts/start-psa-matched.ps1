# Targeted PSA ingest: population + price history for exactly the card variants
# that currently have matched eBay auctions. The counterpart to
# start-psa-through-2009.ps1, which walks the whole pre-2010 catalogue instead.
# Extra arguments are passed straight through to the CLI command, e.g.
#   .\scripts\start-psa-matched.ps1 --only=population --limit=50
param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $ExtraArgs)

$ErrorActionPreference = 'Stop'

$workspace = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $workspace 'data'
$pidPath = Join-Path $dataDir 'psa-matched.pid'
$stopPath = Join-Path $dataDir 'psa-fetch.stop'
$stdoutPath = Join-Path $dataDir 'psa-matched.log'
$stderrPath = Join-Path $dataDir 'psa-matched-error.log'

if (Test-Path -LiteralPath $pidPath) {
  $existingPid = [int](Get-Content -LiteralPath $pidPath -Raw)
  if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
    Write-Output "PSA matched-variant ingest is already running as PID $existingPid."
    exit 0
  }
}

# The stop marker is shared with the bulk ingest, so refuse to start while that
# one is running rather than clearing a marker it is currently obeying.
$bulkPidPath = Join-Path $dataDir 'psa-through-2009.pid'
if (Test-Path -LiteralPath $bulkPidPath) {
  $bulkPid = [int](Get-Content -LiteralPath $bulkPidPath -Raw)
  if (Get-Process -Id $bulkPid -ErrorAction SilentlyContinue) {
    Write-Output "The through-2009 ingest is running as PID $bulkPid; stop it first (.\scripts\stop-psa-fetch.ps1)."
    exit 1
  }
}

Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue
$arguments = @('src/cli/index.ts', 'psa-fetch-matched') + $ExtraArgs
$process = Start-Process -FilePath 'node' -ArgumentList $arguments -WorkingDirectory $workspace `
  -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidPath -Value $process.Id
Write-Output "Started PSA matched-variant ingest as PID $($process.Id)."
Write-Output "Progress log: $stdoutPath"
Write-Output "Error log:    $stderrPath"
Write-Output "Stop with:    .\scripts\stop-psa-fetch.ps1"
