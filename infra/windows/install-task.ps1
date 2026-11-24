# Personal Windows Task Scheduler launch (at current user's logon).
# Start from PowerShell in the repo root; no admin prompt or Telegram login.
$ErrorActionPreference = 'Stop'
$repoDir = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$envPath = Join-Path $repoDir '.env'
$entry = Join-Path $repoDir 'apps/local/src/runtime.js'
if (-not (Test-Path $envPath)) { throw 'Missing .env; copy .env.example and set private values.' }
$node = (Get-Command node -ErrorAction Stop).Source
$major = [int]((& $node -p 'process.versions.node.split(".")[0]').Trim())
if ($major -lt 24) { throw "Node.js 24+ is required, found $major" }
$action = New-ScheduledTaskAction -Execute $node -Argument "--env-file=`"$envPath`" `"$entry`"" -WorkingDirectory $repoDir
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel LeastPrivilege
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName 'OrbitSuitePersonal' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Personal Telegram bot; start after interactive logon'
Write-Host 'Task registered. Inspect OrbitSuitePersonal in Task Scheduler; start it when ready.'
