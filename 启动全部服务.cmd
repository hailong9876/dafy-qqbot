@echo off
cd /d "%~dp0"
title Dafy - Startup All Services

echo === Dafy Startup ===
echo root : %cd%
echo.

REM ---- 1. Clean bridge 18902 zombie ONLY ----
REM keep_alive self-probes 18900 18903 18904 and skips if alive, do NOT touch them
for /f "tokens=5" %%A in ('netstat -ano 2^>nul ^| findstr ":18902" ^| findstr LISTENING') do (
  echo [cleanup] bridge 18902 occupied by PID %%A - killing
  taskkill /PID %%A /F >nul 2>nul
)
ping -n 3 127.0.0.1 >nul

REM ---- 2. Launch keep_alive + video via vbs (silent, detached) ----
echo [start ] wscript autostart.vbs
if not exist "%~dp0autostart.vbs" (
  echo [ERROR ] autostart.vbs not found next to this cmd
  pause
  exit /b 1
)
wscript "%~dp0autostart.vbs"

REM ---- 3. Wait for bridge ready via PowerShell ----
echo [wait  ] bridge 18902 ready
set WAITED=0
:wait_loop
if %WAITED% geq 45 (
  echo [WARN  ] bridge not up in 45s - check keep_alive.js console
  goto :done
)
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'http://127.0.0.1:18902/api/health' -TimeoutSec 2 -UseBasicParsing | Out-Null; exit 0 } catch { exit 1 }"
if %errorlevel%==0 (
  echo [READY ] bridge connected after %WAITED%s
  goto :done
)
set /a WAITED+=1
ping -n 2 127.0.0.1 >nul
goto :wait_loop

:done
echo.
echo === Exit. Services keep running in background. ===
ping -n 5 127.0.0.1 >nul
exit /b 0
