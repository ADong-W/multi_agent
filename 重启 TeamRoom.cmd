@echo off
cd /d "%~dp0"
echo 正在重启 TeamRoom...
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js。请先安装 Node.js 22 或更高版本。
  echo 下载地址：https://nodejs.org/
  echo.
  pause
  exit /b 1
)
node scripts\teamroom-control.mjs restart
if errorlevel 1 (
  echo.
  echo 重启没有成功，请查看上面的提示。
  pause
) else (
  echo.
  echo TeamRoom 已重启。浏览器会自动打开页面。
)
