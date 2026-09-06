@echo off
setlocal
set "ROOT=%~dp0"
set "SCADA_STATION_NUMBER=%SCADA_STATION_NUMBER%"
if "%SCADA_STATION_NUMBER%"=="" set "SCADA_STATION_NUMBER=1"
set "SCADA_PLC_HOST=%SCADA_PLC_HOST%"
if "%SCADA_PLC_HOST%"=="" set "SCADA_PLC_HOST=192.168.88.1"
set "MES_SERVER_API=http://127.0.0.1:4000"
set "WORKSTATION_WEB_PORT=4101"
set "WORKSTATION_S7_PORT=4103"

call "%ROOT%启动MES服务器.cmd"
call "%ROOT%Workstation\启动工位机.cmd"

echo.
echo Server MES: http://127.0.0.1:4000
echo Server Web: http://127.0.0.1:4001
echo Server S7:  http://127.0.0.1:4003
echo Workstation RGV: http://127.0.0.1:4101/rgv
echo Workstation S7:  http://127.0.0.1:4103
endlocal
