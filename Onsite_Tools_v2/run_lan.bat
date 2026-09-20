@echo off
REM Start Onsite Tools v2 reachable from other PCs on the LAN (http://<this-pc-ip>:8088)
cd /d "%~dp0"
call run.bat --host 0.0.0.0 %*
