@echo off
setlocal
title AI-GroupChat Launcher
cd /d "%~dp0"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pnpm not found. Install Node.js 22+ first, then: npm install -g pnpm
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing dependencies, takes 1-2 minutes, only once...
  call pnpm install
  if errorlevel 1 (
    echo [ERROR] pnpm install failed. Check network and retry.
    pause
    exit /b 1
  )
)

netstat -ano | findstr /r /c:":8787 .*LISTENING" >nul
if errorlevel 1 (
  echo Starting backend on port 8787 ...
  start "AI-Chat Backend" cmd /k "pnpm host"
  call :waitport 8787 Backend
) else (
  echo Backend already running on 8787, skip.
)

netstat -ano | findstr /r /c:":5173 .*LISTENING" >nul
if errorlevel 1 (
  echo Starting frontend on port 5173 ...
  start "AI-Chat Frontend" cmd /k "pnpm web:dev"
  call :waitport 5173 Frontend
) else (
  echo Frontend already running on 5173, skip.
)

start "" http://localhost:5173
echo.
echo ==================================================
echo   Browser opened: http://localhost:5173
echo   To stop: double-click stop.bat, or close the two
echo   windows titled "AI-Chat Backend / Frontend".
echo ==================================================
ping -n 9 127.0.0.1 >nul
exit /b 0

:waitport
setlocal
set /a tries=0
:waitloop
netstat -ano | findstr /r /c:":%1 .*LISTENING" >nul
if not errorlevel 1 (
  echo %2 is ready on port %1.
  endlocal
  exit /b 0
)
set /a tries+=1
if %tries% gtr 45 (
  echo [WARN] Timeout waiting for %2 on port %1. Check the AI-Chat window for errors.
  endlocal
  exit /b 1
)
ping -n 2 127.0.0.1 >nul
goto waitloop
