@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules\" (
  echo 📦 首次运行，正在安装依赖...
  call npm install
)

if "%1"=="--daemon" (
  echo 🛡️ 正在以 7x24 自愈守护模式启动 盘松 ^(PANSONG^)...
  call npm run daemon
) else (
  echo 🚀 正在启动 盘松 ^(PANSONG^)...
  call npm start
)
pause
