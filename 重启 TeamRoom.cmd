@echo off
cd /d "%~dp0"
node scripts\teamroom-control.mjs restart
if errorlevel 1 pause
