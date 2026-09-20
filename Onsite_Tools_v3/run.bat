@echo off
REM ============================================================
REM  Onsite Tools v3 - Windows launcher (Node.js, no Python)
REM  Copy this folder anywhere and double-click run.bat.
REM  First run: installs packages, creates the local database
REM  and builds the app (needs Node.js 20.19+ and internet once).
REM  Options:  run.bat --lan      listen on all interfaces
REM            run.bat --rebuild  force a new build
REM ============================================================
setlocal
cd /d "%~dp0"
title Onsite Tools v3

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo  Node.js was not found. Install Node.js 22 LTS from https://nodejs.org/ and run this file again.
    echo.
    pause
    exit /b 1
)

set "MODE=start"
set "REBUILD="
:args
if "%~1"=="" goto run
if /i "%~1"=="--lan" set "MODE=start:lan"
if /i "%~1"=="--rebuild" set "REBUILD=1"
shift
goto args

:run
if not exist "node_modules\next\package.json" (
    echo Installing packages - the first run takes a few minutes...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo  npm install failed. Check the internet connection or proxy and run again.
        pause
        exit /b 1
    )
)

echo Preparing the local database (data\onsite.db)...
call npx prisma db push >nul
if errorlevel 1 (
    echo  Could not create or update the local database.
    pause
    exit /b 1
)

if defined REBUILD if exist ".next" rmdir /s /q ".next"
if not exist ".next\BUILD_ID" (
    echo Building the app - about a minute...
    call npm run build
    if errorlevel 1 (
        echo  Build failed.
        pause
        exit /b 1
    )
)

echo.
echo ============================================================
echo   Onsite Tools v3  -^>  http://127.0.0.1:8090
echo   Close this window or press CTRL+C to stop.
echo ============================================================
echo.
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:8090"
call npm run %MODE%
echo.
echo Server stopped.
pause
endlocal
