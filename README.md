# SCADA RGV MES

仓库分为服务器和独立工位机两套部署，二者不共享进程。

## 服务器

- `Mes.Api`：MES 业务 API，`9100`
- `scada-web`：MES 管理端与生产看板，`9102`
- `Scada.Rgv.S7Service`：服务器独立 S7 通讯服务，`9103`
- `SOP`：MES 使用的作业指导文件

启动：

```powershell
dotnet run --project Mes.Api --urls http://0.0.0.0:9100
dotnet run --project Scada.Rgv.S7Service --urls http://0.0.0.0:9103
cd scada-web
npm install
npm run dev -- --host 0.0.0.0 --port 9102
```

服务器只提供 MES 管理和看板，不运行工位机程序，也不提供 RGV 操作 HMI。

## 配置架构与端口

服务器与工位机是两套独立硬件、独立进程和独立 API。服务器 S7 只连接服务器配置的 PLC；每台工位机 S7 只连接本机配置的 PLC，二者互不转发控制命令。

| 系统 | 进程 | 固定端口 | 配置入口 |
| --- | --- | ---: | --- |
| 服务器 | `Mes.Api` | `9100` | `Mes.Api/appsettings.json`、数据库连接配置 |
| 服务器 | `scada-web` | `9102` | `VITE_SERVER_API`（默认同源） |
| 服务器 | `Scada.Rgv.S7Service` | `9103` | `Scada.Rgv.S7Service/appsettings.json` 的 `S7` 节点 |
| 工位机 OP1-OP18 | `scada-web` | `9101` | `VITE_S7_API`（默认本机 `9104`）、`MES_SERVER_API` |
| 工位机 OP1-OP18 | `Scada.Rgv.S7Service` | `9104` | `SCADA_STATION_NUMBER`、`SCADA_PLC_HOST`、`appsettings.json` |

S7 服务对 PLC 使用原生端口 `102`；上表端口是各自 Web/API 进程的监听端口。端口约定本地和现场一致，18 台工位机可重复使用 `9101/9104`，通过硬件 IP 隔离。

运行 `启动本地双工程.cmd`：服务器使用 `9100/9102/9103`，工位机使用 `9101/9104`，打开 `http://127.0.0.1:9101/rgv`。现场部署使用完全相同的端口约定；18 台工位机可使用相同端口，通过各自硬件 IP 隔离。

## 工位机

`Workstation` 是从 `C:\Users\syxxz\OneDrive\SCADA\Scada_RGV2` 复刻的完整 RGV 控制工程。OP1-OP18 每台工位机各自运行：

- RGV HMI：`9101`
- 本机 S7 服务：`9104`

使用 `Workstation\启动工位机.cmd` 启动，并通过 `SCADA_STATION_NUMBER`、`SCADA_PLC_HOST` 配置工位号和 PLC 地址。工位机控制只访问本机 `9104`，不经过服务器 S7 服务。

## 构建

```powershell
dotnet build Scada.Rgv.sln
cd scada-web
npm run lint
npm run build
cd ..\Workstation\Scada.Rgv.S7Service
dotnet build
cd ..\scada-web
npm run lint
npm run build
```
