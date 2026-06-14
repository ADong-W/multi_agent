@echo off
cd /d "%~dp0"
node scripts\teamroom-control.mjs start
if errorlevel 1 pause
