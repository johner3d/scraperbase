$ErrorActionPreference = 'Stop'

$workspace = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $workspace 'data'
$pidPath = Join-Path $dataDir 'psa-through-2009.pid'
$stopPath = Join-Path $dataDir 'psa-fetch.stop'
$stdoutPath = Join-Path $dataDir 'psa-through-2009.log'
$stderrPath = Join-Path $dataDir 'psa-through-2009-error.log'

if (Test-Path -LiteralPath $pidPath) {
  $existingPid = [int](Get-Content -LiteralPath $pidPath -Raw)
  if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
    Write-Output "PSA through-2009 ingest is already running as PID $existingPid."
    exit 0
  }
}

Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue
$arguments = @(
  'src/scripts/psa-fetch.ts',
  '--from-db',
  '--through-year=2009',
  '--only=sales',
  '--since=1900-01-01'
)
$process = Start-Process -FilePath 'node' -ArgumentList $arguments -WorkingDirectory $workspace `
  -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidPath -Value $process.Id
Write-Output "Started PSA through-2009 historic-sales ingest as PID $($process.Id)."
Write-Output "Progress log: $stdoutPath"
Write-Output "Error log:    $stderrPath"

