@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 大肥鱼智能大屏 v1.3.2 - 发布介绍
color 0E
mode con cols=88 lines=40

set "SD=%~dp0"
set "SD=%SD:~0,-1%"
if exist "%SD%\index.html" (set "APP=%SD%") else if exist "%SD%\..\index.html" (set "APP=%SD%\..") else (set "APP=%SD%")

:head
cls
echo ================================================================
echo                                                              
echo        大大的鱼  ·  大肥鱼智能大屏   v1.3.2                  
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
echo   【本版本 v1.3.2 更新内容】
echo   + 新增 通用打开能力：可打开任意应用 / 文件 / 网页
echo   + 新增 大屏对话中的 ⏹ 停止按钮，随时中断生成
echo   + 新增 视频·文件服务（18905）纳入守护与巡检
echo   + 修复 安装包缺少视频服务，导致文件浏览 / 删除不可用
echo   + 修复 删除文件时报 Failed to fetch
echo   + 修复 后台服务弹出一堆黑色控制台窗口（现已完全隐藏）
echo   + 优化 移除工具调用 6 轮上限，可连续执行多步任务
echo   + 优化 子进程直启（不经过 cmd 中间层），启动更干净
echo   + 优化 18905 纳入 30 秒健康巡检，掉线自动重启
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
echo   Gateway   127.0.0.1:18900   AI 模型网关
echo   大屏文件  127.0.0.1:18901   大屏静态文件服务
echo   Bridge    127.0.0.1:18902   QQ 机器人桥接 / 语音代理
echo   ChatTTS   127.0.0.1:18903   离线语音合成（CPU）
echo   Edge-TTS  127.0.0.1:18904   极速联网语音合成
echo   视频文件  127.0.0.1:18905   抖音摸鱼 / 文件浏览与删除
echo   电脑控制  127.0.0.1:18907   本机电脑控制服务
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
  "$u=@(@{n='Gateway';p=18900},@{n='大屏文件    ';p=18901},@{n='Bridge';p=18902},@{n='ChatTTS';p=18903},@{n='Edge-TTS';p=18904},@{n='视频文件    ';p=18905},@{n='电脑控制    ';p=18907});" ^
  "foreach($x in $u){ $c=New-Object Net.Sockets.TcpClient; try{ if($c.ConnectAsync('127.0.0.1',$x.p).Wait(1200) -and $c.Connected){Write-Host ('  ' + $x.n + '  ' + $x.p + '  [OK]') -ForegroundColor Green}else{throw} }catch{ Write-Host ('  ' + $x.n + '  ' + $x.p + '  [未运行]') -ForegroundColor Red }finally{ $c.Close() }}"
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
if exist "%SD%\大肥鱼大屏_v1.3.2_完整流程.cmd" (
  call "%SD%\大肥鱼大屏_v1.3.2_完整流程.cmd"
) else (
  echo [提示] 未找到「完整流程.cmd」。
  pause
)
goto head
