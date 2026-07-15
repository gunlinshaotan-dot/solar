@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

title Solar Memesis Launcher
color 0B

echo.
echo  ============================================================
echo.
echo            S O L A R   M E M E S I S
echo         HTML / CSS / JS  +  Node  +  Python
echo.
echo  ============================================================
echo.
echo   [1] Приветствие: добро пожаловать на сервер Solar Memesis
echo   [2] Освобождаем порт 3000...
echo   [3] Node  →  http://0.0.0.0:3000  (все IP этого ПК)
echo   [4] Python → live reload (F5 при изменении css/js/html)
echo.

:: ---- kill anything listening on 3000 ----
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  echo   killing PID %%P on :3000
  taskkill /F /PID %%P >nul 2>&1
)
timeout /t 1 /nobreak >nul

where node >nul 2>&1
if errorlevel 1 (
  echo   [ERROR] Node.js не найден. Установи с https://nodejs.org
  pause
  exit /b 1
)

set "PY_CMD=python"
where python >nul 2>&1
if errorlevel 1 (
  where py >nul 2>&1
  if errorlevel 1 (
    echo   [ERROR] Python не найден. Установи с https://python.org
    pause
    exit /b 1
  )
  set "PY_CMD=py -3"
)

echo   Starting Node server...
start "Solar Memesis — Node :3000" cmd /k "cd /d ""%~dp0"" && node server.js"

timeout /t 1 /nobreak >nul

echo   Starting Python watcher...
start "Solar Memesis — Python Watcher" cmd /k "cd /d ""%~dp0"" && %PY_CMD% watcher.py"

echo.
echo   ----------------------------------------------------------
echo    Solar Memesis online
echo    Local:   http://127.0.0.1:3000
echo    LAN:     http://^<ваш-IP^>:3000
echo   ----------------------------------------------------------
echo.
echo   Правь css/js/html — браузер обновится сам.
echo   Закрой два окна Node/Python чтобы остановить сервер.
echo.
pause
endlocal
