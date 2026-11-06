@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo DEBUG MODE: everyone can talk. Send /bot-me in QQ to get your OpenID.
echo Close this window and run set-whitelist.cmd afterwards.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-qqbot.ps1" -Discover
echo.
echo Stopped. Press any key to close.
pause >nul
