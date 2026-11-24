# Start one foreground local-polling bot after a read-only validation.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoDir = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
& (Join-Path $PSScriptRoot 'preflight.ps1') -Mode Live
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Push-Location $repoDir
try {
    Write-Host 'Starting OrbitSuite polling in this terminal; Ctrl+C stops it.'
    & node --env-file=.env apps/local/src/runtime.js
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }
