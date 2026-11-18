@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-windows-qa.ps1" %*
set "qa_exit=%errorlevel%"
pause
exit /b %qa_exit%
