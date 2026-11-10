@echo off
chcp 65001 >nul
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
timeout /t 2 >nul

REM ---- 2. Launch keep_alive + video via vbs (silent, detached) ----
echo [start ] wscript autostart.vbs
wscript autostart.vbs
if errorlevel 1 (
  echo [WARN  ] wscript failed - is autostart.vbs still here?
)

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
timeout /t 1 >nul
goto :wait_loop

:done
echo.
echo === Exit. Services keep running in background. ===
timeout /t 5 >nul
exit /b 0