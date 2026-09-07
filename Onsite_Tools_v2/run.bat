@echo off
REM ============================================================
REM  Onsite Tools v2 - Windows launcher
REM  Copy this folder anywhere, double-click run.bat.
REM  First run creates .venv and installs requirements.txt
REM  (needs Python 3.9+ and, on the first run, internet access).
REM ============================================================
setlocal
cd /d "%~dp0"
title Onsite Tools v2

set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY ( where python >nul 2>&1 && set "PY=python" )
if not defined PY (
    echo.
    echo  Python 3 was not found. Install Python 3.9 or newer from https://www.python.org/downloads/
    echo  and tick "Add python.exe to PATH" during setup, then run this file again.
    echo.
    pause
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo Creating virtual environment...
    %PY% -m venv .venv
    if errorlevel 1 (
        echo Failed to create the virtual environment.
        pause
        exit /b 1
    )
)
set "VPY=.venv\Scripts\python.exe"

set "STAMP=.venv\requirements.stamp"
fc /b requirements.txt "%STAMP%" >nul 2>&1
if errorlevel 1 (
    echo Installing dependencies - the first run can take a few minutes...
    "%VPY%" -m pip install --disable-pip-version-check -q --upgrade pip >nul 2>&1
    "%VPY%" -m pip install --disable-pip-version-check -r requirements.txt
    if errorlevel 1 (
        echo.
        echo  Dependency installation failed. Check the internet connection / proxy and run again.
        echo  Starting anyway in case the packages are already present...
        echo.
    ) else (
        copy /y requirements.txt "%STAMP%" >nul
    )
)

"%VPY%" -m app %*
echo.
echo Server stopped.
pause
endlocal
