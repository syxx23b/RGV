# RGV 工位机程序

本目录完整复刻自 `C:\Users\syxxz\OneDrive\SCADA\Scada_RGV2`，是独立于 MES 服务器的工位机工程。OP1-OP18 每台工位机都运行一套自己的 RGV 控制和 S7 通讯进程。

## 固定端口

| 部署对象 | 进程 | 端口 | 说明 |
| --- | --- | ---: | --- |
| MES 服务器 | `Mes.Api` | `9100` | MES 业务 API |
| MES 服务器 | `scada-web` | `9102` | MES 管理端、生产看板 |
| MES 服务器 | `Scada.Rgv.S7Service` | `9103` | 服务器独立 S7 服务 |
| 每台工位机 | `scada-web` | `9101` | RGV 控制 HMI，入口 `/rgv` |
| 每台工位机 | `Scada.Rgv.S7Service` | `9104` | 本机独立 S7 API，直接连接 PLC |

现场与本地使用同一套端口。18 台工位机可以重复使用 `9101/9104`，因为部署在不同硬件 IP；服务器端口不与工位机端口重复。

## 配置来源

- PLC 地址：`SCADA_PLC_HOST`，默认 `192.168.88.1`；S7 原生端口固定为 `102`。
- 工位编号：`SCADA_STATION_NUMBER`，范围 `1-40`，用于生成对应工位标签。
- MES API：`MES_SERVER_API`，默认 `http://127.0.0.1:9100`。
- 本机 S7 Web 端口：`WORKSTATION_S7_PORT`，默认 `9104`。
- 本机 HMI Web 端口：`WORKSTATION_WEB_PORT`，默认 `9101`。
- S7 CPU、Rack、Slot、重连与超时：`Scada.Rgv.S7Service/appsettings.json` 的 `S7` 节点。
- 持久化数据：生产环境默认 `C:\ProgramData\Scada RGV`，开发环境使用项目 `data` 目录。

## 启动

```powershell
$env:SCADA_STATION_NUMBER = "7"
$env:SCADA_PLC_HOST = "192.168.88.1"
$env:MES_SERVER_API = "http://192.168.88.10:9100"
.\启动工位机.cmd
```

浏览器打开 `http://<工位机IP>:9101/rgv`。RGV 控制请求只访问本机 `9104`，不经过 MES 服务器或其他工位机。
