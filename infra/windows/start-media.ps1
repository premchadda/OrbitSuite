# Optional second-terminal media worker, using the same private .env values.
# No credentials are echoed or passed as command-line arguments.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoDir = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
& (Join-Path $PSScriptRoot 'preflight.ps1') -Mode Media
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$settings = @{}
foreach ($line in [System.IO.File]::ReadAllLines((Join-Path $repoDir '.env'))) {
    if ($line -match '^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$') {
        $value = $Matches[2].Trim()
        if ($value.Length -ge 2 -and
            (($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $settings[$Matches[1]] = $value
    }
}
$values = @{
    BOT_TOKEN = $settings['BOT_TOKEN']
    ORBIT_SERVICE_KEY = $settings['MEDIA_WORKER_KEY']
    ORBIT_CONTROL_URL = 'http://127.0.0.1:8787'
    ORBIT_ALLOW_LOCAL_HTTP = '1'
    ORBIT_MEDIA_HOSTS = $settings['ORBIT_MEDIA_HOSTS']
    ORBIT_POLL_SECONDS = $settings['ORBIT_POLL_SECONDS']
}
$previous = @{}
foreach ($key in $values.Keys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    if ($null -ne $values[$key]) {
        [Environment]::SetEnvironmentVariable($key, $values[$key], 'Process')
    }
}

$python = Join-Path $repoDir '.venv/Scripts/python.exe'
if (-not (Test-Path $python)) {
    throw 'Create .venv as shown in docs/WINDOWS_11_LIVE_TEST.md before starting media.'
}
try {
    Push-Location $repoDir
    try {
        Write-Host 'Starting optional media worker; Ctrl+C stops it.'
        & $python services/media_worker/worker.py
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally { Pop-Location }
} finally {
    foreach ($key in $previous.Keys) {
        [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process')
    }
}
