@echo off
setlocal
title Install Disorder Vencord

set "DISORDER_INSTALLER=%~dp0Install-Disorder.ps1"
if not exist "%DISORDER_INSTALLER%" (
    echo Install-Disorder.ps1 must be downloaded into this same folder first.
    echo No changes were made.
    pause
    exit /b 2
)

echo This will install the downloaded, signed Disorder Vencord release.
echo Discord will need to be fully closed and reopened afterward.
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%DISORDER_INSTALLER%"
set "DISORDER_EXIT=%ERRORLEVEL%"
if not "%DISORDER_EXIT%"=="0" (
    echo.
    echo Installation stopped with an error. Review the message above; no unverified payload was executed.
)
echo.
pause
exit /b %DISORDER_EXIT%
