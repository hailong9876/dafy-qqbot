@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 大肥鱼智能大屏 v1.2.5 - 完整流程
color 0B

rem ============================================================
rem  大肥鱼智能大屏 v1.2.5 完整流程控制台
rem  放在「安装包」目录或安装目录均可使用
rem ============================================================

set "SD=%~dp0"
set "SD=%SD:~0,-1%"

rem ---- 自动定位程序根目录 ----
if exist "%SD%\index.html" (
  set "APP=%SD%"
) else if exist "%SD%\..\index.html" (
  set "APP=%SD%\.."
) else (
  echo [错误] 未找到 index.html，请把本文件放在安装目录或项目「安装包」目录中。
  pause
  exit /b 1
)
for %%i in ("%APP%") do set "APP=%%~fi"

:menu
cls
echo ============================================================
echo             大肥鱼智能大屏  v1.2.5
echo                  完整流程控制台
echo ============================================================
echo   程序目录: %APP%
echo ------------------------------------------------------------
echo   [1] 环境检查        Node / Python / WebView2 / 端口
echo   [2] 安装语音依赖    Edge-TTS 极速语音（联网）
echo   [3] 安装离线语音    ChatTTS（可选，体积大）
echo   [4] 启动全部服务    Bridge + Edge-TTS + ChatTTS
echo   [5] 查看服务状态    健康检查
echo   [6] 停止全部服务    释放端口
echo   [7] 打开大屏        index.html
echo   [8] 构建安装包      仅开发机可用
echo   [0] 退出
echo ============================================================
set /p "CH=请输入序号后回车: "
if "%CH%"=="1" goto envcheck
if "%CH%"=="2" goto instedge
if "%CH%"=="3" goto instchat
if "%CH%"=="4" goto startall
if "%CH%"=="5" goto status
if "%CH%"=="6" goto stopall
if "%CH%"=="7" goto openapp
if "%CH%"=="8" goto build
if "%CH%"=="0" exit /b 0
goto menu

rem ============ 1. 环境检查 ============
:envcheck
cls
echo ============================================================
echo   环境检查
echo ============================================================
echo.
where node >nul 2>nul && (
  echo [OK] Node.js:
  node -v
) || echo [缺失] 未找到 Node.js，请安装 https://nodejs.org/
echo.
set "PY="
if defined DAFY_PYTHON if exist "%DAFY_PYTHON%" set "PY=%DAFY_PYTHON%"
if not defined PY if exist "%APP%\python\python.exe" set "PY=%APP%\python\python.exe"
if not defined PY for /f "delims=" %%i in ('where python 2^>nul') do if not defined PY set "PY=%%i"
if defined PY (
  echo [OK] Python: !PY!
  "!PY!" --version
) else echo [缺失] 未找到 Python，请安装 https://www.python.org/downloads/
echo.
reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" >nul 2>nul && (
  echo [OK] WebView2 运行时已安装
) || echo [提示] 未检测到 WebView2 运行时，大屏可能无法显示
echo.
echo [端口占用情况]
netstat -ano | findstr /R ":18902 .*LISTENING" >nul && echo   18902 Bridge    已占用 || echo   18902 Bridge    空闲
netstat -ano | findstr /R ":18903 .*LISTENING" >nul && echo   18903 ChatTTS   已占用 || echo   18903 ChatTTS   空闲
netstat -ano | findstr /R ":18904 .*LISTENING" >nul && echo   18904 Edge-TTS  已占用 || echo   18904 Edge-TTS  空闲
echo.
pause
goto menu

rem ============ 2. 安装 Edge-TTS 依赖 ============
:instedge
cls
echo ============================================================
echo   安装 Edge-TTS 极速语音依赖
echo ============================================================
if defined DAFY_PYTHON if exist "%DAFY_PYTHON%" set "DAFY_PYTHON=%DAFY_PYTHON%"
if not defined DAFY_PYTHON if exist "%APP%\python\python.exe" set "DAFY_PYTHON=%APP%\python\python.exe"
if not defined DAFY_PYTHON if exist "%APP%\..\agent-lightning\.venv\Scripts\python.exe" set "DAFY_PYTHON=%APP%\..\agent-lightning\.venv\Scripts\python.exe"
call "%APP%\tts\install-tts.cmd"
goto menu

rem ============ 3. 安装 ChatTTS 依赖 ============
:instchat
cls
echo ============================================================
echo   安装 ChatTTS 离线语音依赖（约 2GB，耗时较长）
echo ============================================================
if defined DAFY_PYTHON if exist "%DAFY_PYTHON%" set "DAFY_PYTHON=%DAFY_PYTHON%"
if not defined DAFY_PYTHON if exist "%APP%\python\python.exe" set "DAFY_PYTHON=%APP%\python\python.exe"
if not defined DAFY_PYTHON if exist "%APP%\..\agent-lightning\.venv\Scripts\python.exe" set "DAFY_PYTHON=%APP%\..\agent-lightning\.venv\Scripts\python.exe"
call "%APP%\tts\install-tts.cmd" --chattts
goto menu

rem ============ 4. 启动全部服务 ============
:startall
cls
echo ============================================================
echo   启动全部服务
echo   Bridge(18902) + Edge-TTS(18904) + ChatTTS(18903)
echo ============================================================
echo.
where node >nul 2>nul || (
  echo [错误] 未找到 Node.js，无法启动服务。
  pause
  goto menu
)
echo 正在启动…（首次 ChatTTS 模型加载约 40-60 秒）
start "大肥鱼服务守护" cmd /c "node ""%APP%\keep_alive.js"" & pause"
echo.
echo 已在新窗口启动守护进程，请查看该窗口的状态输出。
timeout /t 5 >nul
goto status

rem ============ 5. 查看服务状态 ============
:status
cls
echo ============================================================
echo   服务状态检查
echo ============================================================
echo.
powershell -NoProfile -Command ^
  "$u=@(@{n='Bridge';p=18902;q='/api/tts2/status'},@{n='Edge-TTS';p=18904;q='/health'},@{n='ChatTTS';p=18903;q='/health'});" ^
  "foreach($x in $u){ try{$r=Invoke-WebRequest ('http://127.0.0.1:'+$x.p+$x.q) -TimeoutSec 3 -UseBasicParsing; Write-Host ('  ' + $x.n.PadRight(10) + $x.p + '  [OK] ' + $r.StatusCode) -ForegroundColor Green}catch{ Write-Host ('  ' + $x.n.PadRight(10) + $x.p + '  [未运行]') -ForegroundColor Red}}"
echo.
echo 提示：Bridge 正常时大屏与 QQ 机器人可正常对话；
echo       语音是否可用取决于对应引擎是否已安装依赖。
echo.
pause
goto menu

rem ============ 6. 停止全部服务 ============
:stopall
cls
echo ============================================================
echo   停止全部服务
echo ============================================================
for %%p in (18902 18903 18904) do (
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%p .*LISTENING"') do (
    echo 结束端口 %%p 进程 PID=%%a
    taskkill /PID %%a /T /F >nul 2>nul
  )
)
echo 已释放端口 18902 / 18903 / 18904
echo.
pause
goto menu

rem ============ 7. 打开大屏 ============
:openapp
if exist "%APP%\大肥鱼大屏.exe" (
  start "" "%APP%\大肥鱼大屏.exe"
) else (
  start "" "%APP%\index.html"
)
echo 已尝试打开大屏。
timeout /t 2 >nul
goto menu

rem ============ 8. 构建安装包（开发机） ============
:build
cls
echo ============================================================
echo   构建安装包（仅开发机）
echo ============================================================
if not exist "%APP%\installer\build-installer.ps1" (
  echo [错误] 未找到 installer\build-installer.ps1，当前不是开发目录。
  pause
  goto menu
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%APP%\installer\build-installer.ps1"
echo.
pause
goto menu
