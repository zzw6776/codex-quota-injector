@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo Starting Codex Quota Injector development version...
echo This window displays startup and runtime logs.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\dev-launch-console.ps1"
set "launcherExitCode=%errorlevel%"
echo.
echo Development launcher exited with code %launcherExitCode%.
echo Log: "%LOCALAPPDATA%\Codex Quota Injector\Logs\launcher.log"
pause
exit /b %launcherExitCode%
