@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 大肥鱼语音引擎 - 依赖安装

echo ============================================
echo   大肥鱼语音引擎依赖安装
echo ============================================
echo.

rem ---- 1. 查找 Python ----
set "PY="
if defined DAFY_PYTHON if exist "%DAFY_PYTHON%" set "PY=%DAFY_PYTHON%"
if not defined PY if exist "%~dp0..\python\python.exe" set "PY=%~dp0..\python\python.exe"
if not defined PY (
  for /f "delims=" %%i in ('where python 2^>nul') do (
    if not defined PY set "PY=%%i"
  )
)
if not defined PY (
  echo [错误] 未找到 Python。请先安装 Python 3.10 或 3.11，安装时勾选 Add to PATH。
  echo        下载地址: https://www.python.org/downloads/
  pause
  exit /b 1
)
echo [Python] %PY%
"%PY%" --version
echo.

rem ---- 2. 安装 Edge-TTS（必装，极快） ----
echo [1/2] 安装 Edge-TTS 极速语音依赖...
"%PY%" -m pip install --upgrade pip -q
"%PY%" -m pip install -r "%~dp0requirements-edge.txt"
if errorlevel 1 (
  echo.
  echo [失败] Edge-TTS 依赖安装失败。可尝试换国内镜像:
  echo        "%PY%" -m pip install -r "%~dp0requirements-edge.txt" -i https://pypi.tuna.tsinghua.edu.cn/simple
  pause
  exit /b 1
)
echo [完成] Edge-TTS 就绪
echo.

rem ---- 3. ChatTTS 可选 ----
if /i "%~1"=="--chattts" goto chattts
echo [提示] ChatTTS 离线引擎体积大（约 2GB），需要时请运行:
echo        install-tts.cmd --chattts
goto verify

:chattts
echo [2/2] 安装 ChatTTS 离线语音依赖（耗时较长，请耐心等待）...
set "HF_ENDPOINT=https://hf-mirror.com"
"%PY%" -m pip install -r "%~dp0requirements-chattts.txt" --index-url https://pypi.tuna.tsinghua.edu.cn/simple
if errorlevel 1 (
  echo [失败] ChatTTS 依赖安装失败，请检查网络后重试。
  pause
  exit /b 1
)
echo [完成] ChatTTS 就绪
echo.

:verify
echo ---- 验证 ----
"%PY%" -c "import edge_tts, fastapi, uvicorn; print('Edge-TTS 依赖: OK')" 2>nul || echo Edge-TTS 依赖: 异常
if exist "%~dp0voices\dafy.txt" echo 预置音色: 7 个
echo.
echo 安装完成。返回上层目录运行「完整流程.cmd」启动服务。
pause
