@echo off
setlocal EnableExtensions
set "ROOT=%~dp0"
set "ROOT_ARG=%ROOT:~0,-1%"
set "STATE=%TEMP%\MES-RGV-Wallboard"
set "EDGE_PROFILE=%STATE%\edge-profile"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%WallboardControl.ps1" -Action start -Root "%ROOT_ARG%" -StateDirectory "%STATE%" -EdgeProfile "%EDGE_PROFILE%" -Url "http://127.0.0.1:4001/wallboard"

set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" pause
endlocal & exit /b %EXITCODE%
