@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-qqbot.ps1" %*
echo.
echo QQ bot stopped. Press any key to close.
pause >nul
