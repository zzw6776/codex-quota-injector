$ErrorActionPreference = "Stop"

function Get-InjectorListenerProcessIds {
  @(Get-NetTCPConnection `
      -LocalAddress 127.0.0.1 `
      -LocalPort 49229 `
      -State Listen `
      -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique |
      Where-Object { $_ -gt 0 } |
      ForEach-Object {
        $ownerProcessId = [int]$_
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerProcessId"
        if ($owner) {
          $isInjector = $owner.Name -eq "Codex Quota Injector.exe" -or (
            $owner.Name -eq "node.exe" -and
            $owner.CommandLine -match '(?:^|[\s"\\/])src[\\/]launcher\.mjs(?:["\s]|$)'
          )
          if (-not $isInjector) {
            throw "Port 49229 is owned by a non-injector process ($ownerProcessId, $($owner.Name)); refusing to terminate it"
          }
          $ownerProcessId
        }
      })
}

function Stop-InjectorProcess([int]$processId) {
  if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
    return
  }

  & taskkill.exe /PID $processId /T /F *> $null
  if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
}

$processIds = @(
  Get-InjectorListenerProcessIds
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq "Codex Quota Injector.exe" } |
    Select-Object -ExpandProperty ProcessId |
    ForEach-Object { [int]$_ }
) | Sort-Object -Unique

foreach ($processId in $processIds) {
  Stop-InjectorProcess $processId
}

$deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $deadline) {
  $listeners = @(Get-InjectorListenerProcessIds)
  if ($listeners.Count -eq 0) { exit 0 }
  foreach ($processId in $listeners) {
    Stop-InjectorProcess $processId
  }
  Start-Sleep -Milliseconds 250
}

throw "The previous injector did not release port 49229 within 10 seconds"
