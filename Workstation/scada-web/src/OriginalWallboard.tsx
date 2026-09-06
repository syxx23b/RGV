import { useEffect, useState } from 'react'
import './App.css'
import { DigitalTwinWallboardGraphic, StationSelectGraphic } from './DigitalTwinModule'
import { S7_API, postS7Command } from './s7Api'

type TowerLightStatus = 'orange' | 'green' | 'red'
function isTagEnabled(value: string) {
  return value.trim().toLowerCase() === 'true' || value.trim() === '1'
}

function formatStationNumber(value: string) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? `OP${number}` : '--'
}

function formatPosition(value: string) {
  const number = Number(value)
  return Number.isFinite(number) ? String(number) : '--'
}

function resolveMissionState(value: string) {
  const number = Number(value)
  const labels: Record<number, { zh: string; en: string }> = {
    0: { zh: '待命', en: 'Standby' },
    1: { zh: '取货移动', en: 'Moving to Pickup' },
    2: { zh: '取货移动', en: 'Moving to Pickup' },
    3: { zh: '取货输送', en: 'Pickup Conveying' },
    4: { zh: '送货移动', en: 'Moving to Delivery' },
    5: { zh: '送货移动', en: 'Moving to Delivery' },
    6: { zh: '送货移动', en: 'Moving to Delivery' },
    7: { zh: '送货输送', en: 'Delivery Conveying' },
    8: { zh: '避障移动', en: 'Obstacle Avoidance Movement' },
  }
  return {
    value: Number.isInteger(number) && number >= 0 ? String(number) : '--',
    ...(labels[number] ?? { zh: '未知状态', en: 'Unknown' }),
  }
}

function resolveTowerLightStatus(statuses: TowerLightStatus[]): TowerLightStatus {
  if (statuses.includes('red')) return 'red'
  if (statuses.includes('green')) return 'green'
  return 'orange'
}

type StationOperationLabels = Record<string, string>
type SystemConfiguration = { stationNumber: number; serverIp?: string; isInterfaceFlipped: boolean; maxPos?: number }
type ActiveWorkOrder = { workOrderNo: string; productName: string; routeId: number; routeName: string; sequenceNo: number; operationName: string; stationCode: string }
type WallboardS7State = {
  hlg: string
  hlo: string
  hlr: string
  mode: string
  missionState: string
  rgvFrom: string
  rgvTo: string
  realTimePos: string
  sbes: string
  mode0EqSend1EqCall: string
  maxPos: string
  stationPositions: Map<number, number>
}
async function writeConveyorCommand(direction: 'forward' | 'reverse', active: boolean) {
  await postS7Command('conveyor', { direction, active })
}

export function WallboardApp({ onExit }: { onExit?: () => void } = {}) {
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const [s7State, setS7State] = useState<WallboardS7State>({
    hlg: 'False',
    hlo: 'False',
    hlr: 'False',
    mode: 'False',
    missionState: '0',
    rgvFrom: '0',
    rgvTo: '0',
    realTimePos: '0',
    sbes: 'False',
    mode0EqSend1EqCall: 'False',
    maxPos: '20',
    stationPositions: new Map(),
  })
  const [stationNumber, setStationNumber] = useState(1)
  const [isInterfaceFlipped, setIsInterfaceFlipped] = useState(false)
  const [serverIp, setServerIp] = useState('127.0.0.1')
  const [activeWorkOrder, setActiveWorkOrder] = useState<ActiveWorkOrder | null>(null)
  const [sopOpen, setSopOpen] = useState(false)
  const [s7Connected, setS7Connected] = useState(false)

  useEffect(() => {
    const updateViewport = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', updateViewport)
    return () => window.removeEventListener('resize', updateViewport)
  }, [])

  useEffect(() => {
    let active = true
    const readConfiguration = async () => {
      try {
        const response = await fetch(`${S7_API}/api/system/configuration`)
        if (!response.ok) return
        const configuration = await response.json() as SystemConfiguration
        if (!active) return
        setStationNumber(configuration.stationNumber)
        setIsInterfaceFlipped(configuration.isInterfaceFlipped === true)
        setServerIp(configuration.serverIp?.trim() || '127.0.0.1')
      } catch {
        // The wallboard remains usable with sequential station labels when the S7 service is offline.
      }
    }
    void readConfiguration()
    const timer = window.setInterval(() => void readConfiguration(), 2000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    const serverBase = /^https?:\/\//i.test(serverIp) ? serverIp.replace(/\/$/, '') : `http://${serverIp}:9100`
    let active = true
    const readActiveWorkOrder = async () => {
      try {
        const response = await fetch(`${serverBase}/api/workstations/OP${stationNumber}/active-work-order`)
        if (!response.ok) throw new Error('MES server unavailable')
        const workOrder = await response.json() as ActiveWorkOrder | null
        if (active) {
          setActiveWorkOrder(workOrder?.routeId && workOrder.sequenceNo ? workOrder : null)
          if (!workOrder) setSopOpen(false)
        }
      } catch {
        if (active) {
          setActiveWorkOrder(null)
          setSopOpen(false)
        }
      }
    }
    void readActiveWorkOrder()
    const timer = window.setInterval(() => void readActiveWorkOrder(), 3000)
    return () => { active = false; window.clearInterval(timer) }
  }, [serverIp, stationNumber])

  useEffect(() => {
    let requestInFlight = false
    const fetchS7State = async () => {
      if (requestInFlight) return
      requestInFlight = true
      try {
        const [statusResponse, tagsResponse] = await Promise.all([
          fetch(`${S7_API}/api/s7/status`),
          fetch(`${S7_API}/api/s7/tags`),
        ])
        if (!statusResponse.ok || !tagsResponse.ok) throw new Error('S7 service unavailable')
        const status = await statusResponse.json() as { connected: boolean }
        const tags = await tagsResponse.json() as Array<{ name: string; value: string; quality?: string }>
        setS7Connected(status.connected === true)
        const readTag = (name: string) => tags.find((tag) => tag.name === name)?.value ?? ''
        const stationPositions = new Map<number, number>()
        for (const tag of tags) {
          if (tag.name.startsWith('StationState[') && tag.name.endsWith('.Position') && tag.quality !== 'Bad') {
            const start = tag.name.indexOf('[')
            const end = tag.name.indexOf(']', start)
            const index = Number(tag.name.slice(start + 1, end))
            const parsed = Number(tag.value)
            if (Number.isInteger(index) && index >= 1 && Number.isFinite(parsed)) stationPositions.set(index, parsed)
          }
        }
        setS7State({
          hlg: readTag('HLG'),
          hlo: readTag('HLO'),
          hlr: readTag('HLR'),
          mode: readTag('Mode0EQAuto1EQManual'),
          missionState: readTag('MissionState'),
          rgvFrom: readTag('RGVFrom'),
          rgvTo: readTag('RGVTo'),
          realTimePos: readTag('RealTimePos'),
          sbes: readTag('SBes'),
          mode0EqSend1EqCall: readTag('Mode0EQSend1EQCall'),
          maxPos: readTag('MaxPos'),
          stationPositions,
        })
      } catch {
        setS7Connected(false)
        setS7State((current) => ({ ...current, hlg: '', hlo: '', hlr: '', mode: '', missionState: '', rgvFrom: '', rgvTo: '', realTimePos: '', sbes: '', mode0EqSend1EqCall: '', maxPos: '', stationPositions: new Map() }))
      } finally {
        requestInFlight = false
      }
    }
    void fetchS7State()
    const timer = window.setInterval(fetchS7State, 50)
    return () => window.clearInterval(timer)
  }, [])

  const stationOperationLabels: StationOperationLabels = {}
  const wallboardScale = Math.min(1, viewport.width / 3840, viewport.height / 2160)
  const stageStyle = { width: `${3840 * wallboardScale}px`, height: `${2160 * wallboardScale}px` }
  const towerLightStatus = resolveTowerLightStatus(
    isTagEnabled(s7State.hlr) ? ['red'] :
    isTagEnabled(s7State.hlg) ? ['green'] :
    isTagEnabled(s7State.hlo) ? ['orange'] :
    []
  )

  return (
    <main className="wallboard-page wallboard-demo-flow">
      <div className="wallboard-scale-stage" style={stageStyle}>
        <section className="wallboard-canvas" style={{ transform: `scale(${wallboardScale})` }}>
          <header className="wallboard-topbar">
            <div
              className={`wallboard-tower-status-bar status-${towerLightStatus}`}
              aria-label={`三色灯状态：${towerLightStatus === 'red' ? '红色' : towerLightStatus === 'green' ? '绿色' : '橙色'}`}
            />
            <div className="wallboard-brand-block">
              <span className="wallboard-kicker">RGV Control System</span>
              <h1>
                {`RGV控制系统 | OP${stationNumber}`}
                <button type="button" className={`wallboard-sop-fab wallboard-title-sop${activeWorkOrder ? '' : ' disabled'}`} onClick={() => { if (activeWorkOrder) setSopOpen((current) => !current) }} disabled={!activeWorkOrder} aria-pressed={sopOpen} aria-label={activeWorkOrder ? (sopOpen ? '关闭当前工位 SOP' : '打开当前工位 SOP') : '当前无执行任务'} title={activeWorkOrder ? (sopOpen ? '关闭 SOP' : `打开 ${activeWorkOrder.operationName} SOP`) : '当前工位暂无执行中的任务'}>SOP</button>
              </h1>
            </div>
            <div className="wallboard-topbar-right">
              <div className="wallboard-status-cluster">
                <span className={`wallboard-sync-pill wallboard-s7-status ${s7Connected ? 'online' : 'offline'}`} aria-label={`S7 ${s7Connected ? '在线' : '离线'}`}>
                  <svg className="wallboard-s7-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {s7Connected ? (
                      <>
                        <path d="M8.29 15.04a5.5 5.5 0 0 1 7.42 0" />
                        <path d="M5.1 11.86a10.5 10.5 0 0 1 13.8 0" />
                        <path d="M1.92 8.67a15.5 15.5 0 0 1 20.16 0" />
                        <circle cx="12" cy="18.75" r="0.5" />
                      </>
                    ) : (
                      <>
                        <path d="M8.29 15.04a5.5 5.5 0 0 1 7.42 0" opacity="0.5" />
                        <path d="M5.1 11.86a10.5 10.5 0 0 1 13.8 0" opacity="0.5" />
                        <path d="M1.92 8.67a15.5 15.5 0 0 1 20.16 0" opacity="0.5" />
                        <circle cx="12" cy="18.75" r="0.5" />
                      </>
                    )}
                  </svg>
                </span>
                {onExit ? <button type="button" className="wallboard-exit-inline" onClick={onExit} aria-label="退出 Log out"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9" /></svg></button> : null}
              </div>
            </div>
          </header>

          {sopOpen && activeWorkOrder && <section className="wallboard-sop-viewer" aria-label="当前执行任务 SOP">
            <iframe title={`${activeWorkOrder.operationName} SOP`} src={`${/^https?:\/\//i.test(serverIp) ? serverIp.replace(/\/$/, '') : `http://${serverIp}:9100`}/api/sop-documents/${activeWorkOrder.routeId}/${activeWorkOrder.sequenceNo}#page=1&zoom=page-fit&view=Fit&navpanes=0`} />
          </section>}

          <WallboardFlowDemo stationOperationLabels={stationOperationLabels} s7State={s7State} wallboardScale={wallboardScale} isInterfaceFlipped={isInterfaceFlipped} />
        </section>
      </div>
    </main>
  )
}

function TwinStationButton({ label, motionType, wallboardScale }: { label: '输送' | '退回'; motionType: 'forward' | 'reverse'; wallboardScale: number }) {
  const [pressed, setPressed] = useState(false)
  const active = pressed
  const press = () => {
    setPressed(true)
    void writeConveyorCommand(motionType, true).catch(() => setPressed(false))
  }
  const release = () => {
    setPressed(false)
    void writeConveyorCommand(motionType, false).catch(() => undefined)
  }
  const isForward = motionType === 'forward'
  const direction = isForward ? 'up' : 'down'
  const motionClass = isForward ? 'forward' : 'reverse'

  const guidePath = isForward ? 'M 34 85 V 51' : 'M 34 51 V 85'
  const chevron1Path = isForward ? 'M 21 81 L 34 69 L 47 81' : 'M 21 55 L 34 67 L 47 55'
  const chevron2Path = isForward ? 'M 21 66 L 34 54 L 47 66' : 'M 21 70 L 34 82 L 47 70'

  return (
    <button
      type="button"
      className={`wallboard-twin-station-button${active ? ' active' : ''}`} style={{ width: `${68 / wallboardScale}px`, height: `${90 / wallboardScale}px` }}
      onPointerDown={press}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      aria-pressed={active}
      aria-label={`${label} ${isForward ? '正转' : '反转'}`}
    >
      <svg className="wallboard-twin-station-svg" viewBox="0 0 68 90" style={{ width: `${68 / wallboardScale}px`, height: `${90 / wallboardScale}px` }} aria-hidden="true">
        <rect x="0" y="0" width="68" height="90" fill="#f2f4f6" stroke="#07111d" strokeWidth="3" />
        <text x="34" y="22" fill="#172d4d" textAnchor="middle" fontSize="19" fontWeight="800">{label}</text>
        {active ? (
          <g>
            <path className={`digital-twin-station-motion ${motionClass} flow-guide`} d={guidePath} />
            <path className={`digital-twin-station-motion ${motionClass} flow-chevron flow-${direction}`} d={chevron1Path} />
            <path className={`digital-twin-station-motion ${motionClass} flow-chevron flow-${direction} secondary`} d={chevron2Path} />
          </g>
        ) : (
          <g>
            <rect x="23" y="55.5" width="8" height="25" fill="#12171c" />
            <rect x="37" y="55.5" width="8" height="25" fill="#12171c" />
          </g>
        )}
      </svg>
    </button>
  )
}

function WallboardFlowDemo({ stationOperationLabels, s7State, wallboardScale, isInterfaceFlipped }: { stationOperationLabels: StationOperationLabels; s7State: WallboardS7State; wallboardScale: number; isInterfaceFlipped: boolean }) {
  const automaticMode = !isTagEnabled(s7State.mode)
  const missionState = resolveMissionState(s7State.missionState)

  return (
    <section className="wallboard-layout wallboard-layout-flow">
      <div className="wallboard-ribbon-row">
        <article className={`wallboard-metric-card wallboard-mode-card ${isTagEnabled(s7State.mode) ? 'mode-manual' : 'mode-auto'}`} aria-label="模式 Mode">
          <div className="wallboard-card-title"><span>模式</span><small>Mode</small></div>
          <div className="wallboard-card-main">
            <strong>{isTagEnabled(s7State.mode) ? '手动 Manual' : '自动 Auto'}</strong>
          </div>
          {!automaticMode && (
            <div className="wallboard-mode-station-controls" aria-label="手动工位操作">
              <TwinStationButton label="输送" motionType="forward" wallboardScale={wallboardScale} />
              <TwinStationButton label="退回" motionType="reverse" wallboardScale={wallboardScale} />
            </div>
          )}
          <div className="wallboard-card-foot" aria-hidden="true" />
        </article>
        <article className={`wallboard-metric-card wallboard-task-card accent-cyan ${automaticMode ? 'mode-auto' : 'mode-manual'}`} aria-label="任务状态 Task Status">
          <div className="wallboard-card-title"><span>任务状态</span><small>Task Status</small></div>
          <div className="wallboard-card-main">
            <div className="wallboard-task-route">
              <strong>{formatStationNumber(s7State.rgvFrom)}</strong>
              <b aria-hidden="true">→</b>
              <strong>{formatStationNumber(s7State.rgvTo)}</strong>
            </div>
          </div>
          <div className="wallboard-card-foot">坐标 | Position：{formatPosition(s7State.realTimePos)}</div>
        </article>
        <section className={`wallboard-panel wallboard-metric-card wallboard-mission-panel ${automaticMode ? 'mode-auto' : 'mode-manual'}${isTagEnabled(s7State.sbes) ? ' estop-active' : ''}`} aria-label="任务进度 Mission State">
          <div className="wallboard-mission-copy">
            <div className="wallboard-card-title"><span>任务进度</span><small>Mission State</small></div>
            <div className="wallboard-card-main wallboard-mission-content"><strong><span className="wallboard-mission-state-value">{missionState.value}</span>{'\u00a0\u00a0\u00a0'}<span className="wallboard-mission-state-label">{missionState.zh}</span></strong></div>
            <div className="wallboard-card-foot wallboard-mission-foot"><em>{missionState.en}</em></div>
          </div>
          <button
            type="button"
            className={`wallboard-estop-button${isTagEnabled(s7State.sbes) ? ' active' : ''}`}
            aria-pressed={isTagEnabled(s7State.sbes)}
            aria-label={isTagEnabled(s7State.sbes) ? '急停已触发 Emergency Stop Active' : '急停正常 Emergency Stop Normal'}
          >
            <img
              src={isTagEnabled(s7State.sbes) ? '/emergency_1.png' : '/emergency_0.png'}
              alt={isTagEnabled(s7State.sbes) ? '急停已触发 Emergency Stop Active' : '急停正常 Emergency Stop Normal'}
            />
          </button>
        </section>
      </div>

      <section className="wallboard-panel wallboard-flowline-panel wallboard-digital-twin-panel">
        <div className="wallboard-digital-twin-shell">
          <DigitalTwinWallboardGraphic stationOperationLabels={stationOperationLabels} flipped={isInterfaceFlipped} />
        </div>
      </section>

      <section className={`wallboard-panel wallboard-empty-bottom-panel wallboard-send-call-mode${isTagEnabled(s7State.mode0EqSend1EqCall) ? ' call' : ' send'}`} aria-label="发送与召唤模式">
        <div className="wallboard-card-main">
          <strong>
            <span>{isTagEnabled(s7State.mode0EqSend1EqCall) ? '召唤模式' : '发送模式'}</span>
            <small>{isTagEnabled(s7State.mode0EqSend1EqCall) ? 'Call Mode' : 'Send Mode'}</small>
          </strong>
        </div>
        <StationSelectGraphic compact showModeActions selectionTone={isTagEnabled(s7State.mode0EqSend1EqCall) ? 'call' : 'send'} flipped={isInterfaceFlipped} />
      </section>
    </section>
  )
}
