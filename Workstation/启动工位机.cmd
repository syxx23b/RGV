@echo off
setlocal
title SCADA RGV Workstation

set "ROOT=%~dp0"
set "STATION=%SCADA_STATION_NUMBER%"
if "%STATION%"=="" set "STATION=1"
set "PLC_HOST=%SCADA_PLC_HOST%"
if "%PLC_HOST%"=="" set "PLC_HOST=192.168.88.1"
set "MES_API=%MES_SERVER_API%"
if "%MES_API%"=="" set "MES_API=http://127.0.0.1:4000"
set "S7_PORT=%WORKSTATION_S7_PORT%"
if "%S7_PORT%"=="" set "S7_PORT=4103"
set "WEB_PORT=%WORKSTATION_WEB_PORT%"
if "%WEB_PORT%"=="" set "WEB_PORT=4101"

echo Starting workstation OP%STATION%
echo PLC: %PLC_HOST%:102
echo Local S7 API: http://0.0.0.0:%S7_PORT%
echo Local HMI: http://0.0.0.0:%WEB_PORT%
echo MES server API: %MES_API%

start "RGV S7 OP%STATION%" /D "%ROOT%Scada.Rgv.S7Service" cmd /k "set SCADA_STATION_NUMBER=%STATION% ^& set S7__HOST=%PLC_HOST% ^& dotnet run --urls http://0.0.0.0:%S7_PORT%"
start "RGV HMI OP%STATION%" /D "%ROOT%scada-web" cmd /k "set VITE_S7_API=http://127.0.0.1:%S7_PORT% ^& set VITE_SERVER_API=%MES_API% ^& npm run dev -- --host 0.0.0.0 --port %WEB_PORT%"

endlocal
