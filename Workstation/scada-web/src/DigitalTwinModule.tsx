import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import './DigitalTwinModule.css'
import { S7_API, postS7Command, readTwinLayoutState, saveTwinLayoutState, type TwinLayoutState } from './s7Api'

type DirectionState = { forward: boolean; reverse: boolean }
type FlowMotionType = 'forward' | 'reverse' | 'move'
type ChannelLayout = {
  centerX: number
  centerY: number
  length: number
  gauge: number
  railHeight: number
  railInnerGap: number
}
type VehicleLayout = {
  relativeX: number
  yOffset: number
  width: number
  height: number
  color: string
  revolving: boolean
  moving: boolean
  movingDirection: 'left' | 'right'
}
type StationLayout = DirectionState & {
  opCode: string
  lane: 'top' | 'bottom'
  relativeX: number
  occupied: boolean
}
type TwinLayout = {
  canvas: { viewBox: string; width: number; height: number; originY: number; background: string }
  channel: ChannelLayout
  station: { width: number; height: number; topY: number; bottomY: number }
  car: VehicleLayout
  stations: Record<string, StationLayout>
}

type StationOperationLabels = Record<string, string>
const DEFAULT_MAX_POS = 20
const MAX_POS_LIMIT = 48
// 相对 X 的坐标域上限：所有工位与 RGV 的偏移量均为 0 至 950 的整数（UInt）。
const RELATIVE_X_MAX = 950

function clampRelativeX(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(RELATIVE_X_MAX, Math.round(value)))
}

function buildWallboardTwinLayout(layout: TwinLayout) {
  const responsiveCanvasWidth = Math.max(layout.canvas.width, layout.channel.length + 220)
  return {
    ...layout,
    channel: {
      ...layout.channel,
      centerY: layout.channel.centerY + 28,
      centerX: responsiveCanvasWidth / 2,
    },
    station: {
      ...layout.station,
      topY: layout.station.topY + 28,
      bottomY: layout.station.bottomY + 28,
    },
    canvas: {
      ...layout.canvas,
      background: 'transparent',
      width: responsiveCanvasWidth,
      viewBox: `0 ${layout.canvas.originY} ${responsiveCanvasWidth} ${layout.canvas.height}`,
    },
  }
}

function fitStationSelectionLayout(layout: TwinLayout): TwinLayout {
  const laneEntries = Object.entries(layout.stations).reduce<Record<string, Array<[string, StationLayout]>>>((groups, entry) => {
    const lane = entry[1].lane
    ;(groups[lane] ??= []).push(entry)
    return groups
  }, {})
  const minimumGap = 12
  const minimumWidth = 8
  const maximumWidth = 100
  const positionScale = layout.channel.length / RELATIVE_X_MAX
  const shortestCenterDistance = Object.values(laneEntries).reduce((shortest, entries) => {
    const ordered = [...entries].sort(([, left], [, right]) => left.relativeX - right.relativeX)
    for (let index = 1; index < ordered.length; index += 1) {
      const distance = (ordered[index][1].relativeX - ordered[index - 1][1].relativeX) * positionScale
      if (distance > 0) shortest = Math.min(shortest, distance)
    }
    return shortest
  }, Number.POSITIVE_INFINITY)
  const availableWidth = Number.isFinite(shortestCenterDistance) ? shortestCenterDistance - minimumGap : maximumWidth
  const stationWidth = Math.max(minimumWidth, Math.min(maximumWidth, Math.floor(availableWidth)))
  const stationHeight = 120
  const verticalMargin = 20
  const wallboardVerticalOffset = 28
  return {
    ...layout,
    station: {
      ...layout.station,
      width: stationWidth,
      height: stationHeight,
      topY: verticalMargin - wallboardVerticalOffset,
      bottomY: layout.canvas.height - verticalMargin - stationHeight - wallboardVerticalOffset,
    },
  }
}

function defaultOpRows(maxPos: number, existing: Record<string, boolean> = {}) {
  const topCount = Math.ceil(maxPos / 2)
  return Object.fromEntries(Array.from({ length: maxPos }, (_, offset) => {
    const op = offset + 1
    return [String(op), existing[String(op)] ?? op <= topCount]
  }))
}

function buildStations(maxPos = DEFAULT_MAX_POS, opRows: Record<string, boolean> = {}) {
  const stations: Record<string, StationLayout> = {}
  const normalizedMaxPos = Math.max(1, Math.min(MAX_POS_LIMIT, Math.round(maxPos)))
  const rows = defaultOpRows(normalizedMaxPos, opRows)
  const topOps = Array.from({ length: normalizedMaxPos }, (_, offset) => offset + 1).filter((op) => rows[String(op)])
  const bottomOps = Array.from({ length: normalizedMaxPos }, (_, offset) => offset + 1).filter((op) => !rows[String(op)])
  const positionFor = (index: number, count: number) => count <= 1 ? Math.round(RELATIVE_X_MAX / 2) : Math.round((RELATIVE_X_MAX * index) / (count - 1))

  for (const [index, op] of topOps.entries()) {
    stations[`top${String(op).padStart(2, '0')}`] = {
      opCode: `OP${op}`,
      lane: 'top',
      relativeX: positionFor(index, topOps.length),
      forward: false,
      reverse: false,
      occupied: false,
    }
  }

  for (const [index, op] of bottomOps.entries()) {
    stations[`bottom${String(op).padStart(2, '0')}`] = {
      opCode: `OP${op}`,
      lane: 'bottom',
      relativeX: positionFor(index, bottomOps.length),
      forward: false,
      reverse: false,
      occupied: false,
    }
  }

  return stations
}

const initialTwinLayout: TwinLayout = {
  canvas: {
    viewBox: '0 0 2048 340',
    width: 2048,
    height: 340,
    originY: 0,
    background: '#0b1220',
  },
  channel: {
    centerX: 1017,
    centerY: 147,
    length: 1930,
    gauge: 100,
    railHeight: 18,
    railInnerGap: 12,
  },
  station: {
    width: 64,
    height: 96,
    topY: 3,
    bottomY: 194,
  },
  car: {
    relativeX: 870,
    yOffset: -30,
    width: 92,
    height: 58,
    color: '#27313d',
    revolving: false,
    moving: false,
    movingDirection: 'right',
  },
  stations: buildStations(),
}

function applyTwinLayoutState(layout: TwinLayout, stored?: TwinLayoutState | null): TwinLayout {
  const stationRelativeX = stored?.stationRelativeX ?? {}
  return {
    ...layout,
    car: {
      ...layout.car,
      relativeX: clampRelativeX(stored?.carRelativeX ?? layout.car.relativeX),
    },
    stations: Object.fromEntries(Object.entries(layout.stations).map(([id, station]) => {
      const relativeX = stationRelativeX[station.opCode]
      return [id, {
        ...station,
        relativeX: clampRelativeX(relativeX ?? station.relativeX),
      }]
    })),
  }
}

function toTwinLayoutState(layout: TwinLayout): TwinLayoutState {
  return {
    schemaVersion: 1,
    carRelativeX: clampRelativeX(layout.car.relativeX),
    stationRelativeX: Object.fromEntries(Object.values(layout.stations).map((station) => [station.opCode, clampRelativeX(station.relativeX)])),
  }
}

function useSharedTwinLayout() {
  const [layout, setLayout] = useState<TwinLayout>(initialTwinLayout)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const stored = await readTwinLayoutState()
        if (!active) return
        setLayout(applyTwinLayoutState(initialTwinLayout, stored))
      } catch {
        if (active) setLayout(initialTwinLayout)
      } finally {
        if (active) setHydrated(true)
      }
    })()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!hydrated) return
    void saveTwinLayoutState(toTwinLayoutState(layout)).catch(() => undefined)
  }, [layout, hydrated])

  return [layout, setLayout] as const
}

function toNumber(value: string, current: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : current
}

type TwinSystemConfiguration = { stationNumber: number; maxPos: number; isInterfaceFlipped: boolean; opRows?: Record<string, boolean> }

function useTwinSystemConfiguration() {
  const [configuration, setConfiguration] = useState<TwinSystemConfiguration>({ stationNumber: 1, maxPos: DEFAULT_MAX_POS, isInterfaceFlipped: false, opRows: {} })

  useEffect(() => {
    let active = true
    const readConfiguration = async () => {
      try {
        const response = await fetch(`${S7_API}/api/system/configuration`)
        if (!response.ok) return
        const value = await response.json() as TwinSystemConfiguration
        if (active) setConfiguration({ stationNumber: Math.max(1, Math.round(value.stationNumber || 1)), maxPos: Math.max(1, Math.min(MAX_POS_LIMIT, Math.round(value.maxPos || DEFAULT_MAX_POS))), isInterfaceFlipped: value.isInterfaceFlipped === true, opRows: value.opRows ?? {} })
      } catch {
        // Keep the last known layout configuration when the service is unavailable.
      }
    }
    void readConfiguration()
    const timer = window.setInterval(() => void readConfiguration(), 2000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  return configuration
}

type TwinLiveState = {
  shuttlePosition: number | null
  shuttleState: number | null
  stationStates: Record<number, number>
  stationPositions: Map<number, number>
  stationOccupied: Record<number, boolean>
  hmiPosSel: Record<number, { name: string; value: boolean; address: string }>
  enableShowSend: Record<number, boolean>
  enableShowCall: Record<number, boolean>
  mode0EqSend1EqCall: boolean
  insure: { value: boolean; address: string } | null
  enable4Send: { value: boolean; address: string } | null
  enable4Call: { value: boolean; address: string } | null
  orderExist: boolean
}

function useTwinLiveS7(stationNumber = 1) {
  const [live, setLive] = useState<TwinLiveState>({ shuttlePosition: null, shuttleState: null, stationStates: {}, stationPositions: new Map(), stationOccupied: {}, hmiPosSel: {}, enableShowSend: {}, enableShowCall: {}, mode0EqSend1EqCall: false, insure: null, enable4Send: null, enable4Call: null, orderExist: false })

  useEffect(() => {
    let active = true
    let requestInFlight = false
    const readLive = async () => {
      if (!active || requestInFlight) return
      requestInFlight = true
      try {
        const response = await fetch(`${S7_API}/api/s7/tags`)
        if (!response.ok) return
        const tags = await response.json() as Array<{ name: string; value: string; address: string }>
        if (!active) return
        const stationStates: Record<number, number> = {}
        const stationPositions = new Map<number, number>()
        const stationOccupied: Record<number, boolean> = {}
        const hmiPosSel: TwinLiveState['hmiPosSel'] = {}
        const enableShowSend: TwinLiveState['enableShowSend'] = {}
        const enableShowCall: TwinLiveState['enableShowCall'] = {}
        let mode0EqSend1EqCall = false
        let insure: TwinLiveState['insure'] = null
        let enable4Send: TwinLiveState['enable4Send'] = null
        let enable4Call: TwinLiveState['enable4Call'] = null
        let orderExist = false
        let shuttlePosition: number | null = null
        let shuttleState: number | null = null
        for (const tag of tags) {
          const hmiMatch = tag.name.match(/^HMIPosSel\[(\d+),(\d+)\]$/)
          if (hmiMatch && Number(hmiMatch[1]) === stationNumber && Number(hmiMatch[2]) >= 1) {
            const index = Number(hmiMatch[2])
            hmiPosSel[index] = { name: tag.name, value: tag.value.trim().toLowerCase() === 'true', address: tag.address }
            continue
          }
          const visibilityMatch = tag.name.match(/^EnableShow(Send|Call)\[(\d+),(\d+)\]$/)
          if (visibilityMatch && Number(visibilityMatch[2]) === stationNumber && Number(visibilityMatch[3]) >= 1) {
            const index = Number(visibilityMatch[3])
            const value = tag.value.trim().toLowerCase() === 'true'
            if (visibilityMatch[1] === 'Send') enableShowSend[index] = value
            else enableShowCall[index] = value
            continue
          }
          if (tag.name === 'Mode0EQSend1EQCall') {
            mode0EqSend1EqCall = tag.value.trim().toLowerCase() === 'true'
            continue
          }
          if (tag.name === 'Insure') {
            insure = { value: tag.value.trim().toLowerCase() === 'true', address: tag.address }
            continue
          }
          if (tag.name === 'Enable4Send') {
            enable4Send = { value: tag.value.trim().toLowerCase() === 'true', address: tag.address }
            continue
          }
          if (tag.name === 'Enable4Call') {
            enable4Call = { value: tag.value.trim().toLowerCase() === 'true', address: tag.address }
            continue
          }
          if (tag.name === 'OrderExist') {
            orderExist = tag.value.trim().toLowerCase() === 'true'
            continue
          }
          if (tag.name.startsWith('PH[') && tag.name.endsWith(']')) {
            const index = Number(tag.name.slice(3, -1))
            if (Number.isInteger(index) && index >= 1) stationOccupied[index] = tag.value.trim().toLowerCase() === 'true'
            continue
          }
          const parsed = Number(tag.value)
          if (!Number.isFinite(parsed)) continue
          if (tag.name === 'ShuttleState.Position') shuttlePosition = parsed
          else if (tag.name === 'ShuttleState.State') shuttleState = parsed
          else if (tag.name.startsWith('StationState[') && tag.name.endsWith('.State')) {
            const start = tag.name.indexOf('[')
            const end = tag.name.indexOf(']', start)
            const index = Number(tag.name.slice(start + 1, end))
            if (Number.isInteger(index) && index >= 1) stationStates[index] = parsed
          } else if (tag.name.startsWith('StationState[') && tag.name.endsWith('.Position')) {
            const start = tag.name.indexOf('[')
            const end = tag.name.indexOf(']', start)
            const index = Number(tag.name.slice(start + 1, end))
            if (Number.isInteger(index) && index >= 1) stationPositions.set(index, parsed)
          }
        }
        setLive({ shuttlePosition, shuttleState, stationStates, stationPositions, stationOccupied, hmiPosSel, enableShowSend, enableShowCall, mode0EqSend1EqCall, insure, enable4Send, enable4Call, orderExist })
      } catch {
        // Keep the last known live state when S7 is temporarily unavailable.
      } finally {
        requestInFlight = false
      }
    }
    void readLive()
    const timer = window.setInterval(() => void readLive(), 50)
    return () => { active = false; window.clearInterval(timer) }
  }, [stationNumber])

  return live
}

function useSmoothedNumber(target: number | null, fallback: number, durationMs = 180) {
  const [value, setValue] = useState(target ?? fallback)
  const currentRef = useRef(target ?? fallback)
  const frameRef = useRef<number | null>(null)
  useEffect(() => {
    if (target === null || !Number.isFinite(target)) return
    const from = currentRef.current
    const to = target
    if (Math.abs(to - from) < 0.01) { currentRef.current = to; setValue(to); return }
    const startedAt = performance.now()
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    const animate = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / durationMs)
      const eased = progress * (2 - progress)
      const next = from + (to - from) * eased
      currentRef.current = next
      setValue(next)
      if (progress < 1) frameRef.current = requestAnimationFrame(animate)
      else frameRef.current = null
    }
    frameRef.current = requestAnimationFrame(animate)
    return () => { if (frameRef.current !== null) cancelAnimationFrame(frameRef.current) }
  }, [target, durationMs])
  return value
}

function applyLiveStationStates(layout: TwinLayout, live: TwinLiveState, maxPos: number): TwinLayout {
  return {
    ...layout,
    stations: Object.fromEntries(Object.entries(layout.stations).map(([id, station]) => {
      const index = Number(station.opCode.replace('OP', ''))
      if (!Number.isInteger(index) || index < 1 || index > maxPos) return [id, station]
      const state = live.stationStates[index]
      const position = live.stationPositions.get(index)
      return [id, {
        ...station,
        forward: state === 3,
        reverse: state === 7,
        occupied: live.stationOccupied[index] === true,
        relativeX: position !== undefined ? clampRelativeX(position) : station.relativeX,
      }]
    })),
  }
}

export function DigitalTwinModule({ stationOperationLabels = {} }: { stationOperationLabels?: StationOperationLabels }) {
  const [layout] = useSharedTwinLayout()
  const systemConfiguration = useTwinSystemConfiguration()
  const maxPos = systemConfiguration.maxPos
  const live = useTwinLiveS7(systemConfiguration.stationNumber)

  const activeLayout = useMemo(() => {
    const previousByOp = Object.fromEntries(Object.values(layout.stations).map((station) => [station.opCode, station]))
    return {
      ...layout,
      stations: Object.fromEntries(Object.entries(buildStations(maxPos, systemConfiguration.opRows)).map(([id, station]) => {
        const previous = previousByOp[station.opCode]
        return [id, {
          ...station,
          ...previous,
          opCode: station.opCode,
          lane: station.lane,
          relativeX: previous?.relativeX ?? station.relativeX,
          forward: false,
          reverse: false,
          occupied: false,
        }]
      })),
    }
  }, [layout, maxPos, systemConfiguration.opRows])
  const liveLayout = useMemo(() => applyLiveStationStates(activeLayout, live, maxPos), [activeLayout, live, maxPos])

  const carStateReady = live.shuttleState !== null && live.shuttlePosition !== null
  const shuttleRevolving = live.shuttleState === 3 || live.shuttleState === 7
  const shuttleMoving = live.shuttleState === 2 || live.shuttleState === 5
  const shuttleMovingDirection = live.shuttleState === 2 ? 'right' : 'left'
  // RGV 坐标与小车实时位置绑定：S7 数据可用时优先显示实时位置。
  const carTargetX = carStateReady ? clampRelativeX(toNumber(String(live.shuttlePosition), 0)) : null
  const carRelativeX = useSmoothedNumber(carTargetX, 0)
  const centeredLayout = useMemo(() => buildWallboardTwinLayout({
    ...liveLayout,
    car: { ...liveLayout.car, relativeX: carRelativeX, revolving: shuttleRevolving, moving: shuttleMoving, movingDirection: shuttleMovingDirection },
  }), [liveLayout, carRelativeX, shuttleRevolving, shuttleMoving, shuttleMovingDirection])
  const groupedStations = useMemo(() => ({
    top: Object.entries(centeredLayout.stations).filter(([, station]) => station.lane === 'top'),
    bottom: Object.entries(centeredLayout.stations).filter(([, station]) => station.lane === 'bottom'),
  }), [centeredLayout.stations])
  const topSubtitle = groupedStations.top.length ? `OP1 - OP${groupedStations.top.length}` : '无工位'
  const bottomSubtitle = groupedStations.bottom.length ? `OP${groupedStations.top.length + 1} - OP${maxPos}` : '无工位'

  return (
    <div className="digital-twin-shell">
      <section className="digital-twin-stage-card">
        <DigitalTwinGraphic layout={centeredLayout} stationOperationLabels={stationOperationLabels} flipped={systemConfiguration.isInterfaceFlipped} />
      </section>

      <section className="digital-twin-params">
        <ParamCard title="小车">
          <div className="digital-twin-car-row">
            <ReadonlyField label="坐标" value={carStateReady ? String(carRelativeX) : '—'} />
            <StatusField label="正反转" active={shuttleRevolving} />
            <StatusField label="移动" active={shuttleMoving} tone="blue" />
          </div>
        </ParamCard>

        <LanePanel title="上排工位" subtitle={topSubtitle}>
          {groupedStations.top.map(([id, station]) => (
            <StationRow key={id} code={station.opCode} state={live.stationStates[Number(station.opCode.replace('OP', ''))]} x={station.relativeX} occupied={station.occupied} />
          ))}
        </LanePanel>

        <LanePanel title="下排工位" subtitle={bottomSubtitle}>
          {groupedStations.bottom.map(([id, station]) => (
            <StationRow key={id} code={station.opCode} state={live.stationStates[Number(station.opCode.replace('OP', ''))]} x={station.relativeX} occupied={station.occupied} />
          ))}
        </LanePanel>
      </section>
    </div>
  )
}

export function DigitalTwinWallboardGraphic({ stationOperationLabels = {}, flipped }: { stationOperationLabels?: StationOperationLabels; flipped?: boolean }) {
  const [layout] = useSharedTwinLayout()
  const systemConfiguration = useTwinSystemConfiguration()
  const maxPos = systemConfiguration.maxPos
  const live = useTwinLiveS7(systemConfiguration.stationNumber)
  const activeLayout = useMemo(() => {
    const previousByOp = Object.fromEntries(Object.values(layout.stations).map((station) => [station.opCode, station]))
    return {
      ...layout,
      stations: Object.fromEntries(Object.entries(buildStations(maxPos, systemConfiguration.opRows)).map(([id, station]) => {
        const previous = previousByOp[station.opCode]
        return [id, {
          ...station,
          ...previous,
          opCode: station.opCode,
          lane: station.lane,
          relativeX: previous?.relativeX ?? station.relativeX,
          forward: false,
          reverse: false,
          occupied: false,
        }]
      })),
    }
  }, [layout, maxPos, systemConfiguration.opRows])
  const liveLayout = useMemo(() => applyLiveStationStates(activeLayout, live, maxPos), [activeLayout, live, maxPos])

  const shuttleRevolving = live.shuttleState === 3 || live.shuttleState === 7
  const shuttleMoving = live.shuttleState === 2 || live.shuttleState === 5
  const carStateReady = live.shuttleState !== null && live.shuttlePosition !== null
  const carTargetX = carStateReady ? clampRelativeX(toNumber(String(live.shuttlePosition), 0)) : null
  const carRelativeX = useSmoothedNumber(carTargetX, 0)

  return <DigitalTwinGraphic layout={buildWallboardTwinLayout({ ...liveLayout, car: { ...liveLayout.car, relativeX: carRelativeX, revolving: shuttleRevolving, moving: shuttleMoving, movingDirection: live.shuttleState === 2 ? 'right' : 'left' } })} embedded stationOperationLabels={stationOperationLabels} flipped={flipped ?? systemConfiguration.isInterfaceFlipped} />
}

export function StationSelectGraphic({ stationOperationLabels = {}, compact = false, selectionTone, showModeActions = false, flipped }: { stationOperationLabels?: StationOperationLabels; compact?: boolean; selectionTone?: 'send' | 'call'; showModeActions?: boolean; flipped?: boolean }) {
  const [layout] = useSharedTwinLayout()
  const systemConfiguration = useTwinSystemConfiguration()
  const maxPos = systemConfiguration.maxPos
  const live = useTwinLiveS7(systemConfiguration.stationNumber)
  const holdTimer = useRef<number | null>(null)
  const [holdingAction, setHoldingAction] = useState<string | null>(null)
  const [commandIssued, setCommandIssued] = useState(false)
  const hmiSelections = useMemo(() => Object.fromEntries(Object.entries(live.hmiPosSel).map(([index, tag]) => [Number(index), tag.value])), [live.hmiPosSel])
  const insureActive = live.insure?.value === true || (commandIssued && live.insure?.value !== false)
  async function selectStation(opCode: string) {
    const index = Number(opCode.slice(2))
    const tag = live.hmiPosSel[index]
    if (!tag) return
    try {
      await postS7Command('station-select', { stationIndex: index, active: true })
    } catch {
      // The polling loop will restore the displayed state if the write fails.
    }
  }
  const activeLayout = useMemo(() => {
    const previousByOp = Object.fromEntries(Object.values(layout.stations).map((station) => [station.opCode, station]))
    return {
      ...layout,
      stations: Object.fromEntries(Object.entries(buildStations(maxPos, systemConfiguration.opRows)).map(([id, station]) => {
        const previous = previousByOp[station.opCode]
        return [id, {
          ...station,
          ...previous,
          opCode: station.opCode,
          lane: station.lane,
          relativeX: previous?.relativeX ?? station.relativeX,
          forward: false,
          reverse: false,
          occupied: false,
        }]
      })),
    }
  }, [layout, maxPos, systemConfiguration.opRows])

  const liveLayout = useMemo(() => applyLiveStationStates(activeLayout, live, maxPos), [activeLayout, live, maxPos])
  const carStateReady = live.shuttleState !== null && live.shuttlePosition !== null
  const shuttleRevolving = live.shuttleState === 3 || live.shuttleState === 7
  const shuttleMoving = live.shuttleState === 2 || live.shuttleState === 5
  const centeredLayout = useMemo(() => buildWallboardTwinLayout({
    ...fitStationSelectionLayout(liveLayout),
    car: {
      ...liveLayout.car,
      relativeX: carStateReady ? clampRelativeX(live.shuttlePosition ?? 0) : 0,
      revolving: shuttleRevolving,
      moving: shuttleMoving,
      movingDirection: live.shuttleState === 2 ? 'right' : 'left',
    },
  }), [liveLayout, carStateReady, live.shuttlePosition, live.shuttleState, shuttleRevolving, shuttleMoving])
  const activeSelectionTone = selectionTone ?? (live.mode0EqSend1EqCall ? 'call' : 'send')
  const stationVisibility = activeSelectionTone === 'send' ? live.enableShowSend : live.enableShowCall
  async function insureStation() {
    if (!live.insure) return
    try {
      await postS7Command('insure', { active: true })
      setCommandIssued(true)
    } catch {
      // The polling loop will restore the current value when the service is available.
    }
  }
  function cancelActionHold() {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
    setHoldingAction(null)
  }
  function beginActionHold(action: string) {
    cancelActionHold()
    setHoldingAction(action)
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null
      setHoldingAction(null)
      void insureStation()
    }, 1000)
  }
  useEffect(() => () => cancelActionHold(), [])
  const modeActions = showModeActions ? (
    <div className="station-select-mode-actions" aria-label="工位操作">
      {live.enable4Send?.value ? <button type="button" className={`station-select-mode-action send${holdingAction === 'send' ? ' holding' : ''}${insureActive ? ' issued' : ''}`} aria-label="发送指令下达" onPointerDown={() => beginActionHold('send')} onPointerUp={cancelActionHold} onPointerLeave={cancelActionHold} onPointerCancel={cancelActionHold} onContextMenu={(event) => event.preventDefault()}>发送指令下达{live.orderExist ? <img className="station-select-order-exist-icon" src="/stateok.png" alt="有订单 Order exists" /> : null}</button> : null}
      {live.enable4Call?.value ? <button type="button" className={`station-select-mode-action call${holdingAction === 'call' ? ' holding' : ''}${insureActive ? ' issued' : ''}`} aria-label="召唤指令下达" onPointerDown={() => beginActionHold('call')} onPointerUp={cancelActionHold} onPointerLeave={cancelActionHold} onPointerCancel={cancelActionHold} onContextMenu={(event) => event.preventDefault()}>召唤指令下达{live.orderExist ? <img className="station-select-order-exist-icon" src="/stateok.png" alt="有订单 Order exists" /> : null}</button> : null}
    </div>
  ) : null

  if (compact) {
    return <div className={`station-select-wallboard-graphic station-select-${activeSelectionTone}`}>{modeActions}<DigitalTwinGraphic layout={centeredLayout} stationOperationLabels={stationOperationLabels} flipped={flipped ?? systemConfiguration.isInterfaceFlipped} selectable onSelectStation={selectStation} stationSelection={hmiSelections} stationVisibility={stationVisibility} showConveyor={false} showCar={false} showStationStatus={false} /></div>
  }

  return (
    <div className={`station-select-screen station-select-${activeSelectionTone}`}>
      <header className="station-select-header">
        <div><span>工位选择</span><h1>选择目标工位</h1></div>
      </header>
      <section className="digital-twin-stage-card station-select-stage">
        <DigitalTwinGraphic layout={centeredLayout} stationOperationLabels={stationOperationLabels} flipped={flipped ?? systemConfiguration.isInterfaceFlipped} selectable onSelectStation={selectStation} stationSelection={hmiSelections} stationVisibility={stationVisibility} showConveyor={false} showCar={false} showStationStatus={false} />
      </section>
      <section className="station-select-lower station-select-variable-lower">
        <section className="station-select-variable-panel">
          <div className="station-select-variable-head"><div><span>图形变量</span><h2>HMIPosSel[x,1]</h2></div><b>{Object.keys(live.hmiPosSel).length} 个变量</b></div>
          <div className="station-select-variable-grid">
            {Object.entries(live.hmiPosSel).sort(([left], [right]) => Number(left) - Number(right)).map(([index, tag]) => <div className="station-select-variable-row" key={tag.name}><strong>OP{index}</strong><code>{tag.name}</code><span className={`station-select-bool-indicator${tag.value ? ' active' : ''}`}><i aria-hidden="true" />{tag.value ? 'True' : 'False'}</span></div>)}
          </div>
        </section>
      </section>
    </div>
  )
}

function DigitalTwinGraphic({ layout, embedded = false, flipped = false, stationOperationLabels = {}, selectable = false, onSelectStation, stationSelection, stationVisibility, stretchToContainer = false, showConveyor = true, showCar = true, showStationStatus = true }: { layout: TwinLayout; embedded?: boolean; flipped?: boolean; stationOperationLabels?: StationOperationLabels; selectable?: boolean; onSelectStation?: (opCode: string) => void; stationSelection?: Record<number, boolean>; stationVisibility?: Record<number, boolean>; stretchToContainer?: boolean; showConveyor?: boolean; showCar?: boolean; showStationStatus?: boolean }) {
  return (
    <div className={`digital-twin-viewer${embedded ? ' embedded' : ''}`}>
      <svg
        className={`digital-twin-svg no-zoom${embedded ? ' embedded' : ''}`}
        viewBox={layout.canvas.viewBox}
        preserveAspectRatio={stretchToContainer ? 'none' : 'xMidYMid meet'}
        role="img"
        aria-label="数字孪生产线布局"
      >
        <defs>
          <linearGradient id="digital-twin-occupied-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#f7df8a" />
            <stop offset="52%" stopColor="#edc35b" />
            <stop offset="100%" stopColor="#d8a63a" />
          </linearGradient>
          <linearGradient id="digital-twin-send-selection-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#f8e9b5" />
            <stop offset="52%" stopColor="#ead181" />
            <stop offset="100%" stopColor="#d5b866" />
          </linearGradient>
          <linearGradient id="digital-twin-call-selection-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#c6ead2" />
            <stop offset="52%" stopColor="#8bd0a4" />
            <stop offset="100%" stopColor="#62b985" />
          </linearGradient>
        </defs>
        <g transform={flipped ? `rotate(180 ${layout.canvas.width / 2} ${layout.canvas.height / 2})` : undefined}>
          <TwinCadLayout layout={layout} flipped={flipped} stationOperationLabels={stationOperationLabels} selectable={selectable} onSelectStation={onSelectStation} stationSelection={stationSelection} stationVisibility={stationVisibility} showConveyor={showConveyor} showCar={showCar} showStationStatus={showStationStatus} />
        </g>
      </svg>
    </div>
  )
}

function ParamCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="digital-twin-param-card">
      <div className="digital-twin-param-head">
        <h3>{title}</h3>
      </div>
      <div className="digital-twin-param-grid">{children}</div>
    </article>
  )
}

function LanePanel({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <section className="digital-twin-lane-panel">
      <div className="digital-twin-param-head">
        <h3>{title}</h3>
        <span>{subtitle}</span>
      </div>
      <div className="digital-twin-station-list">{children}</div>
    </section>
  )
}

function StationRow({ code, state, x, occupied }: { code: string; state?: number; x: number; occupied: boolean }) {
  const motion = state === 3 ? '正转' : state === 7 ? '反转' : '停止'
  return (
    <div className="digital-twin-station-row digital-twin-readonly-row">
      <strong>{code}</strong>
      <ReadonlyField label="坐标" value={String(x)} />
      <ReadonlyValue label="" value={motion} tone={state === 3 ? 'forward' : state === 7 ? 'reverse' : undefined} />
      <ReadonlyValue label="占用" value={occupied ? '✓' : '—'} tone={occupied ? 'occupied' : undefined} />
    </div>
  )
}

function StatusField({ label, active, tone = 'green' }: { label: string; active: boolean; tone?: 'green' | 'blue' }) {
  return (
    <span className={`digital-twin-status-field ${tone}${active ? ' active' : ''}`} aria-label={label}>
      <i />
      <em>{label}</em>
    </span>
  )
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return <span className="digital-twin-readonly-field"><small>{label}</small><strong>{value}</strong></span>
}

function ReadonlyValue({ label, value, tone }: { label: string; value: string; tone?: 'forward' | 'reverse' | 'occupied' }) {
  return <span className={`digital-twin-readonly-value${tone ? ` ${tone}` : ''}`}>{label ? <small>{label}</small> : null}<strong>{value}</strong></span>
}

function TwinCadLayout({ layout, flipped = false, stationOperationLabels = {}, selectable = false, onSelectStation, stationSelection, stationVisibility, showConveyor = true, showCar = true, showStationStatus = true }: { layout: TwinLayout; flipped?: boolean; stationOperationLabels?: StationOperationLabels; selectable?: boolean; onSelectStation?: (opCode: string) => void; stationSelection?: Record<number, boolean>; stationVisibility?: Record<number, boolean>; showConveyor?: boolean; showCar?: boolean; showStationStatus?: boolean }) {
  return (
    <g>
      {showConveyor ? <TwinFlatConveyor layout={layout} /> : null}
      {Object.entries(layout.stations).map(([id, station]) => (
        stationVisibility && Object.keys(stationVisibility).length > 0 && stationVisibility[Number(station.opCode.slice(2))] !== true ? null : <TwinStation
          key={id}
          layout={layout}
          label={`${station.opCode} ${stationOperationLabels[station.opCode] ?? ''}`.trim()}
          relativeX={station.relativeX}
          lane={station.lane}
          forward={station.forward}
          reverse={station.reverse}
          occupied={station.occupied}
          enabled={stationSelection?.[Number(station.opCode.slice(2))] ?? true}
          showStatus={showStationStatus}
          flipped={flipped}
          selectable={selectable}
          selected={stationSelection?.[Number(station.opCode.slice(2))] === true}
          onSelect={() => onSelectStation?.(station.opCode)}
        />
      ))}
      {showCar ? <TwinCar layout={layout} flipped={flipped} /> : null}
    </g>
  )
}

function TwinFlatConveyor({ layout }: { layout: TwinLayout }) {
  const startX = layout.channel.centerX - layout.channel.length / 2
  const positionScale = layout.channel.length / RELATIVE_X_MAX
  const y = layout.channel.centerY + layout.car.yOffset + layout.car.height / 2
  // 轨道左右边界对齐最左侧与最右侧工位的侧边。
  const stationCenters = Object.values(layout.stations).map((station) => startX + station.relativeX * positionScale)
  const railLeft = (stationCenters.length ? Math.min(...stationCenters) : startX + layout.channel.length / 2) - layout.station.width / 2
  const railRight = (stationCenters.length ? Math.max(...stationCenters) : startX + layout.channel.length / 2) + layout.station.width / 2
  return (
    <g className="digital-twin-flat-conveyor">
      <rect x={railLeft} y={y - 21} width={railRight - railLeft} height="42" />
      <path d={`M${railLeft + 18} ${y - 9} H${railRight - 18}`} />
      <path d={`M${railLeft + 18} ${y + 9} H${railRight - 18}`} />
    </g>
  )
}

function TwinCar({ layout, flipped = false }: { layout: TwinLayout; flipped?: boolean }) {
  const startX = layout.channel.centerX - layout.channel.length / 2
  const positionScale = layout.channel.length / RELATIVE_X_MAX
  const x = startX + layout.car.relativeX * positionScale - layout.car.width / 2
  const y = layout.channel.centerY + layout.car.yOffset
  const isRunning = layout.car.revolving || layout.car.moving
  const statusWidth = layout.station.width
  const statusX = x + (layout.car.width - statusWidth) / 2
  const labelX = x + layout.car.width / 2
  const labelY = flipped ? y + layout.car.height - 38 : y + 38
  return (
    <g className="digital-twin-rgv">
      <rect className="digital-twin-rgv-frame" x={x - 5} y={y - 5} width={layout.car.width + 10} height={layout.car.height + 10} fill={layout.car.color} stroke="#07111d" strokeWidth="3" />
      <rect className="digital-twin-rgv-status-surface" x={statusX} y={y} width={statusWidth} height={layout.car.height} fill={isRunning ? "#ffffff" : layout.car.color} />
      {isRunning
        ? <RgvFlowIndicator x={x} y={y} width={layout.car.width} height={layout.car.height} revolving={layout.car.revolving} moving={layout.car.moving} />
        : <text
          x={labelX}
          y={labelY}
          transform={flipped ? `rotate(180 ${labelX} ${labelY})` : undefined}
        >RGV</text>}
    </g>
  )
}

function RgvFlowIndicator({ x, y, width, height, revolving, moving }: { x: number; y: number; width: number; height: number; revolving: boolean; moving: boolean }) {
  const centerX = x + width / 2
  const centerY = y + height / 2
  const halfHeight = height / 2
  const arrowHeight = Math.min(30, halfHeight)
  const arrowY = centerY - arrowHeight / 2
  const halfWidth = width / 2 - 6

  if (moving) {
    return (
      <g aria-label="RGV 双向移动中">
        <FlowingDirectionalArrows x={centerX} y={arrowY} direction="left" type="move" span={halfWidth} />
        <FlowingDirectionalArrows x={centerX} y={arrowY} direction="right" type="move" span={halfWidth} />
      </g>
    )
  }
  if (revolving) {
    return (
      <g aria-label="RGV 正反转运行中">
        <FlowingDirectionalArrows x={centerX} y={centerY - halfHeight} direction="up" type="reverse" height={halfHeight} />
        <FlowingDirectionalArrows x={centerX} y={centerY} direction="down" type="forward" height={halfHeight} />
      </g>
    )
  }
  return null
}

function TwinStation({
  layout,
  label,
  relativeX,
  lane,
  forward,
  reverse,
  occupied,
  selectable,
  selected,
  onSelect,
  showStatus = true,
  enabled = true,
  flipped = false,
}: {
  layout: TwinLayout
  label: string
  relativeX: number
  lane: 'top' | 'bottom'
  forward: boolean
  reverse: boolean
  occupied: boolean
  selectable?: boolean
  selected?: boolean
  onSelect?: () => void
  showStatus?: boolean
  enabled?: boolean
  flipped?: boolean
}) {
  const startX = layout.channel.centerX - layout.channel.length / 2
  const positionScale = layout.channel.length / RELATIVE_X_MAX
  const x = startX + relativeX * positionScale - layout.station.width / 2
  const y = lane === 'top' ? layout.station.topY : layout.station.bottomY
  const forwardDirection = lane === 'top' ? 'down' : 'up'
  const reverseDirection = lane === 'top' ? 'up' : 'down'
  const labelFontSize = Math.max(16, Math.min(24, Math.round(layout.station.width * 0.3)))
  const labelTopInset = 12
  const labelBottomInset = 12
  // The parent SVG rotation already mirrors the rendered lane. Keep each
  // station's label anchored to its logical edge so it is not mirrored twice.
  const labelAtTop = lane === 'top'
  const labelY = !showStatus
    ? y + layout.station.height / 2
    : labelAtTop
      ? y + labelTopInset + labelFontSize / 2
      : y + layout.station.height - labelBottomInset - labelFontSize / 2
  const labelX = x + layout.station.width / 2
  const indicatorY = lane === 'top' ? y + 48 : y + 16
  const occupiedY = y + 2
  const occupiedHeight = layout.station.height - 4
  return (
    <g className={`digital-twin-station${selected ? ' selected' : ''}${selectable ? ' selectable' : ''}${enabled ? '' : ' disabled'}`} onClick={selectable ? onSelect : undefined} role={selectable ? 'button' : undefined} tabIndex={selectable ? 0 : undefined} onKeyDown={selectable ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.() } } : undefined}>
      <title>{label}</title>
      <rect className="digital-twin-station-frame" x={x} y={y} width={layout.station.width} height={layout.station.height} fill="#f2f4f6" stroke="#07111d" strokeWidth="3" />
      {showStatus && occupied ? <StationOccupiedBlock x={x} y={occupiedY} width={layout.station.width - 4} height={occupiedHeight} /> : null}
      <text
        x={labelX}
        y={labelY}
        dominantBaseline="central"
        transform={flipped ? `rotate(180 ${labelX} ${labelY})` : undefined}
        style={{ fontSize: `${labelFontSize}px` }}
      >{label.match(/OP\d+/)?.[0]}</text>
      {showStatus ? <StationMotionIndicator
        x={x + layout.station.width / 2}
        y={indicatorY}
        forward={forward}
        reverse={reverse}
        forwardDirection={forwardDirection}
        reverseDirection={reverseDirection}
      /> : null}
    </g>
  )
}

function StationMotionIndicator({
  x,
  y,
  forward,
  reverse,
  forwardDirection,
  reverseDirection,
}: {
  x: number
  y: number
  forward: boolean
  reverse: boolean
  forwardDirection: 'up' | 'down'
  reverseDirection: 'up' | 'down'
}) {
  if (!forward && !reverse) {
    return (
      <g className="digital-twin-station-stop" aria-label="停止">
        <rect x={x - 11} y={y + 7.5} width="8" height="25" rx="0" />
        <rect x={x + 3} y={y + 7.5} width="8" height="25" rx="0" />
      </g>
    )
  }

  const type = forward ? 'forward' : 'reverse'
  const direction = forward ? forwardDirection : reverseDirection
  return <FlowingDirectionalArrows x={x} y={y} direction={direction} type={type} height={40} />
}

function StationOccupiedBlock({ x, y, width, height }: { x: number; y: number; width: number; height: number }) {
  return (
    <g aria-label="工位占用">
      <rect className="digital-twin-station-occupied-block" x={x + 2} y={y} width={width} height={height} fill="url(#digital-twin-occupied-gradient)" />
    </g>
  )
}

function FlowingDirectionalArrows({ x, y, direction, type, height = 30, span = 30 }: { x: number; y: number; direction: 'up' | 'down' | 'left' | 'right'; type: FlowMotionType; height?: number; span?: number }) {
  const expanded = height > 30
  const horizontal = direction === 'left' || direction === 'right'
  const tipInset = expanded ? 3 : 4
  const centerY = y + height / 2
  const chevronHeight = expanded ? 12 : 8
  const chevronWidth = expanded ? 13 : 9
  const chevronGap = expanded ? 11 : 8
  const firstOffset = expanded ? (horizontal ? 8 : 18) : (horizontal ? Math.max(5, span * 0.18) : 10)
  const secondOffset = firstOffset + chevronGap

  if (horizontal) {
    const rightward = direction === 'right'
    const halfSpan = Math.max(12, span / 2)
    const tipX = rightward ? x + halfSpan : x - halfSpan
    const tailX = rightward ? x : x
    const chevronPath = (baseX: number) => {
      const pointX = rightward ? baseX + chevronWidth : baseX - chevronWidth
      return `M ${baseX} ${centerY - chevronHeight} L ${pointX} ${centerY} L ${baseX} ${centerY + chevronHeight}`
    }
    const firstX = rightward ? x + firstOffset : x - firstOffset
    const secondX = rightward ? x + Math.min(secondOffset, halfSpan - 5) : x - Math.min(secondOffset, halfSpan - 5)
    return (
      <g aria-label={type === 'forward' ? '正转运行中' : type === 'reverse' ? '反转运行中' : '移动中'}>
        <path className={`digital-twin-station-motion ${type} flow-guide`} d={`M ${tailX} ${centerY} H ${tipX}`} />
        <path className={`digital-twin-station-motion ${type} flow-chevron flow-${direction}`} d={chevronPath(firstX)} />
        <path className={`digital-twin-station-motion ${type} flow-chevron flow-${direction} secondary`} d={chevronPath(secondX)} />
      </g>
    )
  }

  const tipY = direction === 'up' ? y + tipInset : y + height - tipInset
  const tailY = direction === 'up' ? y + height - tipInset : y + tipInset
  const firstChevronY = direction === 'up' ? y + (expanded ? 33 : 22) : y + (expanded ? 7 : 8)
  const secondChevronY = direction === 'up' ? y + (expanded ? 18 : 12) : y + (expanded ? 22 : 18)
  const chevronPath = (baseY: number) => {
    const pointY = direction === 'up' ? baseY - chevronHeight : baseY + chevronHeight
    return `M ${x - chevronWidth} ${baseY} L ${x} ${pointY} L ${x + chevronWidth} ${baseY}`
  }

  return (
    <g aria-label={type === 'forward' ? '正转运行中' : type === 'reverse' ? '反转运行中' : '移动中'}>
      <path className={`digital-twin-station-motion ${type} flow-guide`} d={`M ${x} ${tailY} V ${tipY}`} />
      <path className={`digital-twin-station-motion ${type} flow-chevron flow-${direction}`} d={chevronPath(firstChevronY)} />
      <path className={`digital-twin-station-motion ${type} flow-chevron flow-${direction} secondary`} d={chevronPath(secondChevronY)} />
    </g>
  )
}
