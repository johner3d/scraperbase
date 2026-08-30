$ErrorActionPreference = 'Stop'

$workspace = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $workspace 'data'
# Both ingests -- the through-2009 bulk walk and the targeted matched-variant
# run -- obey the same stop marker, so this stops whichever is running.
$pidPaths = @(
  (Join-Path $dataDir 'psa-through-2009.pid'),
  (Join-Path $dataDir 'psa-matched.pid')
)
$stopPath = Join-Path $dataDir 'psa-fetch.stop'

New-Item -ItemType File -Path $stopPath -Force | Out-Null
$stopped = $false
foreach ($pidPath in $pidPaths) {
  if (-not (Test-Path -LiteralPath $pidPath)) { continue }
  $ingestPid = [int](Get-Content -LiteralPath $pidPath -Raw)
  if (Get-Process -Id $ingestPid -ErrorAction SilentlyContinue) {
    Write-Output "Graceful stop requested for PSA ingest PID $ingestPid. It will stop after the current sales page is checkpointed."
    $stopped = $true
  }
}
if (-not $stopped) {
  Write-Output 'Stop marker created; no active ingest PID was found.'
}
