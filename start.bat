@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [Solar Nemesis] Node.js не найден.
  echo Установи с https://nodejs.org/ и снова запусти start.bat
  pause
  exit /b 1
)

echo.
echo  Solar Nemesis
echo  http://127.0.0.1:3000
echo  Ctrl+C — остановить
echo.

start "" "http://127.0.0.1:3000"
node server.js
pause
