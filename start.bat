@echo off
rem Split Relay - double-click to start. Keep the window open during the meet; Ctrl+C stops it.
rem Options are passed on, for example:  start.bat --port 5591   or   start.bat --no-open
rem Written with goto labels, not ( ) blocks: cmd expands %VARIABLES% inside a block too early.
setlocal EnableExtensions
title Split Relay
cd /d "%~dp0"

rem More file-system threads, so one slow network share (FinishLynx folder, names file) cannot hold up the rest.
if not defined UV_THREADPOOL_SIZE set "UV_THREADPOOL_SIZE=16"

set "NODE_EXE="
for %%I in (node.exe) do set "NODE_EXE=%%~$PATH:I"
if defined NODE_EXE goto found
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if defined NODE_EXE goto found
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if defined NODE_EXE goto found
if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"
if defined NODE_EXE goto found

echo.
echo   Split Relay needs Node.js, and Node.js was not found on this PC.
echo   Install the LTS version from https://nodejs.org - version 18.17 or newer -
echo   then double-click start.bat again.
echo.
pause
exit /b 1

:found
"%NODE_EXE%" -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>18||(a===18&&b>=17)?0:1)"
if errorlevel 1 goto tooold

rem The launcher starts Split Relay and, after "Install update" in the panel, starts the new version again.
rem One line with "goto": an update may replace this file while Split Relay runs, and cmd then finds :done by name.
"%NODE_EXE%" "%~dp0src\launcher.js" %* & goto done

:done
set "CODE=%ERRORLEVEL%"
if "%CODE%"=="0" exit /b 0
echo.
echo   Split Relay stopped with an error, code %CODE%. The messages above say why.
echo   The log files are in "%~dp0data\logs".
echo.
pause
exit /b %CODE%

:tooold
set "NODE_VER=an old version"
for /f "delims=" %%V in ('call "%NODE_EXE%" --version') do set "NODE_VER=%%V"
echo.
echo   Split Relay needs Node.js 18.17 or newer, but this PC has %NODE_VER%
echo   at %NODE_EXE%
echo   Install the LTS version from https://nodejs.org, then double-click start.bat again.
echo.
pause
exit /b 1
