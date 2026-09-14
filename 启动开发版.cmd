@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\start-injector-windows.ps1"
set "launcherExitCode=%errorlevel%"
if not "%launcherExitCode%"=="0" (
  echo.
  echo Codex Quota Injector development launcher failed.
  echo Log: "%LOCALAPPDATA%\Codex Quota Injector\Logs\launcher.log"
  pause
)
exit /b %launcherExitCode%
