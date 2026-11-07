param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectDir 'data\server.pid'
if (Test-Path -LiteralPath $pidFile) {
    $servicePid = [int](Get-Content -Raw -LiteralPath $pidFile)
    $service = Get-CimInstance Win32_Process -Filter "ProcessId = $servicePid"
    if ($service) {
        $expectedPython = 'E:\Tools\miniconda3\envs\audio-plugin-archivist\python.exe'
        if ($service.ExecutablePath -ne $expectedPython -or $service.CommandLine -notmatch '\s-m\s+audio_archive\s+serve(?:\s|$)') {
            throw 'Saved PID belongs to an unexpected process. Nothing was stopped.'
        }
        $items = Invoke-RestMethod 'http://127.0.0.1:8765/api/archives' -TimeoutSec 5
        if ($items | Where-Object { $_.status -in 'queued','extracting','analyzing' -or $_.sync.status -eq 'syncing' -or $_.sync.bitable.status -eq 'syncing' }) {
            throw 'An archive or sync is in progress. Wait before restarting.'
        }
        Stop-Process -Id $servicePid -Force
        Wait-Process -Id $servicePid -Timeout 10 -ErrorAction SilentlyContinue
    }
}
& (Join-Path $PSScriptRoot 'start.ps1') -NoBrowser:$NoBrowser
