@echo off
chcp 65001 >nul
cd /d "%~dp0.."
node bridge.js
if errorlevel 1 (
  echo.
  echo [X] 桥接异常退出，退出码 %errorlevel%
)
pause
