$ErrorActionPreference = 'Stop'

$workspace = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $workspace 'data'
$pidPath = Join-Path $dataDir 'psa-through-2009.pid'
$stopPath = Join-Path $dataDir 'psa-fetch.stop'

New-Item -ItemType File -Path $stopPath -Force | Out-Null
if (Test-Path -LiteralPath $pidPath) {
  $ingestPid = [int](Get-Content -LiteralPath $pidPath -Raw)
  if (Get-Process -Id $ingestPid -ErrorAction SilentlyContinue) {
    Write-Output "Graceful stop requested for PSA ingest PID $ingestPid. It will stop after the current sales page is checkpointed."
    exit 0
  }
}
Write-Output 'Stop marker created; no active ingest PID was found.'
