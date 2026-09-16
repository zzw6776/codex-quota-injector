param(
  [string]$BootstrapPath = (Join-Path $PSScriptRoot "start-injector-windows.ps1"),
  [string]$LogRoot = (Join-Path $env:LOCALAPPDATA "Codex Quota Injector\Logs")
)

$ErrorActionPreference = "Stop"
try {
  . (Join-Path $PSScriptRoot "dev-launch-log-reader.ps1")
  New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
  $captureName = "dev-console-$([guid]::NewGuid().ToString('N'))"
  $captureOutput = Join-Path $LogRoot "$captureName.stdout.log"
  $captureError = Join-Path $LogRoot "$captureName.stderr.log"
  $streams = @(
    New-DevLogCursor (Join-Path $LogRoot "launcher.log") -FromEnd
    New-DevLogCursor (Join-Path $LogRoot "injector.log") -FromEnd
    New-DevLogCursor $captureOutput
    New-DevLogCursor $captureError
  )
  Write-Host "Startup log: $(Join-Path $LogRoot 'launcher.log')"
  Write-Host "Runtime log: $(Join-Path $LogRoot 'injector.log')"
  Write-Host "Startup errors: $captureError"
  $powershellPath = Join-Path $PSHOME "powershell.exe"
  $bootstrap = Start-Process -FilePath $powershellPath -NoNewWindow -PassThru `
    -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', ('"' + $BootstrapPath + '"'), '-Console') `
    -RedirectStandardOutput $captureOutput -RedirectStandardError $captureError
  $null = $bootstrap.Handle
  $bootstrapFinished = $false
  while ($true) {
    foreach ($stream in $streams) { Read-DevLogCursor $stream }
    $bootstrap.Refresh()
    if (-not $bootstrapFinished -and $bootstrap.HasExited) {
      $bootstrap.WaitForExit()
      foreach ($stream in $streams) { Read-DevLogCursor $stream }
      if ($bootstrap.ExitCode -ne 0) {
        Write-Host "Startup preparation failed; exit code $($bootstrap.ExitCode)."
        exit $bootstrap.ExitCode
      }
      $streams += New-DevLogCursor (Join-Path $LogRoot 'injector-stdout.log')
      $streams += New-DevLogCursor (Join-Path $LogRoot 'injector-stderr.log')
      Write-Host "Startup preparation finished. Following runtime logs; check the actual readiness or error messages below."
      Write-Host "Close this window to stop viewing logs. The background injector remains running."
      $bootstrapFinished = $true
    }
    Start-Sleep -Milliseconds 100
  }
} catch {
  Write-Host "Development console failed: $($_.Exception.Message)"
  Write-Host $_.ScriptStackTrace
  exit 1
}
