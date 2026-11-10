@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "APP_DIR=%~dp0"
set "TASK_NAME=PanSongDaemon"

if "%1"=="uninstall" (
  schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1
  echo ✅ 已移除 Windows 计划任务自启服务 (%TASK_NAME%)
  pause
  exit /b 0
)

if not exist "node_modules\" (
  echo 📦 正在安装依赖...
  call npm install --omit=dev
)

for /f "delims=" %%i in ('where node') do set "NODE_EXE=%%i" & goto :found_node
echo ❌ 未找到 Node.js，请先安装 Node.js
pause
exit /b 1

:found_node
echo 🛡️ 正在注册 Windows 后台计划任务 (%TASK_NAME%)...
schtasks /Create /TN "%TASK_NAME%" /TR "\"%NODE_EXE%\" \"%APP_DIR%src\daemon.js\"" /SC ONLOGON /RL HIGHEST /F
schtasks /Run /TN "%TASK_NAME%"

echo ✅ 盘松 (PANSONG) 已作为 Windows 后台服务启动并设置登录自启！
echo 🌐 访问地址: http://localhost:3200
echo 💡 如需卸载自启服务，请执行: deploy-service.bat uninstall
pause
