# Safe, read-only prerequisite checker for Windows 11 PowerShell 5.1 or 7.
# Does not connect to Telegram or print secret values.
param([ValidateSet('Offline', 'Live', 'Media')][string]$Mode = 'Offline')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoDir = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$failures = New-Object 'System.Collections.Generic.List[string]'
$warnings = New-Object 'System.Collections.Generic.List[string]'

function Fail([string]$message) { $failures.Add($message) }
function Warn([string]$message) { $warnings.Add($message) }

Write-Host "OrbitSuite Windows preflight: $Mode" -ForegroundColor Cyan
if ($env:OS -ne 'Windows_NT') { Warn 'This script was designed for a Windows 11 host.' }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Fail 'Node.js 24+ is missing from PATH.'
} else {
    $nodeVersion = (& $node.Source -p 'process.versions.node' 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^(\d+)\.') {
        Fail 'Node.js version could not be read.'
    } elseif ([int]$Matches[1] -lt 24) {
        Fail "Node.js 24+ is required (found $nodeVersion)."
    } else { Write-Host "OK: Node.js $nodeVersion" }
}

if ($Mode -eq 'Offline' -or $Mode -eq 'Media') {
    $pythonCommand = $null
    $privatePython = Join-Path $repoDir '.venv/Scripts/python.exe'
    if (Test-Path -LiteralPath $privatePython -PathType Leaf) {
        $pyVersion = (& $privatePython --version 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $pyVersion -match '^Python 3\.(\d+)\.') {
            if ([int]$Matches[1] -ge 12) { $pythonCommand = @($privatePython) }
        }
    }
    if (-not $pythonCommand) {
        $launcher = Get-Command py -ErrorAction SilentlyContinue
        if ($launcher) {
            $pyVersion = (& $launcher.Source -3.12 --version 2>&1 | Out-String).Trim()
            if ($LASTEXITCODE -eq 0 -and $pyVersion -match '^Python 3\.12\.') {
                $pythonCommand = @($launcher.Source, '-3.12')
            }
        }
    }
    if (-not $pythonCommand) {
        $python = Get-Command python -ErrorAction SilentlyContinue
        if ($python) {
            $pyVersion = (& $python.Source --version 2>&1 | Out-String).Trim()
            if ($LASTEXITCODE -eq 0 -and $pyVersion -match '^Python 3\.(\d+)\.') {
                if ([int]$Matches[1] -ge 12) { $pythonCommand = @($python.Source) }
            }
        }
    }
    if (-not $pythonCommand) {
        Fail 'Python 3.12+ is needed (Python 3.12 preferred).'
    } else {
        Write-Host "OK: $pyVersion"
        $pythonExe = $pythonCommand[0]
        $pythonPrefix = @()
        if ($pythonCommand.Count -gt 1) { $pythonPrefix = @($pythonCommand[1]) }
        & $pythonExe @pythonPrefix -c 'import httpx, cryptography' 2>$null
        if ($LASTEXITCODE -ne 0) {
            Fail 'Python needs httpx and cryptography in the active environment (see staging guide).'
        } else { Write-Host 'OK: Python HTTPX and cryptography packages' }
    }
    foreach ($tool in @('ffmpeg', 'ffprobe')) {
        if (Get-Command $tool -ErrorAction SilentlyContinue) { Write-Host "OK: $tool" }
        else { Fail "$tool is not available on PATH (needed for complete media tests)." }
    }
}

if ($Mode -eq 'Media') {
    if (Get-Command yt-dlp -ErrorAction SilentlyContinue) { Write-Host 'OK: yt-dlp' }
    else { Fail 'yt-dlp must be installed for live media testing.' }
}

if ($Mode -eq 'Live' -or $Mode -eq 'Media') {
    $envPath = Join-Path $repoDir '.env'
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
        Fail '.env is missing. Copy .env.example and edit it privately.'
    } else {
        $settings = @{}
        foreach ($line in [System.IO.File]::ReadAllLines($envPath)) {
            if ($line -match '^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$') {
                $key = $Matches[1]
                $value = $Matches[2].Trim()
                if ($value.Length -ge 2 -and
                    (($value.StartsWith('"') -and $value.EndsWith('"')) -or
                    ($value.StartsWith("'") -and $value.EndsWith("'")))) {
                    $value = $value.Substring(1, $value.Length - 2)
                }
                if ($settings.ContainsKey($key)) { Fail "Duplicate .env key: $key" }
                $settings[$key] = $value
            }
        }
        if (-not $settings.ContainsKey('BOT_TOKEN') -or
            $settings['BOT_TOKEN'] -notmatch '^\d+:[A-Za-z0-9_-]{20,}$') {
            Fail 'BOT_TOKEN needs a real, dedicated BotFather token.'
        }
        if (-not $settings.ContainsKey('OWNER_ID') -or
            $settings['OWNER_ID'] -notmatch '^\d+$' -or $settings['OWNER_ID'] -eq '123456789') {
            Fail 'OWNER_ID needs your real numeric Telegram ID, not the example.'
        }
        if (-not $settings.ContainsKey('WEBHOOK_SECRET') -or
            $settings['WEBHOOK_SECRET'].Length -lt 16 -or
            $settings['WEBHOOK_SECRET'] -match '^(GENERATE|REPLACE|YOUR_)') {
            Fail 'WEBHOOK_SECRET needs a unique 16+ character random value.'
        }
        if ($settings['ORBIT_MODE'] -ne 'polling') { Fail 'Use ORBIT_MODE=polling for initial Windows testing.' }
        if ($settings['ORBIT_STORE'] -ne 'sqlite') { Fail 'Use ORBIT_STORE=sqlite for initial Windows testing.' }
        if ($settings['ORBIT_HOST'] -ne '127.0.0.1') {
            Fail 'Keep ORBIT_HOST=127.0.0.1 for private staging.'
        }
        if ($settings.ContainsKey('ORBIT_TEST_CHAT_ID')) {
            if ($settings['ORBIT_TEST_CHAT_ID'] -notmatch '^-[0-9]{5,}$') {
                Fail 'ORBIT_TEST_CHAT_ID must be a negative private group ID.'
            }
        } else { Warn 'ORBIT_TEST_CHAT_ID not set: chat permission checks will be skipped.' }
        if ($settings.ContainsKey('ORBIT_TEST_DEST_CHAT_ID')) {
            if ($settings['ORBIT_TEST_DEST_CHAT_ID'] -notmatch '^-[0-9]{5,}$') {
                Fail 'ORBIT_TEST_DEST_CHAT_ID must be a negative private group ID.'
            }
            if ($settings['ORBIT_TEST_DEST_CHAT_ID'] -eq $settings['ORBIT_TEST_CHAT_ID']) {
                Fail 'Source and destination test chats must be different.'
            }
        } else { Warn 'ORBIT_TEST_DEST_CHAT_ID not set: destination permission checks will be skipped.' }
        if ($Mode -eq 'Media' -and
            (-not $settings.ContainsKey('MEDIA_WORKER_KEY') -or
             $settings['MEDIA_WORKER_KEY'].Length -lt 24 -or
             $settings['MEDIA_WORKER_KEY'] -match '^(GENERATE|REPLACE|YOUR_)')) {
            Fail 'MEDIA_WORKER_KEY requires a distinct 24+ character random value.'
        }
        if ($repoDir -match '(?i)\\OneDrive\\|\\Dropbox\\|\\Google Drive\\') {
            Warn 'Avoid cloud-synced folders for .env, SQLite data and sessions.'
        }
        Write-Host 'Checked .env locally (no values displayed).'
    }
}

foreach ($message in $warnings) { Write-Warning $message }
foreach ($message in $failures) { Write-Host "FAIL: $message" -ForegroundColor Red }
if ($failures.Count -gt 0) { exit 1 }
Write-Host 'Preflight passed.' -ForegroundColor Green
exit 0
