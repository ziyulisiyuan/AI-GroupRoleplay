@echo off
setlocal
title AI-GroupChat Stop
cd /d "%~dp0"

for %%p in (8787 5173) do (
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:":%%p .*LISTENING"') do (
    taskkill /f /pid %%a >nul 2>&1
  )
)
rem close only the windows opened by start.bat (matched by exact title prefix)
taskkill /fi "WINDOWTITLE eq AI-Chat*" >nul 2>&1

echo AI-GroupChat backend and frontend stopped.
ping -n 4 127.0.0.1 >nul
exit /b 0
