# Runs all OrbitSuite runtime tests from the correct working directories.
# Does not need or read BOT_TOKEN, and does not run live Telegram commands.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoDir = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path

& (Join-Path $PSScriptRoot 'preflight.ps1') -Mode Offline
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$pythonPath = Join-Path $repoDir '.venv/Scripts/python.exe'
$pythonArgs = @()
if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    $python = Get-Command py -ErrorAction SilentlyContinue
    $pythonArgs = @('-3.12')
    if ($python) {
        & $python.Source -3.12 --version *> $null
        if ($LASTEXITCODE -ne 0) { $python = $null }
    }
    if (-not $python) {
        $python = Get-Command python -ErrorAction Stop
        $pythonArgs = @()
    }
    $pythonPath = $python.Source
}

$suites = @(
    @{Label='Bot Worker'; Folder='apps/worker'; Executable='node'; Args=@('--test')},
    @{Label='Local Node runtime'; Folder='apps/local'; Executable='node'; Args=@('--test')},
    @{Label='Python media'; Folder='services/media_worker'; Executable=$pythonPath; Args=($pythonArgs + @('-m','unittest','discover','-v'))},
    @{Label='Python history'; Folder='services/user_bridge'; Executable=$pythonPath; Args=($pythonArgs + @('-m','unittest','discover','-v'))},
    @{Label='RSS'; Folder='.'; Executable=$pythonPath; Args=($pythonArgs + @('-m','unittest','discover','-s','services/automation','-v'))},
    @{Label='AI adapters'; Folder='.'; Executable=$pythonPath; Args=($pythonArgs + @('-m','unittest','discover','-s','services/ai','-v'))},
    @{Label='Archive portability'; Folder='.'; Executable=$pythonPath; Args=($pythonArgs + @('-m','unittest','tools.test_archive_portability','-v'))}
)

$passed = 0
foreach ($suite in $suites) {
    Write-Host "Running: $($suite.Label)" -ForegroundColor Cyan
    Push-Location (Join-Path $repoDir $suite.Folder)
    try {
        $exe = [string]$suite.Executable
        $arguments = [string[]]$suite.Args
        & $exe @arguments
        if ($LASTEXITCODE -ne 0) { throw "$($suite.Label) failed (exit $LASTEXITCODE)" }
        $passed++
    } finally { Pop-Location }
}

Write-Host "All $passed offline suites passed. Review test counts and skipped tests above." -ForegroundColor Green
