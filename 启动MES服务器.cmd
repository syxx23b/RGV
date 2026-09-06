@echo off
setlocal
set "ROOT=%~dp0"

start "MES API" /D "%ROOT%Mes.Api" cmd /k "dotnet run --no-launch-profile --urls http://0.0.0.0:4000"
start "MES S7" /D "%ROOT%Scada.Rgv.S7Service" cmd /k "dotnet run --no-launch-profile --urls http://0.0.0.0:4003"
start "MES Web" /D "%ROOT%scada-web" cmd /k "npm run dev -- --host 0.0.0.0 --port 4001"

echo MES API: http://<server-ip>:4000
echo MES Web: http://<server-ip>:4001
echo Server S7: http://<server-ip>:4003
endlocal
