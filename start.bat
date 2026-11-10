@echo off
rem lan-drop: double-click this file on Windows to start the server.
cd /d "%~dp0"

rem Use the portable Node.js in the "node" folder if there is one, otherwise the installed one.
set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"

"%NODE%" --version >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  echo Install Node.js 20 or newer, or unzip the portable Node.js into a folder named "node" here.
  pause
  exit /b 1
)

"%NODE%" dist\server\main.js
pause
