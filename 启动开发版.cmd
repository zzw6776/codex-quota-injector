@echo off
setlocal
cd /d "%~dp0"

where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js 22 or newer is required.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies for the first launch...
  call npm install
  if errorlevel 1 (
    echo Failed to install dependencies.
    pause
    exit /b 1
  )
)

echo Stopping any running Codex Quota Injector...
for /f %%P in ('powershell.exe -NoProfile -NonInteractive -Command "Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 49229 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"') do (
  taskkill.exe /PID %%P /T /F >nul 2>&1
)
taskkill.exe /IM "Codex Quota Injector.exe" /T /F >nul 2>&1

echo Starting Codex Quota Injector development version...
call npm run launch
if errorlevel 1 (
  echo Launch failed. Check the message above or injector.log.
  pause
)
