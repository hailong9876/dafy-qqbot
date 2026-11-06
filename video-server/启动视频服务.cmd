@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 大肥鱼 · 抖音摸鱼视频服务
echo 正在启动视频服务（127.0.0.1:18903）...
echo 第一次点「登录抖音」会弹出 Edge 窗口，登录一次后会自动记住。
echo 关闭这个窗口即可停止服务。
echo.
node server.js
pause
