import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, FormEvent, ReactNode } from 'react'
import './App.css'
import { DigitalTwinWallboardGraphic } from './DigitalTwinModule'

type Session = { userType: 'admin' | 'employee'; displayName: string; roleCode: string; roleName: string; employeeNo?: string }
type ModuleKey = 'process' | 'product' | 'personnel' | 'production' | 'report' | 'dashboard' | 'traceability' | 'interface' | 's7' | 'settings'
type ModuleInfo = { key: ModuleKey; label: string; description: string; tableName: string }
type Product = { id: number; name: string; barcode: string; processRoute: string }
type WorkOrderForm = { workOrderNo: string; productName: string; planQty: number; priority: number; dueDate: string }
type Employee = { id: number; employeeNo: string; name: string; department: string; roleCode: string; roleName: string; isActive: boolean }
type Role = { code: string; name: string; description?: string }
type EmployeeForm = { employeeNo: string; name: string; department: string; roleCode: string; isActive: boolean }
type EmployeeProcessPermission = { id?: number; employeeId?: number; routeId: number; routeName?: string; sequenceNo: number; operationName: string; canView: boolean; canOperate: boolean; canMaintainSop: boolean }
type ProcessRoute = { id: number; name: string; productName: string; steps: string; version: string; status: string }
type Station = { id: number; code: string; name: string; status: string; operatorName: string; outputQty: number; alarmText?: string }
type ProcessBinding = { id?: number; routeId?: number; stationCode: string; operationName: string; sequenceNo: number; isRequired: boolean }
type SopFile = { id: number; routeId?: number | null; sequenceNo?: number | null; title: string; productName: string; stationCode: string; fileType: string; filePath: string; version: string }
type SopForm = { title: string; fileType: string; filePath: string; version: string }
type WorkstationWorkOrder = { workOrderNo: string; productName: string; routeId: number; routeName: string; sequenceNo: number; operationName: string; stationCode: string }
type WorkstationQrContext = WorkstationWorkOrder & { labelCode: number }
type LabelPrintTarget = { id: number; workOrderNo: string; productName: string; planQty: number }
type ProcessRouteForm = { name: string; productName: string; steps: string }
type TowerLightStatus = 'orange' | 'green' | 'red'
const TOWER_LIGHT_PALETTE: Record<TowerLightStatus, { color: string; soft: string }> = {
  orange: { color: '#f2a429', soft: 'rgba(242, 164, 41, .38)' },
  green: { color: '#35c977', soft: 'rgba(53, 201, 119, .34)' },
  red: { color: '#d92d32', soft: 'rgba(217, 45, 50, .38)' },
}
const MES_API = import.meta.env.VITE_SERVER_API ?? ''
const S7_API = import.meta.env.VITE_S7_API ?? 'http://127.0.0.1:4003'
const SERVER_SESSION_KEY = 'mes-server-session'
const WORKSTATION_SESSION_KEY = 'mes-workstation-session'
const WORK_ORDER_UPDATED_KEY = 'mes-work-order-updated'
const FIXED_PROCESS_STEPS = [
  { sequenceNo: 98, operationName: '缓存工位', isRequired: false },
  { sequenceNo: 99, operationName: '禁用', isRequired: false },
] as const

const DEFAULT_FIRST_STEP = { sequenceNo: 1, operationName: '扫码上线', isRequired: true } as const
const MODULE_ENGLISH_TITLES: Record<string, string> = {
  process: 'PROCESS MANAGEMENT',
  product: 'PRODUCT MANAGEMENT',
  personnel: 'PERSONNEL MANAGEMENT',
  production: 'PRODUCTION MANAGEMENT',
  report: 'STATISTICS REPORTS',
  traceability: 'TRACEABILITY',
  interface: 'INTERFACE MODULE',
  s7: 'S7 COMMUNICATION',
  settings: 'SYSTEM SETTINGS',
  dashboard: 'MES DASHBOARD',
}

function isTagEnabled(value: string) {
  return value.trim().toLowerCase() === 'true' || value.trim() === '1'
}

function resolveTowerLightStatus(hlr: boolean, hlg: boolean, hlo: boolean): TowerLightStatus {
  if (hlr) return 'red'
  if (hlg) return 'green'
  if (hlo) return 'orange'
  return 'orange'
}

function buildWeeklyProduction(records: RgvRunRecord[]) {
  const today = new Date()
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(todayStart)
    date.setDate(todayStart.getDate() - index)
    return date
  })
  const quantities = new Map(days.map((date) => [date.getTime(), 0]))

  for (const row of records) {
    if (row.toPosition !== 4 || !row.endTime || row.missionStateEnd !== 0) continue
    const completedDate = new Date(row.endTime)
    if (Number.isNaN(completedDate.getTime())) continue
    const dateOnlyTime = new Date(completedDate.getFullYear(), completedDate.getMonth(), completedDate.getDate()).getTime()
    if (quantities.has(dateOnlyTime)) quantities.set(dateOnlyTime, (quantities.get(dateOnlyTime) ?? 0) + 1)
  }

  return days.map((date, index) => ({
    day: index === 0 ? '今天' : index === 1 ? '昨天' : `${date.getMonth() + 1}/${date.getDate()}`,
    quantity: quantities.get(date.getTime()) ?? 0,
  }))
}

function mergeWithFixedSteps(steps: Array<{ sequenceNo: number; operationName: string; isRequired: boolean }>) {
  const filtered = steps.filter((step) => step.sequenceNo !== 98 && step.sequenceNo !== 99)
  return [...filtered, ...FIXED_PROCESS_STEPS].sort((left, right) => left.sequenceNo - right.sequenceNo)
}

function parseRouteSteps(stepsText: string) {
  const parsed = stepsText
    .split('>')
    .map((step) => step.trim())
    .filter(Boolean)
    .map((operationName, index) => ({ sequenceNo: index + 1, operationName, isRequired: true }))
  return mergeWithFixedSteps(parsed.length > 0 ? parsed : [DEFAULT_FIRST_STEP])
}

function normalizeStationDisplayName(code: string, name: string) {
  if (/^OP([1-9]|1[0-8])$/i.test(code)) return code.toUpperCase()
  return name
}

type Overview = {
  metrics: { products: number; workOrders: number; runningTasks: number; runningPlanQty?: number; alarms: number }
  stations: Array<Record<string, unknown>>
  workOrders: Array<Record<string, unknown>>
  alarms: Array<Record<string, unknown>>
}

type WallboardDataset = {
  overview: Overview | null
  productionRecords: Array<Record<string, unknown>>
  workstationRecords: Array<Record<string, unknown>>
  traceabilityRecords: Array<Record<string, unknown>>
  rgvRuns: RgvRunRecord[]
  products: Product[]
  routes: ProcessRoute[]
  routeBindings: ProcessBinding[]
}

const api = {
  async get<T>(url: string): Promise<T> {
    const res = await fetch(`${MES_API}${url}`)
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  },
  async send<T>(url: string, body: unknown, method = 'POST'): Promise<T> {
    const res = await fetch(`${MES_API}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(await res.text())
    return res.status === 204 ? (undefined as T) : res.json()
  },
}

function DashboardSidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="2" width="5" height="3" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="7" width="5" height="7" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}
function ProductSidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 7h6M5 10h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
function ProcessSidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="4" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="4" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="12" r="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 6v2.5L6.5 10.5M12 6v2.5L9.5 10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
function ProductionSidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 12h12M4 12V6l4-3 4 3v6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="6.5" y="8" width="3" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}
function ReportSidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3" y="2" width="10" height="12" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}
function TraceabilitySidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 10l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
function InterfaceSidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="4" width="5" height="8" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9.5" y="4" width="5" height="8" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6.5 6h3M6.5 10h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}
function SettingsSidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}
function PersonnelSidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="6" cy="5" r="2.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 13c.5-2.2 1.8-3.4 3.5-3.4 1.3 0 2.3.6 3 1.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M10.5 7.5h3M10.5 10.5h3M10.5 13.5h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}
export function WorkstationSidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="12" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 14h5M8 11v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function notifyWorkOrderChanged() {
  localStorage.setItem(WORK_ORDER_UPDATED_KEY, String(Date.now()))
}
export function TwinSidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 4.5 8 2l5 2.5v7L8 14l-5-2.5v-7Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8 2v12M3 4.5l5 2.5 5-2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const moduleIcons: Record<ModuleKey, ReactNode> = {
  product: <ProductSidebarIcon />, process: <ProcessSidebarIcon />, personnel: <PersonnelSidebarIcon />, production: <ProductionSidebarIcon />,
  report: <ReportSidebarIcon />, dashboard: <DashboardSidebarIcon />, traceability: <TraceabilitySidebarIcon />,
  interface: <InterfaceSidebarIcon />, s7: <S7SidebarIcon />, settings: <SettingsSidebarIcon />,
}

function SidebarCollapseIcon({ collapsed }: { collapsed: boolean }) {
  return collapsed ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m9 18 6-6-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m15 18-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}


function BrandAnimatedTitle() {
  return <strong className="brand-title-text">制造执行系统</strong>
}
const emptyProduct = { name: '', barcode: '', processRoute: '' }
const moduleOrder: ModuleKey[] = ['process', 'product', 'personnel', 'production', 'report', 'traceability', 'interface', 's7', 'settings']
const moduleText: Record<ModuleKey, { label: string; description: string; tableName: string }> = {
  process: { label: '工艺管理', description: '维护工艺路线、工序、SOP 文件和工位绑定关系', tableName: 'MesProcessRoutes' },
  product: { label: '产品管理', description: '维护产品信息与工艺路线', tableName: 'MesProducts' },
  personnel: { label: '人员管理', description: '维护员工、角色、部门与工艺权限', tableName: 'MesEmployees' },
  production: { label: '生产管理', description: '维护工单、排产、优先级、交付日期与报工', tableName: 'MesWorkOrders' },
  report: { label: '统计报表', description: '查看产量、报警、效率与追溯统计', tableName: 'MesAlarms' },
  dashboard: { label: 'Dashboard', description: '4K 大屏看板，用于展示关键生产数据', tableName: 'MesStations' },
  traceability: { label: '追溯管理', description: '记录扫码、追溯、异常处理与设备事件', tableName: 'MesTraceEvents' },
  interface: { label: '接口模块', description: '对接 ERP、MES、MOM、SCADA 与标准 API', tableName: 'MesIntegrationEndpoints' },
  settings: { label: '系统设置', description: '维护系统参数、角色权限与基础配置', tableName: 'MesSystemSettings' },
  s7: { label: 'S7通讯', description: '查看 PLC 连接状态、运行配置与实时标签', tableName: 'S7Runtime' },
}

function normalizeModules(nav: ModuleInfo[], roleCode: string) {
  const allowed = new Set(nav.map((item) => item.key))
  if (roleCode === 'admin' || allowed.has('settings')) allowed.add('personnel')
  if (roleCode === 'admin') allowed.add('s7')
  return moduleOrder
    .filter((key) => allowed.has(key))
    .map((key) => ({ key, ...moduleText[key] }))
}

export default function App() {
  if (window.location.pathname.startsWith('/wallboard')) {
    return <WallboardApp />
  }

  const [session, setSession] = useState<Session | null>(() => {
    const raw = localStorage.getItem(SERVER_SESSION_KEY)
    return raw ? JSON.parse(raw) : null
  })
  const [modules, setModules] = useState<ModuleInfo[]>([])
  const [activeModule, setActiveModule] = useState<ModuleKey>('production')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [records, setRecords] = useState<Array<Record<string, unknown>>>([])
  const [message, setMessage] = useState('')
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => localStorage.getItem('mes-sidebar-collapsed') === '1')

  useEffect(() => {
    if (!session) return
    localStorage.setItem(SERVER_SESSION_KEY, JSON.stringify(session))
    void reloadWorkspace(session.roleCode, activeModule)
  }, [session, activeModule])

  async function validateSession(current: Session) {
    if (current.userType !== 'admin') {
      localStorage.removeItem(SERVER_SESSION_KEY)
      setSession(null)
      return false
    }
    return true
  }

  async function reloadWorkspace(roleCode = session?.roleCode ?? 'operator', moduleKey = activeModule) {
    if (session && !await validateSession(session)) return
    setMessage('')
    try {
      const [nav, nextOverview] = await Promise.all([
        api.get<ModuleInfo[]>(`/api/navigation?role=${encodeURIComponent(roleCode)}`),
        api.get<Overview>('/api/overview'),
      ])
      setModules(normalizeModules(nav, roleCode))
      setOverview(nextOverview)
      if (moduleKey === 'product') {
        setProducts(await api.get<Product[]>('/api/products'))
      } else if (moduleKey === 'personnel' || moduleKey === 's7') {
        setRecords([])
      } else {
        setRecords(await api.get<Array<Record<string, unknown>>>(`/api/modules/${moduleKey}/records`))
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '数据同步失败，请检查网络或服务状态')
    }
  }

  if (!session) return <LoginScreen adminOnly onLogin={setSession} />

  const active = modules.find((item) => item.key === activeModule)
  function toggleSidebar() {
    const next = !isSidebarCollapsed
    setIsSidebarCollapsed(next)
    localStorage.setItem('mes-sidebar-collapsed', next ? '1' : '0')
  }

  function openDashboardWindow() {
    window.open('/wallboard', '_blank', 'noopener,noreferrer')
  }

  return (
    <main className={`app-shell${isSidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <aside className={`sidebar${isSidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
        <div className="brand">
          <div className="brand-mark">
            <div className="brand-logo-row">
              <img className="brand-logo-icon" src="/sidebar-brand-logo.svg" alt="" />
            </div>
            <div className="brand-title-row">
              <BrandAnimatedTitle />
            </div>
          </div>
        </div>
        <div className="sidebar-collapse-row">
          <button type="button" className="sidebar-collapse-btn" onClick={toggleSidebar} aria-label={isSidebarCollapsed ? '展开侧边栏' : '收起侧边栏'} title={isSidebarCollapsed ? '展开' : '收起'}>
            <span className="sidebar-collapse-icon"><SidebarCollapseIcon collapsed={isSidebarCollapsed} /></span>
          </button>
        </div>
        <nav className="sidebar-nav" aria-label="MES 模块">
          {modules.map((item) => (
            <button
              className={`nav-item ${item.key !== 'dashboard' && activeModule === item.key ? 'active' : ''}`}
              key={item.key}
              onClick={() => item.key === 'dashboard' ? openDashboardWindow() : setActiveModule(item.key)}
              title={item.description}
            >
              <span className="nav-icon">{moduleIcons[item.key]}</span>
              <span className="nav-label">{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>
      <section className="workspace">
        <div className="page-shell">
          <header className={`page-header page-header-${activeModule}`}>
            <div className="page-copy">
              <span className="page-kicker">{MODULE_ENGLISH_TITLES[activeModule] ?? 'MES MANAGEMENT'}</span>
              <h1>{active?.label ?? 'MES 控制台'}</h1>
            </div>
            <div className="page-meta">
              <span className="user-pill">{session.displayName}</span>
              <button className="soft-action" onClick={() => { localStorage.removeItem(SERVER_SESSION_KEY); setSession(null) }}>退出</button>
            </div>
          </header>
          {activeModule !== 's7' && <DashboardStrip overview={overview} />}
          {message && <div className="message-bar">{message}</div>}
          <section className="content-strip">
            {activeModule === 'product' && <ProductModule products={products} onChanged={() => void reloadWorkspace()} />}
            {activeModule === 'personnel' && <PersonnelModule onChanged={() => void reloadWorkspace()} />}
            {activeModule === 'process' && <ProcessModule onChanged={() => void reloadWorkspace()} />}
            {activeModule === 'production' && <ProductionModule records={records} onChanged={() => void reloadWorkspace()} />}
            {activeModule === 'settings' && <SettingsModule onChanged={() => void reloadWorkspace()} />}
            {activeModule === 'traceability' && <TraceabilityModule />}
            {activeModule === 's7' && <S7Module />}
            {!['product', 'personnel', 'process', 'production', 'settings', 'traceability', 's7'].includes(activeModule) && <GenericModule module={active} records={records} />}
          </section>
        </div>
      </section>
    </main>
  )
}

export function WorkstationSopApp() {
  const [session, setSession] = useState<Session | null>(() => {
    const raw = localStorage.getItem(WORKSTATION_SESSION_KEY)
    return raw ? JSON.parse(raw) : null
  })
  const [selectedRouteId, setSelectedRouteId] = useState<number | null>(null)
  const [sops, setSops] = useState<SopFile[]>([])
  const [stations, setStations] = useState<Station[]>([])
  const [stationCode, setStationCode] = useState(() => localStorage.getItem('mes-workstation-station') ?? 'OP1')
  const [stationInput, setStationInput] = useState(() => localStorage.getItem('mes-workstation-station') ?? 'OP1')
  const [selectedSopId, setSelectedSopId] = useState<number | null>(null)
  const [isSopViewerOpen, setIsSopViewerOpen] = useState(false)
  const [workOrder, setWorkOrder] = useState<WorkstationQrContext | null>(null)
  const [qrCode, setQrCode] = useState(() => localStorage.getItem('mes-workstation-qr') ?? '')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (session) localStorage.setItem(WORKSTATION_SESSION_KEY, JSON.stringify(session))
  }, [session])

  useEffect(() => {
    void api.get<Station[]>('/api/process/stations').then(setStations).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!selectedRouteId) {
      setSops([])
      setIsSopViewerOpen(false)
      return
    }
    void (async () => {
      try {
        const nextSops = await api.get<SopFile[]>(`/api/process/routes/${selectedRouteId}/sops`)
        setSops(nextSops)
        setSelectedSopId(nextSops.find((sop) => sop.sequenceNo === workOrder?.sequenceNo)?.id ?? nextSops.find((sop) => sop.stationCode.toUpperCase() === stationCode.toUpperCase())?.id ?? null)
        setIsSopViewerOpen(false)
        setMessage('')
      } catch {
        setMessage('无法加载当前路线的 SOP 文件。')
      }
    })()
  }, [selectedRouteId, stationCode, workOrder])

  useEffect(() => {
    const scannedCode = qrCode.trim()
    if (!scannedCode.startsWith('WO=') && !scannedCode.startsWith('MES1|WO=')) return
    const timer = window.setTimeout(() => void resolveQrCode(scannedCode), 300)
    return () => window.clearTimeout(timer)
  }, [qrCode])

  const selectedSop = sops.find((sop) => sop.id === selectedSopId) ?? null
  const canEditStation = session?.userType === 'admin'
  function changeStation(nextStationCode: string) {
    if (!canEditStation) return
    const normalized = nextStationCode.trim().toUpperCase()
    if (!normalized) return
    setStationInput(normalized)
    setStationCode(normalized)
    localStorage.setItem('mes-workstation-station', normalized)
    if (qrCode.trim()) void resolveQrCode(qrCode, normalized)
  }
  async function resolveQrCode(value = qrCode, targetStationCode = stationCode) {
    const normalized = value.trim()
    if (!normalized) {
      setMessage('请输入或扫描流通码。')
      return
    }
    try {
      const context = await api.send<WorkstationQrContext>(`/api/workstations/${encodeURIComponent(targetStationCode)}/qr-context`, { qrCode: normalized })
      setQrCode(normalized)
      localStorage.setItem('mes-workstation-qr', normalized)
      setWorkOrder(context)
      setSelectedRouteId(context.routeId)
      setMessage('')
    } catch (error) {
      setWorkOrder(null)
      setSelectedRouteId(null)
      setSops([])
      setSelectedSopId(null)
      setMessage(error instanceof Error ? error.message.replace(/^"|"$/g, '') : '二维码解析失败。')
    }
  }
  if (!session) return <LoginScreen onLogin={setSession} />
  return (
    <main className="workstation-sop-page">
      <header className="workstation-sop-header">
        <div className="workstation-sop-brand"><strong>工位机</strong><span>SOP 作业指导书</span></div>
        <div className="workstation-qr-entry">
          <label htmlFor="workstation-qr-code">QR Code</label>
          <input id="workstation-qr-code" value={qrCode} readOnly={session.userType !== 'admin'} onChange={(event) => setQrCode(event.target.value)} autoFocus={session.userType === 'admin'} />
        </div>
        <div className="workstation-sop-user">
          <span>工号：{session.employeeNo ?? '管理员'}</span>
          <span>操作人员：{session.displayName}</span>
          <button type="button" onClick={() => { localStorage.removeItem(WORKSTATION_SESSION_KEY); setSession(null) }}>退出</button>
        </div>
      </header>
      <section className="workstation-sop-content" aria-label="SOP 文件">
        {canEditStation && <div className="workstation-admin-station">
          <label>工位号<input list="workstation-station-codes" value={stationInput} onChange={(event) => setStationInput(event.target.value)} onBlur={() => changeStation(stationInput)} onKeyDown={(event) => { if (event.key === 'Enter') changeStation(stationInput) }} /></label>
          <datalist id="workstation-station-codes">{stations.map((station) => <option key={station.code} value={station.code} />)}</datalist>
        </div>}
        {message && <p className="workstation-sop-message">{message}</p>}
        {!message && selectedRouteId && sops.length === 0 && <p className="workstation-sop-empty">当前工艺路线尚未配置 SOP 文件。</p>}
        {selectedSop && <button className={`workstation-sop-fab${isSopViewerOpen ? ' open' : ''}`} type="button" aria-label={isSopViewerOpen ? '收起 SOP 作业指导书' : '展开 SOP 作业指导书'} aria-expanded={isSopViewerOpen} title={isSopViewerOpen ? '收起 SOP' : '展开 SOP'} onClick={() => setIsSopViewerOpen((current) => !current)}>SOP</button>}
        {selectedSop && isSopViewerOpen && <section className="workstation-sop-viewer">
          <div className="workstation-sop-viewer-head"><div><span>工序 {selectedSop.sequenceNo ?? '-'}</span><strong>{selectedSop.title}</strong></div><span className="workstation-sop-station">工位 {stationCode}</span></div>
          {selectedSop.fileType === 'PDF' ? <iframe title={selectedSop.title} src={`/api/sop-documents/${selectedRouteId}/${selectedSop.sequenceNo}#page=1&navpanes=0`} /> : <p className="workstation-sop-empty">当前 SOP 为视频文件，无法在本页预览。</p>}
        </section>}
      </section>
    </main>
  )
}

function LoginScreen({ onLogin, adminOnly = false }: { onLogin: (session: Session) => void; adminOnly?: boolean }) {
  const [mode, setMode] = useState<'admin' | 'employee'>(adminOnly ? 'admin' : 'employee')
  const [username, setUsername] = useState('ZXC')
  const [password, setPassword] = useState('1826')
  const [employeeNo, setEmployeeNo] = useState('1001')
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      const session = mode === 'admin'
        ? await api.send<Session>('/api/auth/admin', { username, password })
        : await api.send<Session>('/api/auth/employee', { employeeNo })
      onLogin(session)
    } catch {
      setError(mode === 'admin' ? '管理员账号或密码错误' : '仅已登记的员工编号可以登录')
    }
  }
  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="login-brand"><span><img src="/sidebar-brand-logo.svg" alt="" /></span><strong>制造执行系统</strong></div>
        {!adminOnly && <div className="segmented"><button type="button" className={mode === 'admin' ? 'selected' : ''} onClick={() => setMode('admin')}>管理员</button><button type="button" className={mode === 'employee' ? 'selected' : ''} onClick={() => setMode('employee')}>员工登录</button></div>}
        <form className="login-form" onSubmit={submit}>
          {mode === 'admin' ? <><label>用户<input value={username} onChange={(e) => setUsername(e.target.value)} /></label><label>密码<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label></> : <label>员工编号<input value={employeeNo} onChange={(e) => setEmployeeNo(e.target.value)} /><span className="field-hint">仅已登记的员工编号可登录。</span></label>}
          {error && <div className="login-error">{error}</div>}
          <button className="primary-action login-submit">登录</button>
        </form>
      </section>
    </main>
  )
}

function DashboardStrip({ overview }: { overview: Overview | null }) {
  const metrics = overview?.metrics
  const runningQty = metrics?.runningTasks ?? 0
  const runningPlanQty = metrics?.runningPlanQty ?? 0
  const progress = runningPlanQty > 0 ? Math.min(100, Math.round((runningQty / runningPlanQty) * 100)) : 0
  return (
    <section className="summary-row">
      <Metric label="产品档案" value={metrics?.products ?? 0} hint="产品与工艺标准" />
      <Metric label="工单数量" value={metrics?.workOrders ?? 0} hint="待执行与执行中工单" />
      <Metric label="执行任务" value={runningQty} progress={progress} />
      <Metric label="活动报警" value={metrics?.alarms ?? 0} hint="现场异常与告警" />
    </section>
  )
}

function Metric({ label, value, hint, progress }: { label: string; value: number; hint?: string; progress?: number }) {
  return <div className="summary-item"><span>{label}</span><strong>{value}</strong>{hint ? <em>{hint}</em> : null}{typeof progress === 'number' ? <div className="metric-progress"><div className="metric-progress-bar" style={{ width: `${progress}%` }} /></div> : null}</div>
}

function WallboardApp() {
  const [dataset, setDataset] = useState<WallboardDataset>({ overview: null, productionRecords: [], workstationRecords: [], traceabilityRecords: [], rgvRuns: [], products: [], routes: [], routeBindings: [] })
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const [towerSignals, setTowerSignals] = useState({ hlr: false, hlg: false, hlo: false })

  useEffect(() => {
    const updateViewport = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', updateViewport)
    return () => window.removeEventListener('resize', updateViewport)
  }, [])

  useEffect(() => {
    let active = true
    let requestInFlight = false
    const readTowerSignals = async () => {
      if (requestInFlight) return
      requestInFlight = true
      try {
        const response = await fetch(`${S7_API}/api/s7/tags`)
        if (!response.ok) throw new Error('S7 service unavailable')
        const tags = await response.json() as Array<{ name: string; value: string; quality?: string }>
        if (!active) return
        const readTag = (name: string) => tags.find((tag) => tag.name === name && tag.quality !== 'Bad')?.value ?? ''
        setTowerSignals({ hlr: isTagEnabled(readTag('HLR')), hlg: isTagEnabled(readTag('HLG')), hlo: isTagEnabled(readTag('HLO')) })
      } catch {
        if (active) setTowerSignals({ hlr: false, hlg: false, hlo: false })
      } finally {
        requestInFlight = false
      }
    }
    void readTowerSignals()
    const timer = window.setInterval(readTowerSignals, 50)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    void loadWallboard()
    const timer = window.setInterval(() => { void loadWallboard() }, 5000)
    const onStorage = (event: StorageEvent) => { if (event.key === WORK_ORDER_UPDATED_KEY) void loadWallboard() }
    window.addEventListener('storage', onStorage)
    return () => { window.clearInterval(timer); window.removeEventListener('storage', onStorage) }
  }, [])

  async function loadWallboard() {
    try {
      const [overview, productionRecords, workstationRecords, traceabilityRecords, rgvRuns, products, routes] = await Promise.all([
        api.get<Overview>('/api/overview'),
        api.get<Array<Record<string, unknown>>>('/api/modules/production/records'),
        api.get<Array<Record<string, unknown>>>('/api/modules/workstation/records'),
        api.get<Array<Record<string, unknown>>>('/api/modules/traceability/records'),
        api.get<RgvRunRecord[]>('/api/traceability/rgv-runs'),
        api.get<Product[]>('/api/products'),
        api.get<ProcessRoute[]>('/api/process/routes'),
      ])
      const normalizedOrders = productionRecords.map((row) => ({
        workOrderNo: String(row.workOrderNo ?? row.WorkOrderNo ?? ''),
        productName: String(row.productName ?? row.ProductName ?? ''),
        priority: Number(row.priority ?? row.Priority ?? 0),
        status: String(row.status ?? row.Status ?? ''),
      }))
      const currentWorkOrder = normalizedOrders.find((order) => order.status === '执行中')
        ?? normalizedOrders.find((order) => order.status === '待执行')
        ?? normalizedOrders.find((order) => order.status === '完工归档')
        ?? null
      const currentProduct = products.find((product) => product.name === currentWorkOrder?.productName) ?? null
      const currentRoute = routes.find((route) => route.name === currentProduct?.processRoute) ?? null
      const routeBindings = currentRoute
        ? await api.get<ProcessBinding[]>(`/api/process/routes/${currentRoute.id}/bindings`)
        : []

      const normalizedRgvRuns = rgvRuns.map((run) => ({
        ...run,
        toPosition: Number(run.toPosition ?? (run as unknown as { ToPosition?: number }).ToPosition ?? 0),
        endTime: run.endTime ?? (run as unknown as { EndTime?: string | null }).EndTime ?? null,
        missionStateEnd: run.missionStateEnd ?? (run as unknown as { MissionStateEnd?: number | null }).MissionStateEnd ?? null,
      }))
      setDataset({ overview, productionRecords, workstationRecords, traceabilityRecords, rgvRuns: normalizedRgvRuns, products, routes, routeBindings })
    } catch {
      // Live signal variables will be connected in a later iteration.
    }
  }

  const model = useMemo(() => buildWallboardModel(dataset), [dataset])
  const wallboardScale = Math.min(1, viewport.width / 3840, viewport.height / 2160)
  const stageStyle = { width: `${3840 * wallboardScale}px`, height: `${2160 * wallboardScale}px` }
  // Copy the RGV HMI logic: HLR > HLG > HLO, read directly from S7.
  const towerLightStatus = resolveTowerLightStatus(towerSignals.hlr, towerSignals.hlg, towerSignals.hlo)

  return (
    <main className="wallboard-page wallboard-demo-flow">
      <div className="wallboard-scale-stage" style={stageStyle}>
        <section className="wallboard-canvas" style={{ transform: `scale(${wallboardScale})` }}>
          <header className="wallboard-topbar">
            <div
              className={`wallboard-tower-status-bar status-${towerLightStatus}`}
              style={{
                '--tower-light': TOWER_LIGHT_PALETTE[towerLightStatus].color,
                '--tower-light-soft': TOWER_LIGHT_PALETTE[towerLightStatus].soft,
              } as CSSProperties}
              aria-label={`三色灯状态：${towerLightStatus === 'red' ? '红色' : towerLightStatus === 'green' ? '绿色' : '橙色'}`}
            />
            <div className="wallboard-brand-block">
              <span className="wallboard-kicker">MES Dashboard</span>
              <h1>制造执行看板</h1>
            </div>
            <div className="wallboard-topbar-right">
              <div className="wallboard-status-cluster">
                <span className="wallboard-time-pill">{model.serverTimeLabel}</span>
              </div>
            </div>
          </header>

          <WallboardFlowDemo model={model} />
        </section>
      </div>
    </main>
  )
}

function WallboardFlowDemo({ model }: { model: ReturnType<typeof buildWallboardModel> }) {
  return (
    <section className="wallboard-layout wallboard-layout-flow">
      <div className="wallboard-ribbon-row">
        <article className="wallboard-metric-card accent-green wallboard-running-workorders-card">
          <span>执行中工单</span>
          <div className="wallboard-running-workorder-list">
            {model.runningWorkOrderNos.length > 0 ? model.runningWorkOrderNos.map((workOrderNo) => <strong key={workOrderNo}>{workOrderNo}</strong>) : <strong>当前无执行中工单</strong>}
          </div>
        </article>
        <WallboardMetricCard title="当前产量" value={`${model.runningCompletedQty}/${model.runningPlanQty}`} accent="green" progress={model.runningProgress} />
        <section className="wallboard-panel wallboard-route-ribbon-panel">
          <div className="wallboard-flowline wallboard-flowline-compact">
            {model.routeFlow.length > 0 ? model.routeFlow.map((step, index) => (
              <div key={step.key} className="wallboard-flow-segment">
                <article className={`wallboard-flow-node status-${step.statusTone}`}>
                  <span>{step.sequenceLabel}</span>
                  <strong>{step.operationLabel}</strong>
                  <em>{step.detailText}</em>
                </article>
                {index < model.routeFlow.length - 1 ? <div className="wallboard-flow-link" aria-hidden="true" /> : null}
              </div>
            )) : <div className="wallboard-flow-empty">当前没有可用的执行中工艺路线</div>}
          </div>
        </section>
      </div>

      <section className="wallboard-panel wallboard-flowline-panel wallboard-digital-twin-panel">
        <div className="wallboard-digital-twin-shell">
          <DigitalTwinWallboardGraphic stationOperationLabels={model.stationOperationLabels} />
        </div>
      </section>

      <div className="wallboard-bottom-grid">
        <section className="wallboard-panel">
          <div className="wallboard-panel-head">
            <h2>工单推进</h2>
          </div>
          <div className="wallboard-progress-list">
            {model.progressRows.map((row) => (
              <article key={row.workOrderNo} className="wallboard-progress-row">
                <div className="wallboard-progress-copy">
                  <div className="wallboard-progress-headline">
                    <strong>{row.workOrderNo}</strong>
                    <em className={`wallboard-progress-status tone-${progressStatusTone(row.status)}`}>{row.status}</em>
                  </div>
                </div>
                <div className="wallboard-progress-bar-track">
                  <div className="wallboard-progress-bar-fill" style={{ width: `${row.progress}%` }} />
                </div>
                <b>{row.completedQty}/{row.planQty}</b>
              </article>
            ))}
          </div>
        </section>

        <section className="wallboard-panel wallboard-weekly-production-panel">
          <div className="wallboard-panel-head">
            <h2>周产量</h2>
            <span>每日完工数量</span>
          </div>
          <WeeklyProductionChart data={model.weeklyProduction} />
        </section>

        <section className="wallboard-panel">
          <div className="wallboard-panel-head">
            <h2>交付风险</h2>
            <span>仅显示待执行 / 执行中</span>
          </div>
          <div className="wallboard-order-list">
            {model.riskOrders.map((order) => (
              <article key={order.workOrderNo} className={`wallboard-order-row tone-${order.tone}`}>
                <div>
                  <strong>{order.workOrderNo}</strong>
                  <span>{order.productName}</span>
                </div>
                <div>
                  <b>{order.status}</b>
                  <em>{order.dueDateLabel}</em>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  )
}

function WeeklyProductionChart({ data }: { data: Array<{ day: string; quantity: number }> }) {
  const maxQuantity = Math.max(...data.map((item) => item.quantity), 1)
  return (
    <div className="wallboard-weekly-production-chart" aria-label="周产量柱状图">
      <div className="wallboard-weekly-production-plot">
        {data.map((item) => (
          <article key={item.day} className="wallboard-weekly-production-bar">
            <div className="wallboard-weekly-production-bar-track">
              <div className="wallboard-weekly-production-bar-stack" style={{ height: `${(item.quantity / maxQuantity) * 100}%` }}>
                <strong>{item.quantity}</strong>
                <div className="wallboard-weekly-production-bar-fill" />
              </div>
            </div>
            <span>{item.day}</span>
          </article>
        ))}
      </div>
    </div>
  )
}

function S7SidebarIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 10.5h2.2l1.4-5 2.2 8 1.8-6H14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function WallboardMetricCard({
  title,
  value,
  note,
  accent,
  progress,
  compact,
  statusLabel,
  singleLineValue,
}: {
  title: string
  value: string | number
  note?: string
  accent: 'cyan' | 'green' | 'amber' | 'violet'
  progress?: number
  compact?: boolean
  statusLabel?: '执行中' | '待执行' | '完工归档'
  singleLineValue?: boolean
}) {
  return (
    <article className={`wallboard-metric-card accent-${accent}${compact ? ' compact' : ''}${statusLabel ? ' workorder-card' : ''}${singleLineValue ? ' single-line-value' : ''}`}>
      <span>{title}</span>
      <div className="wallboard-metric-body">
        {statusLabel ? (
          <div className="wallboard-workorder-mainline">
            <strong>{value}</strong>
            <b className={`wallboard-workorder-status status-${statusLabel}`}>{statusLabel}</b>
          </div>
        ) : <strong>{value}</strong>}
        {note ? <em>{note}</em> : null}
        {typeof progress === 'number' ? <div className="wallboard-inline-progress"><div style={{ width: `${progress}%` }} /></div> : null}
      </div>
    </article>
  )
}

function buildWallboardModel(dataset: WallboardDataset) {
  const overview = dataset.overview
  const weeklyProduction = buildWeeklyProduction(dataset.rgvRuns)
  const stations = (overview?.stations ?? []).map((row) => ({
    id: Number(row.id ?? row.Id ?? 0),
    code: String(row.code ?? row.Code ?? ''),
    name: normalizeStationDisplayName(
      String(row.code ?? row.Code ?? ''),
      String(row.name ?? row.Name ?? ''),
    ),
    status: String(row.status ?? row.Status ?? '待机'),
    operatorName: String(row.operatorName ?? row.OperatorName ?? '未签入'),
    outputQty: Number(row.outputQty ?? row.OutputQty ?? 0),
    alarmText: String(row.alarmText ?? row.AlarmText ?? ''),
  }))
  const workOrders = dataset.productionRecords.map((row) => ({
    id: Number(row.id ?? row.Id ?? 0),
    workOrderNo: String(row.workOrderNo ?? row.WorkOrderNo ?? ''),
    productName: String(row.productName ?? row.ProductName ?? ''),
    planQty: Number(row.planQty ?? row.PlanQty ?? 0),
    completedQty: Number(row.completedQty ?? row.CompletedQty ?? 0),
    priority: Number(row.priority ?? row.Priority ?? 0),
    status: String(row.status ?? row.Status ?? ''),
    dueDate: String(row.dueDate ?? row.DueDate ?? ''),
    archivedAt: String(row.archivedAt ?? row.ArchivedAt ?? ''),
  }))
  const alarms = (overview?.alarms ?? []).map((row, index) => ({
    id: String(row.id ?? row.Id ?? index),
    stationCode: String(row.stationCode ?? row.StationCode ?? '-'),
    level: String(row.level ?? row.Level ?? ''),
    message: normalizeDisplayText(String(row.message ?? row.Message ?? '-')),
    createdAt: String(row.createdAt ?? row.CreatedAt ?? ''),
    tone: alarmToneFromLevel(String(row.level ?? row.Level ?? '')),
  }))
  const tasks = dataset.workstationRecords.map((row) => ({
    id: Number(row.id ?? row.Id ?? 0),
    workOrderNo: String(row.workOrderNo ?? row.WorkOrderNo ?? ''),
    stationCode: String(row.stationCode ?? row.StationCode ?? ''),
    operationName: normalizeDisplayText(String(row.operationName ?? row.OperationName ?? '')),
    status: normalizeDisplayText(String(row.status ?? row.Status ?? '')),
    goodQty: Number(row.goodQty ?? row.GoodQty ?? 0),
    badQty: Number(row.badQty ?? row.BadQty ?? 0),
  }))
  const traceRowsRaw = dataset.traceabilityRecords.map((row) => ({
    id: String(row.id ?? row.Id ?? ''),
    stationCode: String(row.stationCode ?? row.StationCode ?? ''),
    productBarcode: String(row.productBarcode ?? row.ProductBarcode ?? ''),
    eventType: normalizeDisplayText(String(row.eventType ?? row.EventType ?? '')),
    result: normalizeDisplayText(String(row.result ?? row.Result ?? '')),
    detail: normalizeDisplayText(String(row.detail ?? row.Detail ?? '')),
    createdAt: String(row.createdAt ?? row.CreatedAt ?? ''),
  }))

  const products = dataset.products
  const routes = dataset.routes
  const routeBindings = dataset.routeBindings
  const runningWorkOrders = workOrders.filter((order) => order.status === '执行中')
  const pendingWorkOrders = workOrders.filter((order) => order.status === '待执行')
  const archivedWorkOrders = workOrders.filter((order) => order.status === '完工归档')
  const runningCompletedQty = runningWorkOrders.reduce((sum, order) => sum + order.completedQty, 0)
  const runningPlanQty = runningWorkOrders.reduce((sum, order) => sum + order.planQty, 0)
  const runningProgress = runningPlanQty > 0 ? Math.min(100, Math.round((runningCompletedQty / runningPlanQty) * 100)) : 0

  const runningStationCount = stations.filter((station) => station.status === '运行').length
  const idleStationCount = stations.filter((station) => station.status === '待机').length
  const alertStationCount = stations.filter((station) => station.alarmText).length
  const stationRunRate = stations.length > 0 ? Math.round((runningStationCount / stations.length) * 100) : 0

  const taskBacklog = new Map<string, { code: string; operationLabel: string; pendingTasks: number }>()
  for (const task of tasks.filter((item) => item.status === '待执行' || item.status === '-')) {
    const current = taskBacklog.get(task.stationCode) ?? { code: task.stationCode, operationLabel: task.operationName || task.stationCode, pendingTasks: 0 }
    current.pendingTasks += 1
    taskBacklog.set(task.stationCode, current)
  }

  const stationCards = stations.map((station) => ({
    ...station,
    statusLabel: station.status,
    statusTone: station.alarmText ? 'alarm' : station.status === '运行' ? 'running' : station.status === '待机' ? 'idle' : 'offline',
    outputText: `${station.operatorName} · ${station.outputQty}`,
  }))

  const stationByCode = new Map(stationCards.map((station) => [station.code, station] as const))
  const recommendedWorkOrder = runningWorkOrders[0] ?? pendingWorkOrders[0] ?? archivedWorkOrders[0] ?? null
  const currentProduct = products.find((product) => product.name === recommendedWorkOrder?.productName) ?? null
  const currentRoute = routes.find((route) => route.name === currentProduct?.processRoute) ?? null

  const activeRouteBindings = routeBindings
    .filter((binding) => binding.sequenceNo < 98)
    .sort((left, right) => left.sequenceNo - right.sequenceNo || left.stationCode.localeCompare(right.stationCode, 'zh-CN', { numeric: true }))

  const routeFlowSource = activeRouteBindings.length > 0
    ? activeRouteBindings
    : currentRoute
      ? parseRouteSteps(currentRoute.steps)
          .filter((step) => step.sequenceNo < 98)
          .map((step) => ({ sequenceNo: step.sequenceNo, operationName: step.operationName, stationCode: '', isRequired: step.isRequired }))
      : []

  const routeFlow = Array.from(
    routeFlowSource.reduce((map, item) => {
      const current = map.get(item.sequenceNo) ?? { sequenceNo: item.sequenceNo, operationName: item.operationName, stationCodes: [] as string[] }
      if (item.stationCode && !current.stationCodes.includes(item.stationCode)) current.stationCodes.push(item.stationCode)
      map.set(item.sequenceNo, current)
      return map
    }, new Map<number, { sequenceNo: number; operationName: string; stationCodes: string[] }>())
  )
    .sort((left, right) => left[0] - right[0])
    .map(([, info]) => {
      const relatedStations = info.stationCodes.map((code) => stationByCode.get(code)).filter(Boolean)
      const hasAlarm = relatedStations.some((station) => station?.statusTone === 'alarm')
      const hasRunning = relatedStations.some((station) => station?.statusTone === 'running')
      const stationNames = relatedStations.map((station) => station?.name).filter(Boolean) as string[]
      return {
        key: `${info.sequenceNo}-${info.operationName}`,
        sequenceLabel: `工序 ${info.sequenceNo}`,
        operationLabel: info.operationName,
        statusLabel: hasAlarm ? '异常关注' : hasRunning ? '执行中' : '待执行',
        statusTone: hasAlarm ? 'alarm' : hasRunning ? 'running' : 'idle',
        detailText: stationNames.length > 0 ? stationNames.join(' / ') : '未绑定工位',
      }
    })

  const stationOperationLabels = Object.fromEntries(
    activeRouteBindings
      .filter((binding) => binding.stationCode.trim() && binding.operationName.trim())
      .sort((left, right) => left.sequenceNo - right.sequenceNo)
      .map((binding) => [binding.stationCode.toUpperCase(), binding.operationName.trim()])
  )

  const riskOrders = [...pendingWorkOrders, ...runningWorkOrders]
    .sort((left, right) => {
      return new Date(left.dueDate).getTime() - new Date(right.dueDate).getTime()
    })
    .slice(0, 6)
    .map((order) => ({
      ...order,
      dueDateLabel: formatShortDate(order.dueDate),
      tone: deliveryRiskTone(order.status, order.dueDate),
    }))

  const priorityOrders = [...pendingWorkOrders, ...runningWorkOrders]
    .sort((left, right) => {
      const priorityGap = left.priority - right.priority
      if (priorityGap !== 0) return priorityGap
      return new Date(left.dueDate).getTime() - new Date(right.dueDate).getTime()
    })
    .slice(0, 5)
    .map((order) => ({ ...order, dueDateLabel: formatShortDate(order.dueDate), tone: order.priority <= 1 ? 'warning' : order.status === '执行中' ? 'running' : 'neutral' }))

  const progressRows = [...pendingWorkOrders, ...runningWorkOrders]
    .sort((left, right) => {
      const rank = statusRank(left.status) - statusRank(right.status)
      if (rank !== 0) return rank
      return left.priority - right.priority
    })
    .slice(0, 5)
    .map((order) => ({
      ...order,
      progress: order.planQty > 0 ? Math.min(100, Math.round((order.completedQty / order.planQty) * 100)) : 0,
    }))

  const backlogStations = [...taskBacklog.values()]
    .sort((left, right) => right.pendingTasks - left.pendingTasks || left.code.localeCompare(right.code, 'zh-CN', { numeric: true }))
    .slice(0, 8)

  const traceRows = traceRowsRaw
    .slice(0, 8)
    .map((event) => ({ ...event, createdAtLabel: formatTime(event.createdAt) }))

  const mergedEvents = [
    ...alarms.slice(0, 4).map((alarm) => ({ key: `alarm-${alarm.id}`, title: `${alarm.stationCode} 报警`, detail: alarm.message, timeLabel: formatTime(alarm.createdAt), tone: alarm.tone })),
    ...traceRowsRaw.slice(0, 4).map((event) => ({ key: `trace-${event.id}`, title: `${event.stationCode} ${event.eventType || '追溯记录'}`, detail: `${event.productBarcode} · ${event.result || event.detail || '已记录'}`, timeLabel: formatTime(event.createdAt), tone: event.result.includes('通过') || event.result.includes('OK') ? 'success' : 'neutral' })),
  ].slice(0, 8)

  const statusBreakdown = [
    { label: '运行', value: runningStationCount, percent: stationCards.length > 0 ? Math.round((runningStationCount / stationCards.length) * 100) : 0, tone: 'success' },
    { label: '待机', value: idleStationCount, percent: stationCards.length > 0 ? Math.round((idleStationCount / stationCards.length) * 100) : 0, tone: 'neutral' },
    { label: '异常', value: alertStationCount, percent: stationCards.length > 0 ? Math.round((alertStationCount / stationCards.length) * 100) : 0, tone: 'warning' },
  ]

  return {
    serverTimeLabel: overview ? formatDateTime(String((overview as unknown as { info?: { serverTime?: string } }).info?.serverTime ?? new Date().toISOString())) : formatDateTime(new Date().toISOString()),
    stationCards,
    routeFlow,
    stationOperationLabels,
    stationTotal: stationCards.length,
    runningStationCount,
    idleStationCount,
    alertStationCount,
    stationRunRate,
    activeAlarmCount: alarms.length,
    topAlarmLabel: alarms[0] ? `${alarms[0].stationCode} ${alarms[0].message}` : '当前无活动报警',
    alarmRows: alarms.map((alarm) => ({ ...alarm, createdAtLabel: formatTime(alarm.createdAt) })).slice(0, 6),
    riskOrders,
    priorityOrders,
    progressRows,
    weeklyProduction,
    backlogStations,
    traceRows,
    traceCount: traceRowsRaw.length,
    mergedEvents,
    runningCompletedQty,
    runningPlanQty,
    runningProgress,
    pendingAndRunningCount: pendingWorkOrders.length + runningWorkOrders.length,
    pendingCount: pendingWorkOrders.length,
    archivedCount: archivedWorkOrders.length,
    runningWorkOrderCount: runningWorkOrders.length,
    runningWorkOrderLabels: runningWorkOrders.length > 0 ? runningWorkOrders.map((order) => order.workOrderNo).join(' / ') : '当前无执行中工单',
    runningWorkOrderNos: runningWorkOrders.map((order) => order.workOrderNo),
    runningWorkOrderLabel: runningWorkOrders[0]?.workOrderNo ?? '--',
    recommendedWorkOrderLabel: recommendedWorkOrder?.workOrderNo ?? '无工单',
    recommendedProductLabel: recommendedWorkOrder?.productName ?? '--',
    recommendedWorkOrderStatus: (recommendedWorkOrder?.status as '执行中' | '待执行' | '完工归档' | undefined) ?? '待执行',
    statusBreakdown,
  }
}

function statusRank(status: string) {
  if (status === '执行中') return 0
  if (status === '待执行') return 1
  if (status === '完工归档') return 2
  return 3
}

function alarmToneFromLevel(level: string) {
  if (level.includes('高')) return 'critical'
  if (level.includes('中')) return 'warning'
  return 'neutral'
}

function normalizeDisplayText(value: string) {
  return value.includes('??') || value.includes('?') ? '数据异常' : value
}

function formatShortDate(value: string) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function deliveryRiskTone(status: string, dueDate: string) {
  const due = new Date(dueDate)
  if (Number.isNaN(due.getTime())) return status === '执行中' ? 'running' : 'neutral'

  const now = new Date()
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const diffDays = Math.floor((dueDay - today) / 86400000)

  if (diffDays < 0) return 'critical'
  if (status === '执行中') return 'running'
  if (diffDays <= 3) return 'warning'
  return 'neutral'
}

function progressStatusTone(status: string) {
  if (status === '执行中') return 'running'
  if (status === '完工归档') return 'archived'
  return 'pending'
}

function formatTime(value: string) {
  if (!value) return '--:--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${month}-${day} ${hour}:${minute}`
}

function ProductModule({ products, onChanged }: { products: Product[]; onChanged: () => void }) {
  const [form, setForm] = useState(emptyProduct)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [routes, setRoutes] = useState<ProcessRoute[]>([])
  const [pendingDelete, setPendingDelete] = useState<Product | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [submitError, setSubmitError] = useState('')

  function buildProductPayload() {
    return {
      name: form.name,
      barcode: form.barcode,
      category: '',
      processRoute: form.processRoute,
    }
  }

  useEffect(() => {
    void loadRoutes()
  }, [])

  async function loadRoutes() {
    const nextRoutes = await api.get<ProcessRoute[]>('/api/process/routes')
    setRoutes(nextRoutes)
    setForm((current) => current.processRoute ? current : { ...current, processRoute: nextRoutes[0]?.name ?? '' })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitError('')
    try {
      const payload = buildProductPayload()
      await api.send(editingId ? `/api/products/${editingId}` : '/api/products', payload, editingId ? 'PUT' : 'POST')
      setForm({ ...emptyProduct, processRoute: routes[0]?.name ?? '' })
      setEditingId(null)
      onChanged()
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '保存产品失败')
    }
  }

  function edit(product: Product) {
    setEditingId(product.id)
    setForm({ name: product.name, barcode: product.barcode, processRoute: product.processRoute })
  }

  async function deleteProduct(product: Product) {
    setDeleteError('')
    try {
      await api.send(`/api/products/${product.id}`, undefined, 'DELETE')
      if (editingId === product.id) {
        setEditingId(null)
        setForm({ ...emptyProduct, processRoute: routes[0]?.name ?? '' })
      }
      setPendingDelete(null)
      onChanged()
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '删除产品失败')
    }
  }

  return (
    <div className="product-layout">
      <form className="edit-panel product-form-panel" onSubmit={submit}>
        <h2>{editingId ? '编辑产品' : '新增产品'}</h2>
        <label>产品名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
        <label>产品编码<input value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} required /></label>
        <label>工艺路线<select value={form.processRoute} onChange={(e) => setForm({ ...form, processRoute: e.target.value })} required>{routes.map((route) => <option key={route.id} value={route.name}>{route.name}</option>)}</select></label>
        <button className="primary-action">{editingId ? '保存产品' : '创建产品'}</button>
        {submitError ? <div className="form-error" role="alert">{submitError}</div> : null}
      </form>
      <div className="product-table-panel">
        {deleteError ? <div className="form-error" role="alert">{deleteError}</div> : null}
        <ProductTable products={products} onEdit={edit} onDelete={setPendingDelete} />
        {pendingDelete ? (
          <div className="inline-confirm" role="alertdialog" aria-label="确认删除产品">
            <span>确认删除产品“{pendingDelete.name}”吗？</span>
            <button type="button" className="mini-button danger" onClick={() => void deleteProduct(pendingDelete)}>确认删除</button>
            <button type="button" className="mini-button" onClick={() => setPendingDelete(null)}>取消</button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ProductTable({ products, onEdit, onDelete }: { products: Product[]; onEdit: (product: Product) => void; onDelete: (product: Product) => void }) {
  if (products.length === 0) return <div className="empty-state">暂无产品</div>

  return (
    <div className="table-shell product-table-shell">
      <table className="product-table">
        <thead>
          <tr>
            <th>产品名称</th>
            <th>产品编码</th>
            <th>工艺路线</th>
            <th className="product-col-center">操作</th>
            <th>创建时间</th>
          </tr>
        </thead>
        <tbody>
          {products.map((product) => (
              <tr key={product.id} onClick={() => onEdit(product)} className="product-table-row">
                <td>{product.name}</td>
                <td>{product.barcode}</td>
                <td>{product.processRoute}</td>
                <td className="product-col-center">
                  <button
                    type="button"
                    className="mini-button danger"
                    onClick={(event) => {
                      event.stopPropagation()
                      onDelete(product)
                    }}
                  >删除</button>
                </td>
                <td>{formatValue((product as unknown as Record<string, unknown>).createdAt)}</td>
              </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
function ProcessModule({ onChanged }: { onChanged: () => void }) {
  const [routes, setRoutes] = useState<ProcessRoute[]>([])
  const [stations, setStations] = useState<Station[]>([])
  const [selectedRouteId, setSelectedRouteId] = useState<number | null>(null)
  const [bindings, setBindings] = useState<ProcessBinding[]>([])
  const [sops, setSops] = useState<SopFile[]>([])
  const [sopForms, setSopForms] = useState<Record<string, SopForm>>({})
  const [processSteps, setProcessSteps] = useState<Array<{ sequenceNo: number; operationName: string; isRequired: boolean }>>([])
  const [form, setForm] = useState<ProcessRouteForm>({ name: '', productName: 'MES工艺路线', steps: '' })
  const [editingRouteId, setEditingRouteId] = useState<number | null>(null)

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    if (selectedRouteId) void loadRouteDetails(selectedRouteId)
  }, [selectedRouteId])

  useEffect(() => {
    const current = routes.find((route) => route.id === selectedRouteId)
    if (!current) return
    setEditingRouteId(current.id)
    setForm({
      name: current.name,
      productName: current.productName,
      steps: current.steps,
    })
    setProcessSteps(parseRouteSteps(current.steps))
  }, [selectedRouteId, routes])

  useEffect(() => {
    if (!editingRouteId || !selectedRouteId || !form.name.trim()) return
    const timer = window.setTimeout(() => {
      void autoSaveRoute()
    }, 600)
    return () => window.clearTimeout(timer)
  }, [editingRouteId, selectedRouteId, form.name, processSteps, bindings])

  async function load() {
    const [nextRoutes, nextStations] = await Promise.all([
      api.get<ProcessRoute[]>('/api/process/routes'),
      api.get<Station[]>('/api/process/stations'),
    ])
    setRoutes(nextRoutes)
    setStations(
      nextStations
        .filter((station) => /^OP\d+$/i.test(station.code))
        .map((station) => ({ ...station, name: normalizeStationDisplayName(station.code, station.name) }))
        .sort((a, b) => Number(a.code.replace(/\D/g, '')) - Number(b.code.replace(/\D/g, ''))),
    )
    const firstId = nextRoutes[0]?.id ?? null
    setSelectedRouteId((current) => current ?? firstId)
  }

  async function loadRouteDetails(routeId: number) {
    await Promise.all([loadBindings(routeId), loadSops(routeId)])
  }

  async function loadBindings(routeId: number) {
    const next = await api.get<ProcessBinding[]>(`/api/process/routes/${routeId}/bindings`)
    setBindings(next)
    setProcessSteps((current) => {
      const fromBindings = next
        .filter((binding) => binding.operationName.trim())
        .sort((left, right) => left.sequenceNo - right.sequenceNo || left.stationCode.localeCompare(right.stationCode))
        .reduce<Array<{ sequenceNo: number; operationName: string; isRequired: boolean }>>((acc, binding) => {
          const exists = acc.find((step) => step.sequenceNo === binding.sequenceNo && step.operationName === binding.operationName)
          if (!exists) acc.push({ sequenceNo: binding.sequenceNo, operationName: binding.operationName, isRequired: binding.isRequired })
          return acc
        }, [])
      const base = current.filter((step) => step.sequenceNo < 98)
      const merged = base.map((step) => fromBindings.find((item) => item.sequenceNo === step.sequenceNo) ?? step)
      for (const step of fromBindings) {
        if (!merged.find((item) => item.sequenceNo === step.sequenceNo)) merged.push(step)
      }
      const normalized = merged.sort((left, right) => left.sequenceNo - right.sequenceNo)
      return mergeWithFixedSteps(normalized.length > 0 ? normalized : [DEFAULT_FIRST_STEP])
    })
  }

  async function loadSops(routeId: number) {
    const next = await api.get<SopFile[]>(`/api/process/routes/${routeId}/sops`)
    setSops(next)
    const nextForms: Record<string, SopForm> = {}
    for (const sop of next) {
      if (!sop.sequenceNo) continue
      nextForms[`${routeId}:${sop.sequenceNo}`] = {
        title: sop.title,
        fileType: sop.fileType || 'PDF',
        filePath: sop.filePath,
        version: sop.version || 'V1.0',
      }
    }
    setSopForms((current) => ({ ...current, ...nextForms }))
  }

  async function autoSaveRoute() {
    if (!editingRouteId) return
    const payloadBindings = bindings.filter((binding) => binding.operationName.trim())
    const payload = { ...form, productName: 'MES工艺路线', version: selectedRoute?.version ?? 'V1.0', status: selectedRoute?.status ?? '在线', steps: processSteps.filter((step) => step.sequenceNo < 98).map((step) => step.operationName.trim()).filter(Boolean).join(' > ') }
    await api.send(`/api/process/routes/${editingRouteId}`, payload, 'PUT')
    await api.send(`/api/process/routes/${editingRouteId}/bindings`, { bindings: payloadBindings })
    setRoutes((current) => current.map((route) => route.id === editingRouteId ? { ...route, name: payload.name, productName: payload.productName, steps: payload.steps, version: payload.version, status: payload.status } : route))
    onChanged()
  }

  async function deleteRoute() {
    if (!selectedRouteId) return
    await api.send(`/api/process/routes/${selectedRouteId}`, {}, 'DELETE')
    setSelectedRouteId(null)
    setEditingRouteId(null)
    setBindings([])
    setSops([])
    setSopForms({})
    setProcessSteps(mergeWithFixedSteps([]))
    await load()
    onChanged()
  }

  async function startCreateRoute() {
    const created = await api.send<{ id: number }>('/api/process/routes', {
      name: `新工艺 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
      productName: 'MES工艺路线',
      steps: DEFAULT_FIRST_STEP.operationName,
      version: 'V1.0',
      status: '在线',
    })
    setBindings([])
    setSops([])
    setSopForms({})
    setProcessSteps(mergeWithFixedSteps([DEFAULT_FIRST_STEP]))
    await load()
    setSelectedRouteId(created.id)
    setEditingRouteId(created.id)
    onChanged()
  }

  function syncBindingsWithSteps(nextSteps: Array<{ sequenceNo: number; operationName: string; isRequired: boolean }>) {
    setProcessSteps(mergeWithFixedSteps(nextSteps))
    setBindings((current) => current.map((binding) => {
      const matched = nextSteps.find((step) => step.sequenceNo === binding.sequenceNo)
      return matched ? { ...binding, operationName: matched.operationName, isRequired: matched.isRequired } : { ...binding, operationName: '', isRequired: true }
    }))
  }

  function addStep() {
    const dynamicSteps = processSteps.filter((step) => step.sequenceNo < 98)
    const nextSequenceNo = dynamicSteps.length + 1
    const nextSteps = [...dynamicSteps, { sequenceNo: nextSequenceNo, operationName: `新工序 ${nextSequenceNo}`, isRequired: true }]
    setProcessSteps(mergeWithFixedSteps(nextSteps))
  }

  function updateStep(sequenceNo: number, patch: Partial<{ operationName: string; sequenceNo: number; isRequired: boolean }>) {
    const nextSteps = processSteps.map((step) => step.sequenceNo === sequenceNo ? { ...step, ...patch } : step).sort((left, right) => left.sequenceNo - right.sequenceNo)
    syncBindingsWithSteps(nextSteps)
  }

  function removeStep(sequenceNo: number) {
    if (sequenceNo >= 98) return
    const nextSteps = processSteps.filter((step) => step.sequenceNo < 98 && step.sequenceNo !== sequenceNo).sort((left, right) => left.sequenceNo - right.sequenceNo).map((step, index) => ({ ...step, sequenceNo: index + 1 }))
    syncBindingsWithSteps(nextSteps)
  }

  function bindingFor(stationCode: string) {
    const existing = bindings.find((binding) => binding.stationCode === stationCode)
    if (existing) return existing
    return { stationCode, operationName: '', sequenceNo: 0, isRequired: true }
  }

  function assignStationToStep(stationCode: string, sequenceNo: number) {
    const step = processSteps.find((item) => item.sequenceNo === sequenceNo)
    if (!step) return
    setBindings((current) => {
      const existing = current.find((item) => item.stationCode === stationCode)
      const next = { ...bindingFor(stationCode), ...existing, stationCode, sequenceNo: step.sequenceNo, operationName: step.operationName, isRequired: step.isRequired }
      return existing ? current.map((item) => item.stationCode === stationCode ? next : item) : [...current, next]
    })
  }

  function sopFor(sequenceNo: number) {
    return sops.find((sop) => sop.sequenceNo === sequenceNo)
  }

  function sopFormKey(sequenceNo: number) {
    return `${selectedRouteId ?? 0}:${sequenceNo}`
  }

  function sopFormFor(step: { sequenceNo: number; operationName: string }) {
    const saved = sopFor(step.sequenceNo)
    return sopForms[sopFormKey(step.sequenceNo)] ?? {
      title: saved?.title ?? `${step.operationName || `工序 ${step.sequenceNo}`} SOP`,
      fileType: saved?.fileType ?? 'PDF',
      filePath: saved?.filePath ?? '',
      version: saved?.version ?? 'V1.0',
    }
  }

  function updateSopForm(sequenceNo: number, patch: Partial<SopForm>) {
    setSopForms((current) => {
      const key = sopFormKey(sequenceNo)
      const existing = current[key] ?? { title: `工序 ${sequenceNo} SOP`, fileType: 'PDF', filePath: '', version: 'V1.0' }
      return { ...current, [key]: { ...existing, ...patch } }
    })
  }

  function chooseSopFile(step: { sequenceNo: number; operationName: string }, stationCodes: string[], file: File | undefined) {
    if (!file) return
    const fileType = file.type.startsWith('video/') ? 'VIDEO' : 'PDF'
    const nextForm = { ...sopFormFor(step), fileType, filePath: file.name }
    updateSopForm(step.sequenceNo, nextForm)
    void saveSop(step, stationCodes, nextForm)
  }

  async function saveSop(step: { sequenceNo: number; operationName: string }, stationCodes: string[], overrideForm?: SopForm) {
    if (!selectedRouteId) return
    const nextForm = overrideForm ?? sopFormFor(step)
    if (!nextForm.filePath.trim()) return
    await api.send(`/api/process/routes/${selectedRouteId}/sops`, {
      sequenceNo: step.sequenceNo,
      title: nextForm.title || `${step.operationName || `工序 ${step.sequenceNo}`} SOP`,
      productName: form.productName || 'MES工艺路线',
      stationCode: stationCodes[0] ?? '',
      fileType: nextForm.fileType,
      filePath: nextForm.filePath,
      version: nextForm.version || 'V1.0',
    })
    await loadSops(selectedRouteId)
  }

  const selectedRoute = routes.find((route) => route.id === selectedRouteId) ?? null
  const stepOptions = processSteps.length === 0 ? [] : processSteps.map((step) => ({ sequenceNo: step.sequenceNo, operationName: step.operationName || `工序 ${step.sequenceNo}` }))
  const requiredSteps = processSteps.filter((step) => step.isRequired && step.sequenceNo < 98)
  const canConfigureProcess = editingRouteId !== null && selectedRouteId !== null

  return (
    <div className="process-layout process-layout-graph">
      <section className="process-route-list">
        <div className="process-route-list-header">
          <div>
            <h2>工艺路线</h2>
            <p>每条路线就是一套工艺，先定义路线，再定义工序和绑定 OP。</p>
          </div>
          <button className="primary-action" type="button" onClick={() => void startCreateRoute()}>新增工艺</button>
        </div>
        <div className="process-route-cards">
          {routes.map((route, index) => (
            <button key={route.id} type="button" className={`process-route-card${selectedRouteId === route.id ? ' active' : ''}`} onClick={() => setSelectedRouteId(route.id)}>
              <span className="process-route-code">工艺 {index + 1}</span>
              <strong>{route.name}</strong>
              <em>{route.productName}</em>
            </button>
          ))}
        </div>
      </section>

      <section className="binding-panel">
        <section className="edit-panel process-editor-panel process-section-card">
          <div className="process-editor-header">
            <div>
              <h2>{editingRouteId ? '编辑工艺路线' : '新建工艺路线'}</h2>
              <p>{selectedRoute ? `当前工艺：${selectedRoute.name}，修改后自动保存。` : '新增并保存工艺后即可继续配置。'}</p>
            </div>
            <div className="process-editor-actions">
              {editingRouteId ? <button className="soft-action danger" type="button" onClick={() => void deleteRoute()}>删除工艺</button> : null}
            </div>
          </div>
          <div className="process-editor-grid">
            <label>工艺名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：测试路线 / RGV产线" required /></label>
          </div>
        </section>

        <section className="process-section-card">
          <div className="binding-header">
            <div>
              <h2>定义工序</h2>
              <p>{canConfigureProcess ? '先定义工序名称，多个 OP 可以绑定到同一个工序，修改后自动保存。' : '请先新增并保存工艺，再定义工序。'}</p>
            </div>
            <button className="primary-action" type="button" onClick={addStep} disabled={!canConfigureProcess}>新增工序</button>
          </div>
          <div className="process-step-grid">
            {!canConfigureProcess ? <div className="empty-state">保存工艺后，才允许新增和标记工序。</div> : processSteps.length === 0 ? <div className="empty-state">请先新增工序，例如：装配、测试、终检。</div> : processSteps.map((step) => (
              <div className="process-step-card" key={step.sequenceNo}>
                <div className="process-step-card-head">
                  <strong>工序 {step.sequenceNo}</strong>
                  {step.sequenceNo < 98 ? <button className="mini-button danger" type="button" onClick={() => removeStep(step.sequenceNo)}>删除</button> : <span className="process-step-fixed">固定</span>}
                </div>
                <label>工序名称<input value={step.operationName} onChange={(e) => updateStep(step.sequenceNo, { operationName: e.target.value })} placeholder="例如：装配" /></label>
                <label className="checkbox-row"><input type="checkbox" checked={step.isRequired} disabled={step.sequenceNo >= 98} onChange={(e) => updateStep(step.sequenceNo, { isRequired: e.target.checked })} />必经工序</label>
              </div>
            ))}
          </div>
        </section>

        <section className="process-section-card">
          <div className="binding-header binding-subheader">
            <div>
              <h2>工位绑定</h2>
              <p>{canConfigureProcess ? '每个 OP 只需要选择所属工序，不需要重复录入工序名称，修改后自动保存。' : '保存工艺后，才可绑定 OP。'}</p>
            </div>
          </div>
          <div className="station-binding-grid">
            {!canConfigureProcess ? <div className="empty-state">保存工艺后，才可绑定 OP。</div> : <>
              {stations.map((station) => {
              const binding = bindingFor(station.code)
              return (
                <div className="station-binding-card" key={station.code}>
                  <strong>{station.code}</strong>
                  <label>绑定工序<select value={processSteps.some((step) => step.sequenceNo === binding.sequenceNo) ? binding.sequenceNo : ''} onChange={(e) => assignStationToStep(station.code, Number(e.target.value))}>
                      <option value="">选择工序</option>
                      {stepOptions.map((step) => <option key={step.sequenceNo} value={step.sequenceNo}>{`工序 ${step.sequenceNo} · ${step.operationName}`}</option>)}
                    </select></label>
                </div>
              )
              })}
            </>}
          </div>
        </section>

        <section className="process-section-card">
          <div className="binding-header">
            <div>
              <h2>图形化 SOP</h2>
              <p>{canConfigureProcess ? `当前路线：${selectedRoute?.name ?? '-'}。每个工序的 SOP 独立保存，不与其他工艺路线共享。` : '保存工艺后，才可继续配置 SOP。'}</p>
            </div>
          </div>
          <div className="process-flow-board">
            {!canConfigureProcess ? <div className="empty-state">保存工艺后，才可继续配置 SOP。</div> : requiredSteps.length === 0 ? <div className="empty-state">当前没有必经工序，无法生成流程图。</div> : (
              <div className="process-flow-strip">
                {requiredSteps.map((step, index) => {
                  const stationCodes = bindings.filter((binding) => binding.sequenceNo === step.sequenceNo && binding.operationName.trim()).map((binding) => binding.stationCode)
                  const currentSop = sopFor(step.sequenceNo)
                  const currentSopForm = sopFormFor(step)
                  return (
                    <div className="process-flow-item" key={step.sequenceNo}>
                      <article className="process-flow-node">
                        <span>工序 {step.sequenceNo}</span>
                        <strong>{step.operationName || `未命名工序 ${step.sequenceNo}`}</strong>
                        <em>{stationCodes.length > 0 ? stationCodes.join(' / ') : '未绑定 OP'}</em>
                        <div className="sop-panel">
                          <div className="sop-title-row">
                            <b>SOP</b>
                            <small>{currentSop ? '已保存' : '未保存'}</small>
                          </div>
                          <input value={currentSopForm.title} onChange={(e) => updateSopForm(step.sequenceNo, { title: e.target.value })} placeholder="SOP 标题" />
                          <div className="sop-inline-fields">
                            <select value={currentSopForm.fileType} onChange={(e) => {
                              const nextForm = { ...currentSopForm, fileType: e.target.value }
                              updateSopForm(step.sequenceNo, nextForm)
                              void saveSop(step, stationCodes, nextForm)
                            }}>
                              <option value="PDF">PDF</option>
                              <option value="VIDEO">视频</option>
                            </select>
                            <label className={`sop-file-button${currentSopForm.filePath.trim() ? ' bound' : ''}`}>选择文件<input type="file" accept="application/pdf,video/*" onChange={(e) => chooseSopFile(step, stationCodes, e.target.files?.[0])} /></label>
                          </div>
                          <input className="sop-path-input" value={currentSopForm.filePath} onChange={(e) => updateSopForm(step.sequenceNo, { filePath: e.target.value })} onBlur={() => void saveSop(step, stationCodes)} placeholder="填写 PDF/视频地址，例如 D:\\MES\\SOP\\op1.pdf" />
                        </div>
                      </article>
                      {index < requiredSteps.length - 1 ? <div className="process-flow-arrow" aria-hidden="true">→</div> : null}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </section>
      </section>
    </div>
  )
}
function ProductionModule({ records, onChanged }: { records: Array<Record<string, unknown>>; onChanged: () => void }) {
  const [products, setProducts] = useState<Product[]>([])
  const [labelPrintTarget, setLabelPrintTarget] = useState<LabelPrintTarget | null>(null)
  const [labelRange, setLabelRange] = useState({ startCode: 1, endCode: 1 })
  const [labelPrintError, setLabelPrintError] = useState('')
  const today = new Date()
  today.setDate(today.getDate() + 3)
  const [form, setForm] = useState<WorkOrderForm>({
    workOrderNo: '',
    productName: '',
    planQty: 100,
    priority: 1,
    dueDate: today.toISOString().slice(0, 10),
  })

  useEffect(() => {
    void loadEnabledProducts()
  }, [])

  async function loadEnabledProducts() {
    const nextProducts = await api.get<Product[]>('/api/products')
    setProducts(nextProducts)
    setForm((current) => current.productName ? current : { ...current, productName: nextProducts[0]?.name ?? '' })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    await api.send('/api/production/work-orders', form)
    setForm((current) => ({ ...current, workOrderNo: '', productName: products[0]?.name ?? current.productName, planQty: 100 }))
    onChanged()
    notifyWorkOrderChanged()
  }

  async function saveWorkOrder(id: number, completedQty: number, priority: number, dueDate: string, status: '待执行' | '执行中' | '完工归档') {
    await api.send(`/api/production/work-orders/${id}`, { completedQty, priority, dueDate, status }, 'PUT')
    onChanged()
    notifyWorkOrderChanged()
  }

  async function executeWorkOrder(id: number) {
    await api.send(`/api/production/work-orders/${id}/status`, { status: '执行中' }, 'PUT')
    onChanged()
    notifyWorkOrderChanged()
  }

  async function pauseWorkOrder(id: number) {
    await api.send(`/api/production/work-orders/${id}/status`, { status: '待执行' }, 'PUT')
    onChanged()
    notifyWorkOrderChanged()
  }

  async function deleteWorkOrder(id: number) {
    await api.send(`/api/production/work-orders/${id}`, {}, 'DELETE')
    onChanged()
    notifyWorkOrderChanged()
  }

  function openLabelPrint(target: LabelPrintTarget) {
    setLabelPrintTarget(target)
    setLabelRange({ startCode: 1, endCode: target.planQty })
    setLabelPrintError('')
  }

  async function confirmLabelPrint(event: FormEvent) {
    event.preventDefault()
    if (!labelPrintTarget) return
    if (!Number.isInteger(labelRange.startCode) || !Number.isInteger(labelRange.endCode) || labelRange.startCode < 1 || labelRange.endCode < labelRange.startCode || labelRange.endCode > labelPrintTarget.planQty) {
      setLabelPrintError(`起始码须不小于 1；结束码须不小于起始码且不超过 ${labelPrintTarget.planQty}。`)
      return
    }
    try {
      await api.send(`/api/production/work-orders/${labelPrintTarget.id}/label-prints`, labelRange)
      setLabelPrintTarget(null)
      setLabelPrintError('')
    } catch (error) {
      setLabelPrintError(error instanceof Error ? error.message : '流通码打印记录保存失败。')
    }
  }

  const sortedRecords = [...records].sort((left, right) => {
    const leftPriority = Number(left.priority ?? 9999)
    const rightPriority = Number(right.priority ?? 9999)
    if (leftPriority !== rightPriority) return leftPriority - rightPriority

    const leftTime = new Date(String(left.dueDate ?? left.createdAt ?? left.id ?? 0)).getTime()
    const rightTime = new Date(String(right.dueDate ?? right.createdAt ?? right.id ?? 0)).getTime()
    return rightTime - leftTime
  })

  const activeRows = sortedRecords.filter((row) => {
    const status = String(row.status ?? row.Status ?? '')
    return status !== '完工归档'
  })

  const archivedRows = sortedRecords.filter((row) => {
    const status = String(row.status ?? row.Status ?? '')
    return status === '完工归档'
  })

  return (
    <div className="product-layout">
      <form className="edit-panel product-form-panel" onSubmit={submit}>
        <h2>工单创建</h2>
        <label>工单号<input placeholder="留空则自动生成" value={form.workOrderNo} onChange={(e) => setForm({ ...form, workOrderNo: e.target.value })} /></label>
        <label>产品名称<select value={form.productName} onChange={(e) => setForm({ ...form, productName: e.target.value })} required><option value="">选择产品</option>{products.map((product) => <option key={product.id} value={product.name}>{product.name}</option>)}</select></label>
        <label>计划数量<input type="number" min="1" value={form.planQty} onChange={(e) => setForm({ ...form, planQty: Number(e.target.value) })} required /></label>
        <label>优先级<input type="number" min="1" max="9" value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} required /></label>
        <label>交付日期<input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} required /></label>
        <button className="primary-action">创建工单</button>
      </form>
      <div className="product-table-panel">
        <WorkOrderTable
          rows={activeRows}
          productNames={products.map((product) => product.name)}
          onSave={(id, completedQty, priority, dueDate, status) => void saveWorkOrder(id, completedQty, priority, dueDate, status)}
          onExecute={(id) => void executeWorkOrder(id)}
          onPause={(id) => void pauseWorkOrder(id)}
          onArchive={(id, planQty, completedQty, priority, dueDate) => {
            const message = completedQty < planQty
              ? `当前完工数量 ${completedQty} 小于计划数量 ${planQty}，确认要完工归档吗？`
              : '确认将当前工单设为完工归档吗？'
            if (!window.confirm(message)) return
            void saveWorkOrder(id, completedQty, priority, dueDate, '完工归档')
          }}
          onDelete={(id) => void deleteWorkOrder(id)}
          onPrintLabel={openLabelPrint}
        />
        <section className="archived-workorders-card">
          <div className="binding-header binding-subheader">
            <div>
              <h2>完工归档工单</h2>
              <p>这里显示已经归档完成的工单，可与当前执行工单区分查看。</p>
            </div>
          </div>
          <ArchivedWorkOrderTable rows={archivedRows} productNames={products.map((product) => product.name)} />
        </section>
      </div>
      {labelPrintTarget && <div className="label-print-modal-backdrop" role="presentation">
        <form className="label-print-modal" onSubmit={confirmLabelPrint} role="dialog" aria-modal="true" aria-labelledby="label-print-title">
          <h2 id="label-print-title">打印流通码</h2>
          <p>工单号：<strong>{labelPrintTarget.workOrderNo}</strong></p>
          <p>产品名称：<strong>{labelPrintTarget.productName}</strong></p>
          <p>计划数量：<strong>{labelPrintTarget.planQty}</strong></p>
          <label>起始码<input type="number" min="1" max={labelPrintTarget.planQty} value={labelRange.startCode} onChange={(event) => {
            const startCode = Number(event.target.value)
            setLabelRange((current) => ({ startCode, endCode: current.endCode >= startCode ? current.endCode : startCode }))
          }} required /></label>
          <label>结束码<input type="number" min={labelRange.startCode} max={labelPrintTarget.planQty} value={labelRange.endCode} onChange={(event) => setLabelRange({ ...labelRange, endCode: Number(event.target.value) })} required /></label>
          {labelPrintError && <p className="label-print-error">{labelPrintError}</p>}
          <div className="label-print-actions"><button type="button" className="soft-action" onClick={() => setLabelPrintTarget(null)}>取消</button><button type="submit" className="primary-action">确认打印</button></div>
        </form>
      </div>}
    </div>
  )
}

function WorkOrderTable({
  rows,
  productNames,
  onSave,
  onExecute,
  onPause,
  onArchive,
  onDelete,
  onPrintLabel,
}: {
  rows: Array<Record<string, unknown>>
  productNames: string[]
  onSave: (id: number, completedQty: number, priority: number, dueDate: string, status: '待执行' | '执行中' | '完工归档') => void
  onExecute: (id: number) => void
  onPause: (id: number) => void
  onArchive: (id: number, planQty: number, completedQty: number, priority: number, dueDate: string) => void
  onDelete: (id: number) => void
  onPrintLabel: (target: LabelPrintTarget) => void
}) {
  if (rows.length === 0) return <div className="empty-state">暂无工单</div>

  function pick(row: Record<string, unknown>, camel: string, pascal: string) {
    return row[camel] ?? row[pascal]
  }

  function productName(row: Record<string, unknown>) {
    const raw = String(pick(row, 'productName', 'ProductName') ?? '')
    return productNames.find((name) => name === raw || name.slice(1) === raw) ?? raw
  }

  return (
    <div className="table-shell workorder-table-shell">
      <table className="workorder-table">
        <thead>
          <tr>
            <th>工单号</th>
            <th>产品名称</th>
            <th className="workorder-col-center">计划数量</th>
            <th className="workorder-col-center">完工数量</th>
            <th className="workorder-col-center">优先级</th>
            <th className="workorder-col-center">状态</th>
            <th className="workorder-col-center">交付日期</th>
            <th className="workorder-col-center">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const status = formatValue(pick(row, 'status', 'Status'))
            const pending = status === '待执行'
            const running = status === '执行中'
            const archived = status === '完工归档'
            const rowId = Number(pick(row, 'id', 'Id') ?? 0)
            const planQty = Number(pick(row, 'planQty', 'PlanQty') ?? 0)
            const completedQty = Number(pick(row, 'completedQty', 'CompletedQty') ?? 0)
            const priority = Number(pick(row, 'priority', 'Priority') ?? 1)
            const dueDate = String(formatValue(pick(row, 'dueDate', 'DueDate'))).slice(0, 10)
            return (
            <tr key={String(rowId || index)}>
              <td>{formatValue(pick(row, 'workOrderNo', 'WorkOrderNo'))}</td>
              <td>{productName(row)}</td>
              <td className="workorder-col-center">{formatValue(planQty)}</td>
              <td className="workorder-col-center">
                <input
                  className="workorder-qty-input"
                  type="number"
                  min="0"
                  defaultValue={completedQty}
                  onBlur={(event) => onSave(rowId, Number(event.target.value), priority, dueDate, status as '待执行' | '执行中' | '完工归档')}
                />
              </td>
              <td className="workorder-col-center">
                <input
                  className="workorder-priority-input"
                  type="number"
                  min="1"
                  max="9"
                  defaultValue={priority}
                  onBlur={(event) => onSave(rowId, completedQty, Number(event.target.value), dueDate, status as '待执行' | '执行中' | '完工归档')}
                />
              </td>
              <td className="workorder-col-center">
                <span className={`workorder-status${running ? ' running' : archived ? ' archived' : ''}`}>{status}</span>
              </td>
              <td className="workorder-col-center">
                <input
                  className="workorder-date-input"
                  type="date"
                  defaultValue={dueDate}
                  onChange={(event) => onSave(rowId, completedQty, priority, event.target.value, status as '待执行' | '执行中' | '完工归档')}
                />
              </td>
              <td className="workorder-col-center">
                <div className="workorder-actions">
                  {pending ? <button type="button" className="mini-button execute-button" onClick={() => onExecute(rowId)}>执行</button> : null}
                  {running ? <button type="button" className="mini-button pause-button" onClick={() => onPause(rowId)}>暂停</button> : null}
                  {(pending || running) ? <button type="button" className="mini-button" onClick={() => onPrintLabel({ id: rowId, workOrderNo: String(pick(row, 'workOrderNo', 'WorkOrderNo') ?? ''), productName: String(pick(row, 'productName', 'ProductName') ?? ''), planQty })}>打印流通码</button> : null}
                  {running ? <button type="button" className="mini-button workorder-archive-button" onClick={(event) => {
                    const rowElement = event.currentTarget.closest('tr')
                    const completedInput = rowElement?.querySelector<HTMLInputElement>('.workorder-qty-input')
                    const priorityInput = rowElement?.querySelector<HTMLInputElement>('.workorder-priority-input')
                    const dueDateInput = rowElement?.querySelector<HTMLInputElement>('.workorder-date-input')
                    onArchive(
                      rowId,
                      planQty,
                      Number(completedInput?.value ?? completedQty),
                      Number(priorityInput?.value ?? priority),
                      dueDateInput?.value ?? dueDate,
                    )
                  }}>完工归档</button> : null}
                  {!pending && !running ? <span className="workorder-action-placeholder">-</span> : null}
                  {pending ? <button type="button" className="mini-button danger" onClick={() => onDelete(rowId)}>删除</button> : null}
                </div>
              </td>
            </tr>
          )})}
        </tbody>
      </table>
    </div>
  )
}

function ArchivedWorkOrderTable({ rows, productNames }: { rows: Array<Record<string, unknown>>; productNames: string[] }) {
  if (rows.length === 0) return <div className="empty-state">暂无完工归档工单</div>

  function pick(row: Record<string, unknown>, camel: string, pascal: string) {
    return row[camel] ?? row[pascal]
  }

  function productName(row: Record<string, unknown>) {
    const raw = String(pick(row, 'productName', 'ProductName') ?? '')
    return productNames.find((name) => name === raw || name.slice(1) === raw) ?? raw
  }

  return (
    <div className="table-shell workorder-table-shell">
      <table className="workorder-table">
        <thead>
          <tr>
            <th>工单号</th>
            <th>产品名称</th>
            <th className="workorder-col-center">计划数量</th>
            <th className="workorder-col-center">完工数量</th>
            <th className="workorder-col-center">优先级</th>
            <th className="workorder-col-center">状态</th>
            <th className="workorder-col-center">交付日期</th>
            <th className="workorder-col-center">归档时间</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const status = formatValue(pick(row, 'status', 'Status'))
            return (
              <tr key={String(pick(row, 'id', 'Id') ?? index)}>
                <td>{formatValue(pick(row, 'workOrderNo', 'WorkOrderNo'))}</td>
                <td>{productName(row)}</td>
                <td className="workorder-col-center">{formatValue(pick(row, 'planQty', 'PlanQty'))}</td>
                <td className="workorder-col-center">{formatValue(pick(row, 'completedQty', 'CompletedQty'))}</td>
                <td className="workorder-col-center">{formatValue(pick(row, 'priority', 'Priority'))}</td>
                <td className="workorder-col-center">
                  <span className={`workorder-status${status === '完工归档' ? ' archived' : ''}`}>{status}</span>
                </td>
                <td className="workorder-col-center">{formatValue(pick(row, 'dueDate', 'DueDate'))}</td>
                <td className="workorder-col-center">{formatValue(pick(row, 'archivedAt', 'ArchivedAt'))}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function SettingsModule({ onChanged }: { onChanged: () => void }) {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<EmployeeForm>({ employeeNo: '', name: '', department: '生产部', roleCode: 'operator', isActive: true })
  const rows = employees as unknown as Array<Record<string, unknown>>

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    const [nextEmployees, nextRoles] = await Promise.all([
      api.get<Employee[]>('/api/settings/employees'),
      api.get<Role[]>('/api/settings/roles'),
    ])
    setEmployees(nextEmployees)
    setRoles(nextRoles)
  }

  function edit(employee: Employee) {
    setEditingId(employee.id)
    setForm({
      employeeNo: employee.employeeNo,
      name: employee.name,
      department: employee.department,
      roleCode: employee.roleCode,
      isActive: employee.isActive,
    })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    await api.send(editingId ? `/api/settings/employees/${editingId}` : '/api/settings/employees', form, editingId ? 'PUT' : 'POST')
    setEditingId(null)
    setForm({ employeeNo: '', name: '', department: '生产部', roleCode: 'operator', isActive: true })
    await load()
    onChanged()
  }

  async function remove(id: number) {
    await api.send(`/api/settings/employees/${id}`, {}, 'DELETE')
    await load()
    onChanged()
  }

  return (
    <div className="module-grid">
      <form className="edit-panel" onSubmit={submit}>
        <h2>{editingId ? '编辑员工' : '新增员工'}</h2>
        <label>员工编号<input value={form.employeeNo} onChange={(e) => setForm({ ...form, employeeNo: e.target.value })} required /></label>
        <label>姓名<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
        <label>部门<input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} required /></label>
        <label>角色<select value={form.roleCode} onChange={(e) => setForm({ ...form, roleCode: e.target.value })}>{roles.map((role) => <option key={role.code} value={role.code}>{role.name}</option>)}</select></label>
        <label className="checkbox-row"><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />允许员工登录</label>
        <button className="primary-action">{editingId ? '保存员工' : '创建员工'}</button>
      </form>
      <DataTable rows={rows} actions={(row) => <><button className="mini-button" onClick={() => edit(row as unknown as Employee)}>编辑</button><button className="mini-button danger" onClick={() => void remove(Number(row.id))}>删除</button></>} />
    </div>
  )
}

function PersonnelModule({ onChanged }: { onChanged: () => void }) {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [routes, setRoutes] = useState<ProcessRoute[]>([])
  const [permissions, setPermissions] = useState<EmployeeProcessPermission[]>([])
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<EmployeeForm>({ employeeNo: '', name: '', department: '生产部', roleCode: 'operator', isActive: true })

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    if (selectedEmployeeId) void loadPermissions(selectedEmployeeId)
    else setPermissions([])
  }, [selectedEmployeeId])

  async function load() {
    const [nextEmployees, nextRoutes] = await Promise.all([
      api.get<Employee[]>('/api/settings/employees'),
      api.get<ProcessRoute[]>('/api/process/routes'),
    ])
    setEmployees([...nextEmployees].sort((left, right) => left.employeeNo.localeCompare(right.employeeNo, 'zh-CN', { numeric: true })))
    setRoutes(nextRoutes)
    setSelectedEmployeeId((current) => current ?? nextEmployees[0]?.id ?? null)
  }

  async function loadPermissions(employeeId: number) {
    setPermissions(await api.get<EmployeeProcessPermission[]>(`/api/personnel/permissions/${employeeId}`))
  }

  function edit(employee: Employee) {
    setEditingId(employee.id)
    setSelectedEmployeeId(employee.id)
    setForm({
      employeeNo: employee.employeeNo,
      name: employee.name,
      department: employee.department,
      roleCode: 'operator',
      isActive: true,
    })
  }

  async function submitEmployee(event: FormEvent) {
    event.preventDefault()
    const payload = { ...form, roleCode: 'operator', isActive: true }
    const saved = await api.send<{ id?: number }>(editingId ? `/api/settings/employees/${editingId}` : '/api/settings/employees', payload, editingId ? 'PUT' : 'POST')
    const nextSelectedId = editingId ?? saved.id ?? selectedEmployeeId
    setEditingId(null)
    setForm({ employeeNo: '', name: '', department: '生产部', roleCode: 'operator', isActive: true })
    await load()
    setSelectedEmployeeId(nextSelectedId ?? null)
    onChanged()
  }

  async function removeEmployee(id: number) {
    await api.send(`/api/settings/employees/${id}`, {}, 'DELETE')
    if (selectedEmployeeId === id) setSelectedEmployeeId(null)
    await load()
    onChanged()
  }

  function routeSteps(route: ProcessRoute) {
    return parseRouteSteps(route.steps).filter((step) => step.sequenceNo < 98)
  }

  function permissionFor(routeId: number, step: { sequenceNo: number; operationName: string }) {
    return permissions.find((permission) => permission.routeId === routeId && permission.sequenceNo === step.sequenceNo) ?? {
      routeId,
      sequenceNo: step.sequenceNo,
      operationName: step.operationName,
      canView: false,
      canOperate: false,
      canMaintainSop: false,
    }
  }

  async function persistPermissions(nextPermissions: EmployeeProcessPermission[]) {
    if (!selectedEmployeeId) return
    await api.send(`/api/personnel/permissions/${selectedEmployeeId}`, {
      permissions: nextPermissions
        .filter((permission) => permission.canOperate)
        .map((permission) => ({ ...permission, canView: true, canMaintainSop: false })),
    })
    await loadPermissions(selectedEmployeeId)
  }

  function updatePermission(routeId: number, step: { sequenceNo: number; operationName: string }, patch: Partial<EmployeeProcessPermission>) {
    const existing = permissions.find((permission) => permission.routeId === routeId && permission.sequenceNo === step.sequenceNo)
    const next = { ...permissionFor(routeId, step), ...patch, routeId, sequenceNo: step.sequenceNo, operationName: step.operationName }
    const nextPermissions = existing
      ? permissions.map((permission) => permission.routeId === routeId && permission.sequenceNo === step.sequenceNo ? next : permission)
      : [...permissions, next]
    setPermissions(nextPermissions)
    void persistPermissions(nextPermissions)
  }

  const selectedEmployee = employees.find((employee) => employee.id === selectedEmployeeId) ?? null
  const maxStepCount = Math.max(0, ...routes.map((route) => routeSteps(route).length))
  const stepColumns = Array.from({ length: maxStepCount }, (_, index) => index + 1)

  return (
    <div className="personnel-layout">
      <section className="personnel-card">
        <div className="binding-header binding-subheader">
          <div>
            <h2>员工登记信息</h2>
            <p>维护员工编号、姓名和部门，登记后的员工才可以通过员工编号登录系统。</p>
          </div>
        </div>
        <form className="personnel-form" onSubmit={submitEmployee}>
          <label>员工编号<input value={form.employeeNo} onChange={(event) => setForm({ ...form, employeeNo: event.target.value })} required /></label>
          <label>姓名<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label>
          <label>部门<input value={form.department} onChange={(event) => setForm({ ...form, department: event.target.value })} required /></label>
          <button className="primary-action">{editingId ? '保存员工' : '新增员工'}</button>
        </form>
        <div className="personnel-list">
          {employees.map((employee) => (
            <button key={employee.id} type="button" className={`personnel-row${selectedEmployeeId === employee.id ? ' active' : ''}`} onClick={() => setSelectedEmployeeId(employee.id)}>
              <strong>{employee.employeeNo}</strong>
              <span>{employee.name}</span>
              <em>可登录</em>
              <button className="mini-button" type="button" onClick={(event) => { event.stopPropagation(); edit(employee) }}>编辑</button>
              <button className="mini-button danger" type="button" onClick={(event) => { event.stopPropagation(); void removeEmployee(employee.id) }}>删除</button>
            </button>
          ))}
        </div>
      </section>

      <section className="personnel-card">
        <div className="binding-header">
          <div>
            <h2>员工权限</h2>
            <p>{selectedEmployee ? `当前员工：${selectedEmployee.employeeNo} · ${selectedEmployee.name}，勾选后即可具备对应工序权限。` : '请先选择一名员工，再配置工艺路线和工序权限。'}</p>
          </div>
        </div>
        <div className="skill-matrix-wrap">
          {!selectedEmployeeId ? <div className="empty-state">请先选择员工</div> : routes.length === 0 ? <div className="empty-state">当前没有可用的工艺路线</div> : (
            <div className="skill-matrix" style={{ gridTemplateColumns: `minmax(180px, 1.1fr) repeat(${Math.max(1, maxStepCount)}, minmax(118px, 1fr))` }}>
              <div className="skill-cell skill-head">工艺路线</div>
              {stepColumns.map((sequenceNo) => <div className="skill-cell skill-head" key={sequenceNo}>工序 {sequenceNo}</div>)}
              {routes.flatMap((route) => {
                const steps = routeSteps(route)
                return [
                  <div className="skill-cell skill-route" key={`${route.id}-route`}><strong>{route.name}</strong><span>{route.version} · {route.status}</span></div>,
                  ...stepColumns.map((sequenceNo) => {
                    const step = steps.find((item) => item.sequenceNo === sequenceNo)
                    const permission = step ? permissionFor(route.id, step) : null
                    return (
                      <label className={`skill-cell skill-check${step ? (permission?.canOperate ? ' checked' : '') : ' empty'}`} key={`${route.id}-${sequenceNo}`}>
                        {step ? <><input type="checkbox" checked={permission?.canOperate ?? false} onChange={(event) => updatePermission(route.id, step, { canOperate: event.target.checked, canView: event.target.checked, canMaintainSop: false })} /><span>{step.operationName}</span></> : <span>-</span>}
                      </label>
                    )
                  }),
                ]
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

export function WorkstationModule({ records, session, onChanged }: { records: Array<Record<string, unknown>>; session: Session; onChanged: () => void }) {
  const firstTask = records[0]
  async function reportWork() {
    await api.send('/api/production/report-work', { taskId: Number(firstTask?.id ?? 1), productBarcode: 'MES-SCAN-' + Date.now(), stationCode: String(firstTask?.stationCode ?? 'OP10'), operatorNo: session.employeeNo ?? 'ZXC', goodQty: 1, badQty: 0 })
    onChanged()
  }
  async function alarm() {
    await api.send('/api/alarms', { stationCode: String(firstTask?.stationCode ?? 'OP10'), level: '中', message: '工位现场异常报警', owner: session.displayName })
    onChanged()
  }
  return <div className="workstation"><div className="workstation-actions"><button className="primary-action" onClick={() => void reportWork()}>提交报工</button><button className="soft-action danger" onClick={() => void alarm()}>异常报警</button></div><DataTable rows={records} /><button className="workstation-module-sop-fab" type="button" aria-label="打开工位机 SOP" title="打开工位机 SOP" onClick={() => { window.location.href = '/workstation' }}>SOP</button></div>
}

function TraceabilityModule() {
  const [rgvRuns, setRgvRuns] = useState<RgvRunRecord[]>([])
  const [fromDate, setFromDate] = useState(() => new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10))
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [page, setPage] = useState(1)
  const pageSize = 50
  useEffect(() => {
    let disposed = false
    const load = async () => {
      try {
        const response = await api.get<Array<Record<string, unknown>>>('/api/traceability/rgv-runs')
        const value = (row: Record<string, unknown>, key: string) => row[key] ?? row[key[0].toUpperCase() + key.slice(1)]
        const normalized = response.map((row) => ({
          id: Number(value(row, 'id') ?? 0),
          taskId: String(value(row, 'taskId') ?? ''),
          workOrderNo: value(row, 'workOrderNo') ? String(value(row, 'workOrderNo')) : null,
          startTime: String(value(row, 'startTime') ?? ''),
          endTime: value(row, 'endTime') ? String(value(row, 'endTime')) : null,
          fromPosition: Number(value(row, 'fromPosition') ?? 0),
          toPosition: Number(value(row, 'toPosition') ?? 0),
          durationSeconds: value(row, 'durationSeconds') == null ? null : Number(value(row, 'durationSeconds')),
        }))
        if (!disposed) setRgvRuns(normalized)
      } catch { if (!disposed) setRgvRuns([]) }
    }
    void load()
    const timer = window.setInterval(load, 5000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [])
  const filteredRuns = useMemo(() => {
    const start = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : -Infinity
    const end = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : Infinity
    return rgvRuns.filter((run) => { const time = new Date(run.startTime).getTime(); return time >= start && time <= end })
  }, [rgvRuns, fromDate, toDate])
  const totalPages = Math.max(1, Math.ceil(filteredRuns.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const visibleRuns = filteredRuns.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  return <section className="table-shell rgv-run-history"><div className="module-intro"><div className="rgv-run-heading"><h2>RGV 运行状态追溯</h2><div className="rgv-run-filters"><label>开始日期<input type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); setPage(1) }} /></label><label>结束日期<input type="date" value={toDate} onChange={(e) => { setToDate(e.target.value); setPage(1) }} /></label></div></div><div className="pagination"><span>共 {filteredRuns.length} 条</span><button type="button" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button><span>{currentPage} / {totalPages}</span><button type="button" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>下一页</button></div></div><table><thead><tr><th>TaskID</th><th>工单号</th><th>开始时间</th><th>结束时间</th><th>起始位</th><th>目标位</th><th>持续时间</th></tr></thead><tbody>{visibleRuns.length === 0 ? <tr><td colSpan={7}>暂无 RGV 运行记录</td></tr> : visibleRuns.map((run) => <tr key={run.id}><td>{run.taskId}</td><td>{run.workOrderNo || '-'}</td><td>{formatValue(run.startTime)}</td><td>{run.endTime ? formatValue(run.endTime) : '执行中'}</td><td>{run.fromPosition}</td><td>{run.toPosition}</td><td>{run.durationSeconds == null ? '-' : `${Math.round(Number(run.durationSeconds))} 秒`}</td></tr>)}</tbody></table></section>
}

type S7Status = { connected: boolean; state: string; lastUpdatedAt?: string | null; lastError?: string | null; quality: string }
type S7Configuration = { host: string; port: number; rack: number; slot: number; cpuType: string; simulation: boolean; environment: string }
type S7Tag = { name: string; value: string; address: string; dataType?: string; quality?: string; sourceTimestamp?: string | null; group?: string; access?: string }
type RgvRunRecord = { id: number; taskId: string; workOrderNo?: string | null; startTime: string; endTime?: string | null; fromPosition: number; toPosition: number; durationSeconds?: number | null; missionStateEnd?: number | null }

function S7TagTree({ tags }: { tags: S7Tag[] }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const groups = useMemo(() => Array.from(new Set(tags.map((tag) => tag.group || 'S7 标签'))).sort().map((group) => ({ group, tags: tags.filter((tag) => (tag.group || 'S7 标签') === group) })), [tags])
  return <div className="s7-tree-wrap"><div className="s7-tree-head"><span>名称</span><span>地址</span><span>类型</span><span>当前值</span><span>权限</span></div><div className="s7-tree-body">{groups.map(({ group, tags: groupTags }) => {
    const groupKey = `group:${group}`
    const grouped = new Map<string, S7Tag[]>()
    for (const tag of groupTags) { const family = tag.name.match(/^(.*)\[[^\]]+\]/)?.[1] ?? ''; const key = family || tag.name; grouped.set(key, [...(grouped.get(key) ?? []), tag]) }
    return <div key={group}><div className="s7-tree-node kind-group"><button type="button" className="s7-tree-toggle" onClick={() => setCollapsed((current) => { const next = new Set(current); next.has(groupKey) ? next.delete(groupKey) : next.add(groupKey); return next })}><span className="s7-tree-caret">{collapsed.has(groupKey) ? '+' : '−'}</span>{group} <span className="s7-tree-count">({groupTags.length})</span></button><span /><span /><span /><span className="tag-access tag-read-only">分组</span></div>{!collapsed.has(groupKey) && Array.from(grouped.entries()).map(([family, familyTags]) => { const familyKey = `${groupKey}:${family}`; const isFamily = familyTags.length > 1 && family !== familyTags[0].name; return <div key={familyKey}>{isFamily && <div className="s7-tree-node kind-family"><button type="button" className="s7-tree-toggle" onClick={() => setCollapsed((current) => { const next = new Set(current); next.has(familyKey) ? next.delete(familyKey) : next.add(familyKey); return next })}><span className="s7-tree-caret">{collapsed.has(familyKey) ? '+' : '−'}</span>{family} <span className="s7-tree-count">({familyTags.length})</span></button><span /><span /><span /><span className="tag-access tag-read-write">数组</span></div>}{(!isFamily || !collapsed.has(familyKey)) && familyTags.map((tag) => <div className="s7-tree-tag" key={tag.address}><span className="s7-tree-tag-name"><span className="s7-tree-leaf">·</span>{tag.name}</span><span className="s7-address">{tag.address.replace(/^%/, '')}</span><span className="s7-tree-type">{tag.dataType ?? '-'}</span><span className="tag-value">{tag.value}</span><span className={`tag-access ${tag.access === 'ReadOnly' ? 'tag-read-only' : 'tag-read-write'}`}>{tag.access === 'ReadOnly' ? '只读' : '读写'}</span></div>)}</div>})}</div>
  })}</div></div>
}

function S7Module() {
  const [status, setStatus] = useState<S7Status | null>(null)
  const [configuration, setConfiguration] = useState<S7Configuration | null>(null)
  const [tags, setTags] = useState<S7Tag[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    async function load() {
      try {
        const [statusResponse, configurationResponse, tagsResponse] = await Promise.all([
          fetch(`${S7_API}/api/s7/status`),
          fetch(`${S7_API}/api/s7/configuration`),
          fetch(`${S7_API}/api/s7/tags`),
        ])
        if (!statusResponse.ok || !configurationResponse.ok || !tagsResponse.ok) throw new Error('S7 服务暂不可用')
        if (disposed) return
        setStatus(await statusResponse.json())
        setConfiguration(await configurationResponse.json())
        setTags(await tagsResponse.json())
        setError('')
      } catch (loadError) {
        if (!disposed) setError(loadError instanceof Error ? loadError.message : 'S7 数据同步失败')
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 3000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [])

  const connected = status?.connected ?? false
  return (
    <div className="s7-module">
      <section className="s7-overview-grid">
        <article className="summary-item"><span>通讯状态</span><strong className={connected ? 's7-value-ok' : 's7-value-offline'}>{connected ? '已连接' : '未连接'}</strong><em>{status?.state ?? '等待服务响应'}</em></article>
        <article className="summary-item"><span>数据质量</span><strong>{status?.quality ?? '-'}</strong><em>每 3 秒自动刷新</em></article>
        <article className="summary-item"><span>实时标签</span><strong>{tags.length}</strong><em>当前服务返回的标签数量</em></article>
        <article className="summary-item"><span>运行环境</span><strong>{configuration?.environment ?? '-'}</strong><em>{configuration?.simulation ? '仿真模式' : 'PLC 实时模式'}</em></article>
      </section>
      {error && <div className="message-bar">{error}</div>}
      <div className="s7-layout">
        <section className="module-panel s7-config-panel"><div className="module-intro"><h2>PLC 连接配置</h2><p>服务器 S7 通讯服务当前使用的运行参数。</p></div><div className="s7-config-grid"><div><span>PLC 地址</span><strong>{configuration?.host ?? '-'}</strong></div><div><span>端口</span><strong>{configuration?.port ?? '-'}</strong></div><div><span>机架 / 槽位</span><strong>{configuration ? `${configuration.rack} / ${configuration.slot}` : '-'}</strong></div><div><span>CPU 类型</span><strong>{configuration?.cpuType ?? '-'}</strong></div></div><div className={`s7-connection-state ${connected ? 'online' : 'offline'}`}><span className="status-line">{connected ? '连接正常' : '等待 PLC 响应'}</span>{status?.lastError && <small>{status.lastError}</small>}</div></section>
        <section className="module-panel s7-tags-panel"><div className="module-intro"><h2>标签读写测试</h2><p>分组、数组与标签三级目录，实时显示当前值和访问权限。</p></div><S7TagTree tags={tags} /></section>
      </div>
    </div>
  )
}

function GenericModule({ module, records }: { module?: ModuleInfo; records: Array<Record<string, unknown>> }) {
  return <div className="generic-module"><div className="module-intro"><h2>{module?.label}</h2><p>{module?.description}</p></div><DataTable rows={records} /></div>
}

function DataTable({ rows, actions }: { rows: Array<Record<string, unknown>>; actions?: (row: Record<string, unknown>) => ReactNode }) {
  const columns = useMemo(() => Object.keys(rows[0] ?? {}).slice(0, 8), [rows])
  if (rows.length === 0) return <div className="empty-state">暂无数据</div>
  return <div className="table-shell"><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}{actions && <th>操作</th>}</tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.id ?? index)}>{columns.map((column) => <td key={column}>{formatValue(row[column])}</td>)}{actions && <td className="row-actions">{actions(row)}</td>}</tr>)}</tbody></table></div>
}

function formatValue(value: unknown) {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'string' && value.includes('T')) return value.replace('T', ' ').slice(0, 19)
  return String(value)
}
