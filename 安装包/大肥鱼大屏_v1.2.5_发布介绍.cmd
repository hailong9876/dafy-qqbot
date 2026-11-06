@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 大肥鱼智能大屏 v1.2.5 - 发布介绍
color 0E
mode con cols=88 lines=40

set "SD=%~dp0"
set "SD=%SD:~0,-1%"
if exist "%SD%\index.html" (set "APP=%SD%") else if exist "%SD%\..\index.html" (set "APP=%SD%\..") else (set "APP=%SD%")

:head
cls
echo ================================================================
echo                                                              
echo        大大的鱼  ·  大肥鱼智能大屏   v1.2.5                  
echo                                                              
echo ================================================================
echo.
echo   【简介】
echo   大肥鱼智能大屏是一套面向桌面的 AI 智能体大屏应用：
echo   · 全屏可视化界面（WebView2），支持对话 / 语音 / 视频 / 日程
echo   · 内置 QQ 机器人桥接，可与 QQ 好友 / 群聊实时互通
echo   · 双语音引擎：Edge-TTS 极速联网语音 + ChatTTS 离线高音质
echo   · 7 种预置离线音色，支持一键生成新音色（实验性）
echo   · 全部数据本地存储，无需注册、不上传隐私
echo.
echo   【本版本 v1.2.5 更新内容】
echo   + 新增 语音合成模块（设置 - 语音 页签）
echo   + 双引擎架构：Edge-TTS（约 1 秒） / ChatTTS（离线 CPU）
echo   + 8 个微软官方中文音色：晓晓 / 小艺 / 云健 / 云希 /
echo     云夏 / 云扬 / 小北(东北话) / 小妮(陕西话)
echo   + 7 个 ChatTTS 预置音色：大肥鱼 / 3 女声 / 2 男声 / 童声
echo   + 修复 ChatTTS 句尾截断问题（末尾追加 0.5 秒静音）
echo   + 修复音色列表加载与试听 422 报错
echo   + 优化 Edge-TTS 缓存原子写入，避免并发读到半截音频
echo   + 优化 Python / Node 路径自动探测，安装后即可运行
echo   + 新增 keep_alive.js 守护进程（30 秒健康巡检）
echo.
echo   【快速开始】
echo   1. 运行安装包完成安装（自动创建桌面快捷方式）
echo   2. 双击桌面「大肥鱼智能大屏」启动主界面
echo   3. 首次启用语音：打开「设置 - 语音」页签
echo      · 选 Edge-TTS 引擎 → 点「试听」，约 1 秒出声
echo      · 离线音色请先运行「完整流程.cmd」安装 ChatTTS 依赖
echo   4. QQ 机器人：在 qqbot 目录运行 bridge.cmd 并按提示扫码登录
echo.
echo   【服务与端口】
echo   Bridge    127.0.0.1:18902   QQ 机器人桥接 / 语音代理
echo   ChatTTS   127.0.0.1:18903   离线语音合成（CPU）
echo   Edge-TTS  127.0.0.1:18904   极速联网语音合成
echo   Gateway   127.0.0.1:18899   AI 模型网关
echo.
echo   【运行环境】
echo   Windows 10/11 (64 位) · WebView2 运行时
echo   语音功能需要 Python 3.10+；Edge-TTS 需联网，
echo   ChatTTS 完全离线但 CPU 推理较慢（约 30-60 秒/句）
echo.
echo   【使用说明】
echo   · 完整流程.cmd —— 环境检查 / 安装依赖 / 启停服务 / 状态查询
echo   · 本文件        —— 版本说明与功能介绍
echo.
echo ================================================================
echo   [1] 查看服务状态    [2] 启动全部服务    [3] 打开大屏
echo   [4] 打开完整流程    [0] 退出
echo ================================================================
set /p "CH=请选择: "
if "%CH%"=="1" goto st
if "%CH%"=="2" goto go
if "%CH%"=="3" goto open
if "%CH%"=="4" goto flow
if "%CH%"=="0" exit /b 0
goto head

:st
echo.
powershell -NoProfile -Command ^
  "$u=@(@{n='Bridge';p=18902;q='/api/tts2/status'},@{n='Edge-TTS';p=18904;q='/health'},@{n='ChatTTS';p=18903;q='/health'});" ^
  "foreach($x in $u){ try{$r=Invoke-WebRequest ('http://127.0.0.1:'+$x.p+$x.q) -TimeoutSec 3 -UseBasicParsing; Write-Host ('  ' + $x.n.PadRight(10) + $x.p + '  [OK] ' + $r.StatusCode) -ForegroundColor Green}catch{ Write-Host ('  ' + $x.n.PadRight(10) + $x.p + '  [未运行]') -ForegroundColor Red}}"
echo.
pause
goto head

:go
if exist "%APP%\keep_alive.js" (
  start "大肥鱼服务守护" cmd /c "node ""%APP%\keep_alive.js"" & pause"
  echo 已在新窗口启动全部服务。
) else (
  echo [提示] 未找到 keep_alive.js，请使用「完整流程.cmd」操作。
)
timeout /t 3 >nul
goto head

:open
if exist "%APP%\大肥鱼大屏.exe" (start "" "%APP%\大肥鱼大屏.exe") else (start "" "%APP%\index.html")
timeout /t 2 >nul
goto head

:flow
if exist "%SD%\大肥鱼大屏_v1.2.5_完整流程.cmd" (
  call "%SD%\大肥鱼大屏_v1.2.5_完整流程.cmd"
) else (
  echo [提示] 未找到「完整流程.cmd」。
  pause
)
goto head
