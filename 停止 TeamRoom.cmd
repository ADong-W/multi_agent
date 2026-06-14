@echo off
cd /d "%~dp0"
node scripts\teamroom-control.mjs stop
if errorlevel 1 pause
