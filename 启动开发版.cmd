@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\start-injector-windows.ps1"
exit /b %errorlevel%
