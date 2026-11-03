@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
title WenCang Local
cd /d "%~dp0"
set "WENCANG_NODE=node"
if exist "%~dp0node.exe" set "WENCANG_NODE=%~dp0node.exe"
"%WENCANG_NODE%" --version >nul 2>&1
if errorlevel 1 goto missing_node
"%WENCANG_NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>&1
if errorlevel 1 goto old_node
"%WENCANG_NODE%" "%~dp0server.mjs"
set "WENCANG_EXIT=%errorlevel%"
if not "%WENCANG_EXIT%"=="0" pause
endlocal & exit /b %WENCANG_EXIT%

:missing_node
echo.
echo Please install Node.js 22 or newer from https://nodejs.org/
echo After installation, close this window and double-click Start.cmd again.
echo You can also double-click index.html to use paste/import/PDF without Node.js.
echo See README.txt for Chinese instructions.
echo.
pause
endlocal & exit /b 1

:old_node
echo.
echo Your Node.js version is too old. Please install Node.js 22 or newer.
echo Official download: https://nodejs.org/
echo.
pause
endlocal & exit /b 1
