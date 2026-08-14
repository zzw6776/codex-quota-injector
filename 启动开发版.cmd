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

echo Starting Codex Quota Injector development version...
call npm run launch
set "exitCode=%errorlevel%"
if not "%exitCode%"=="0" (
  echo Launch failed. Check the message above or injector.log.
  pause
)
exit /b %exitCode%
