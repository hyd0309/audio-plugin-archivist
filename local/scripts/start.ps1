param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$baseUrl = 'http://127.0.0.1:8765'
function Test-ArchiveService {
    try {
        $health = Invoke-RestMethod "$baseUrl/api/health" -TimeoutSec 2
        return ($health.service -eq 'audio-plugin-archivist' -and $health.ok)
    } catch { return $false }
}
if (-not (Test-ArchiveService)) {
    $pythonExe = 'E:\Tools\miniconda3\envs\audio-plugin-archivist\python.exe'
    if (-not (Test-Path -LiteralPath $pythonExe)) {
        $condaInfo = conda env list --json | ConvertFrom-Json
        $envDir = $condaInfo.envs | Where-Object { (Split-Path -Leaf $_) -eq 'audio-plugin-archivist' } | Select-Object -First 1
        if (-not $envDir) { throw 'Conda environment audio-plugin-archivist was not found. See README.md.' }
        $pythonExe = Join-Path $envDir 'python.exe'
    }
    $logDir = Join-Path $projectDir 'data\logs'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $runId = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $process = Start-Process -FilePath $pythonExe -ArgumentList '-m','audio_archive','serve' -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "$runId-out.log") -RedirectStandardError (Join-Path $logDir "$runId-error.log") -PassThru
    $process.Id | Set-Content (Join-Path $projectDir 'data\server.pid')
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-ArchiveService) { $ready = $true; break }
        $process.Refresh()
        if ($process.HasExited) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw "Service did not start. See data\logs\$runId-error.log. Port 8765 may be in use." }
}
Write-Output "Audio archive ready: $baseUrl"
if (-not $NoBrowser) { Start-Process $baseUrl }
