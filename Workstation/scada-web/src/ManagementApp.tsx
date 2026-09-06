import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { DigitalTwinModule, StationSelectGraphic } from './DigitalTwinModule'
import './ManagementApp.css'
import { S7_API, putSimulationTagValue } from './s7Api'

type AdminSession = { username: string }
type S7Tag = { name: string; address: string; dataType: string; value: string; sourceTimestamp?: string; serverTimestamp?: string; group: string; access: string; quality?: string; lastError?: string }
type SystemConfiguration = { stationNumber: number; serverIp: string; isInterfaceFlipped: boolean; maxPos: number; opRows: Record<string, boolean> }
type Menu = 'settings' | 's7' | 'twin' | 'station-select'


function defaultOpRows(maxPos: number, existing: Record<string, boolean> = {}) {
  const topCount = Math.ceil(maxPos / 2)
  return Object.fromEntries(Array.from({ length: maxPos }, (_, offset) => {
    const op = offset + 1
    return [String(op), existing[String(op)] ?? op <= topCount]
  }))
}

export function AdminLogin({ onLogin, onBack }: { onLogin: (session: AdminSession) => void; onBack: () => void }) {
  const [username, setUsername] = useState('ZXC')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  function submit(event: FormEvent) {
    event.preventDefault()
    if (username.trim() !== 'ZXC' || password !== '1826') {
      setError('管理员账号或密码不正确。')
      return
    }
    onLogin({ username: 'ZXC' })
  }

  return <main className="admin-login-page">
    <form className="admin-login-panel" onSubmit={submit}>
      <div className="admin-login-brand"><img src="/sidebar-brand-logo.svg" alt="" /><div><span>SCADA RGV</span><h1>系统管理</h1></div></div>
      <label>管理员账号<input value={username} autoComplete="username" onChange={(event) => setUsername(event.target.value)} /></label>
      <label>密码<input value={password} type="password" autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} /></label>
      {error ? <p className="admin-login-error">{error}</p> : null}
      <button className="admin-login-submit" type="submit">登录</button>
      <button className="admin-login-back" type="button" onClick={onBack}>返回看板</button>
    </form>
  </main>
}

export function ManagementApp({ session, onExit }: { session: AdminSession; onExit: () => void }) {
  const [active, setActive] = useState<Menu>('settings')
  return <main className="management-shell">
    <aside className="management-sidebar">
      <div className="management-brand"><img src="/sidebar-brand-logo.svg" alt="" /><strong>RGV 监控系统</strong></div>
      <nav>{([['settings', '配置'], ['s7', 'S7 通讯'], ['twin', '数字孪生'], ['station-select', '工位选择']] as Array<[Menu, string]>).map(([key, label]) => <button key={key} className={active === key ? 'active' : ''} onClick={() => setActive(key)}>{label}</button>)}</nav>
      <div className="management-user"><span>{session.username}</span><button onClick={onExit}>退出管理</button></div>
    </aside>
    <section className="management-content">
      {active === 'settings' ? <SettingsPanel /> : null}
      {active === 's7' ? <S7Panel /> : null}
      {active === 'twin' ? <section className="management-twin"><header className="management-module-header"><span>Digital Twin</span><h1>数字孪生</h1></header><DigitalTwinModule /></section> : null}
      {active === 'station-select' ? <section className="management-station-select"><StationSelectGraphic /></section> : null}
    </section>
  </main>
}

function SettingsPanel() {
  const [config, setConfig] = useState({ host: '—', port: '—', rack: '—', slot: '—', cpuType: '—' })
  const [systemConfiguration, setSystemConfiguration] = useState<SystemConfiguration | null>(null)
  const [configurationError, setConfigurationError] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const s7Response = await fetch(`${S7_API}/api/s7/configuration`)
        if (s7Response.ok) {
          const s7 = await s7Response.json() as { host: string; port: number; rack: number; slot: number; cpuType: string; simulation?: boolean; environment?: string }
          setConfig({ host: s7.simulation ? '开发模拟模式' : s7.host, port: String(s7.port), rack: String(s7.rack), slot: String(s7.slot), cpuType: s7.simulation ? `${s7.cpuType} · ${s7.environment ?? 'Development'}` : s7.cpuType })
        }
        const response = await fetch(`${S7_API}/api/system/configuration`)
        if (!response.ok) throw new Error('无法读取系统配置。')
        const value = await response.json() as SystemConfiguration
        setSystemConfiguration({ ...value, serverIp: value.serverIp?.trim() || '127.0.0.1', opRows: defaultOpRows(value.maxPos, value.opRows) })
      } catch (reason) {
        setConfigurationError(reason instanceof Error ? reason.message : '无法读取系统配置。')
      }
    })()
  }, [])

  async function saveSystemConfiguration(next: SystemConfiguration) {
    setConfigurationError('')
    try {
      const response = await fetch(`${S7_API}/api/system/configuration`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) })
      if (!response.ok) throw new Error('保存系统配置失败。')
      const savedConfiguration = await response.json() as SystemConfiguration
      setSystemConfiguration(savedConfiguration)
    } catch (reason) {
      setConfigurationError(reason instanceof Error ? reason.message : '保存系统配置失败。')
    }
  }

  function updateSystemConfiguration(next: SystemConfiguration, saveImmediately = false) {
    setSystemConfiguration(next)
    if (saveImmediately) void saveSystemConfiguration(next)
  }

  return <section className="management-page"><header><span>系统配置</span><h1>S7 通讯配置</h1></header><section className="settings-layout"><section className="settings-form">
    <label>PLC 地址<input value={config.host} readOnly aria-readonly="true" /></label>
    <label>端口<input value={config.port} readOnly aria-readonly="true" /></label>
    <label>CPU<input value={config.cpuType} readOnly aria-readonly="true" /></label>
    <label>Rack<input type="number" value={config.rack} readOnly aria-readonly="true" /></label>
    <label>Slot<input type="number" value={config.slot} readOnly aria-readonly="true" /></label>
    <section className="station-configuration" aria-label="工位与显示配置">
      <div className="station-configuration-head"><h2>工位与显示配置</h2><span>服务端持久化</span></div>
      {systemConfiguration ? <>
        <label className="station-config-row"><span>服务器 IP</span><input aria-label="服务器 IP" value={systemConfiguration.serverIp} placeholder="127.0.0.1" onChange={(event) => updateSystemConfiguration({ ...systemConfiguration, serverIp: event.target.value })} onBlur={() => void saveSystemConfiguration(systemConfiguration)} /></label>
        <label className="station-config-row"><span>工位号</span><input aria-label="工位号" type="number" min="1" max="40" value={systemConfiguration.stationNumber} onChange={(event) => updateSystemConfiguration({ ...systemConfiguration, stationNumber: Number(event.target.value) })} onBlur={() => void saveSystemConfiguration(systemConfiguration)} /></label>
        <label className="station-config-row"><span>最大工位数量（MaxPos）</span><input aria-label="最大工位数量" value={systemConfiguration.maxPos} readOnly aria-readonly="true" title="由 S7 标签 DB4.DBW104 读取" /></label>
        <label className="config-switch"><span className="config-switch-label"><strong>界面翻转</strong><small>保留为系统配置</small></span><input type="checkbox" checked={systemConfiguration.isInterfaceFlipped} onChange={(event) => updateSystemConfiguration({ ...systemConfiguration, isInterfaceFlipped: event.target.checked }, true)} /><span className="config-switch-track" aria-hidden="true"><span className="config-switch-thumb" /></span></label>
      </> : <p>正在加载工位配置...</p>}
      {configurationError ? <p className="s7-error">{configurationError}</p> : null}
    </section>
  </section><section className="op-row-configuration" aria-label="OP工位排位配置">
    <div className="station-configuration-head"><h2>OP工位排位配置</h2><span>右侧为上排 · 服务端持久化</span></div>
    {systemConfiguration ? <div className="op-row-grid">
      {Array.from({ length: systemConfiguration.maxPos }, (_, offset) => {
        const op = offset + 1
        const upper = systemConfiguration.opRows[String(op)] ?? op <= Math.ceil(systemConfiguration.maxPos / 2)
        return <label className="config-switch op-row-card" key={op}>
          <span className="config-switch-label"><strong>{`OP${op}`}</strong><small>{upper ? '上排' : '下排'}</small></span>
          <input type="checkbox" checked={upper} onChange={(event) => {
            const next = { ...systemConfiguration, opRows: { ...defaultOpRows(systemConfiguration.maxPos, systemConfiguration.opRows), [String(op)]: event.target.checked } }
            updateSystemConfiguration(next, true)
          }} />
          <span className="config-switch-track" aria-hidden="true"><span className="config-switch-thumb" /></span>
        </label>
      })}
    </div> : <p>正在加载工位配置...</p>}
  </section></section></section>
}

type TreeNode =
  | { kind: 'group'; key: string; name: string; count: number; children: TreeNode[] }
  | { kind: 'family'; key: string; name: string; count: number; children: S7Tag[] }
  | { kind: 'tag'; key: string; tag: S7Tag }

const FAMILY_NAME_PATTERN = /^(.*)\[[^\]]+\](?:\.[^.]+)?$/

function buildTagTree(tags: S7Tag[]): TreeNode[] {
  const compareTags = (left: S7Tag, right: S7Tag) =>
    left.name.localeCompare(right.name, undefined, { numeric: true }) || left.address.localeCompare(right.address, undefined, { numeric: true })

  return Array.from(new Set(tags.map((tag) => tag.group))).sort().map((group) => {
    const groupTags = tags.filter((tag) => tag.group === group).slice().sort(compareTags)
    const children: TreeNode[] = []
    const emittedFamilies = new Set<string>()
    for (const tag of groupTags) {
      const match = tag.name.match(FAMILY_NAME_PATTERN)
      if (!match) { children.push({ kind: 'tag', key: tag.address, tag }); continue }
      const base = match[1]
      const key = `${group}:${base}`
      if (emittedFamilies.has(key)) continue
      emittedFamilies.add(key)
      const members = groupTags.filter((candidate) => candidate.name.startsWith(`${base}[`))
      children.push({ kind: 'family', key, name: base, count: members.length, children: members })
    }
    return { kind: 'group', key: group, name: group, count: groupTags.length, children }
  })
}

function collectNodeKeys(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => node.kind === 'group' ? [node.key, ...collectNodeKeys(node.children)] : node.kind === 'family' ? [node.key] : [])
}

function S7Panel() {
  const [tags, setTags] = useState<S7Tag[]>([])
  const [error, setError] = useState('')
  const requestInFlight = useRef(false)
  const [simulationEnabled, setSimulationEnabled] = useState(false)
  const [simulationEditMode, setSimulationEditMode] = useState(false)
  const [writeError, setWriteError] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const familiesSeeded = useRef(false)

  async function readTags() {
    if (requestInFlight.current) return
    requestInFlight.current = true
    setError('')
    try {
      const response = await fetch(`${S7_API}/api/s7/tags`)
      if (!response.ok) throw new Error('S7 通讯服务不可用。')
      setTags(await response.json() as S7Tag[])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '标签读取失败。')
    } finally {
      requestInFlight.current = false
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${S7_API}/api/s7/configuration`)
        if (!response.ok) return
        const config = await response.json() as { simulation?: boolean }
        setSimulationEnabled(config.simulation === true)
      } catch {
        setSimulationEnabled(false)
      }
    })()
  }, [])

  useEffect(() => {
    const initialTimer = window.setTimeout(() => { void readTags() }, 0)
    const reconnectTimer = window.setInterval(() => void readTags(), 50)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(reconnectTimer)
    }
  }, [])

  const tree = useMemo(() => buildTagTree(tags), [tags])

  // 树形目录初次加载时默认展开分组、收起数组，保持目录紧凑。
  useEffect(() => {
    if (familiesSeeded.current || tree.length === 0) return
    familiesSeeded.current = true
    setCollapsed(new Set(tree.flatMap((group) => group.kind === 'group' ? group.children.filter((child) => child.kind === 'family').map((child) => child.key) : [])))
  }, [tree])

  const rows = useMemo(() => {
    const flattened: Array<{ node: TreeNode; depth: number }> = []
    const walk = (nodes: TreeNode[], depth: number) => {
      for (const node of nodes) {
        flattened.push({ node, depth })
        if (collapsed.has(node.key)) continue
        if (node.kind === 'group') walk(node.children, depth + 1)
        else if (node.kind === 'family') walk(node.children.map((tag) => ({ kind: 'tag', key: tag.address, tag })), depth + 1)
      }
    }
    walk(tree, 0)
    return flattened
  }, [tree, collapsed])

  function toggleNode(key: string) {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function writeSimulationTag(address: string, value: string) {
    setWriteError('')
    try {
      const updated = await putSimulationTagValue(address, value)
      setTags((current) => current.map((tag) => tag.address === address ? { ...tag, ...updated } : tag))
    } catch (reason) {
      setWriteError(reason instanceof Error ? reason.message : '模拟值写入失败。')
    }
  }

  return <section className="management-page"><header className="s7-page-header"><div><span>S7 通讯</span><h1>标签读写测试</h1></div><div className="s7-tree-actions">
    {simulationEnabled ? <button type="button" className={simulationEditMode ? 'active' : ''} onClick={() => setSimulationEditMode((current) => !current)}>{simulationEditMode ? '退出模拟输入' : '模拟输入'}</button> : null}
    <button type="button" onClick={() => setCollapsed(new Set())}>全部展开</button>
    <button type="button" onClick={() => setCollapsed(new Set(collectNodeKeys(tree)))}>全部收起</button>
  </div></header>
    {error ? <p className="s7-error">{error}</p> : null}
    {writeError ? <p className="s7-error">{writeError}</p> : null}
    <div className="s7-tree-wrap">
      <div className="s7-tree-head" role="row">
        <span>名称</span><span>地址</span><span>类型</span><span>当前值</span><span>权限</span>
      </div>
      <div className="s7-tree-body" role="tree" aria-label="S7 标签树形目录">
        {rows.map(({ node, depth }) => node.kind === 'tag'
          ? <TreeTagRow key={node.key} tag={node.tag} depth={depth} editable={simulationEnabled && simulationEditMode} onWrite={writeSimulationTag} />
          : <div key={node.key} role="treeitem" aria-expanded={!collapsed.has(node.key)} className={`s7-tree-node kind-${node.kind}`} style={{ paddingLeft: 14 + depth * 22 }}>
              <button type="button" className="s7-tree-toggle" onClick={() => toggleNode(node.key)}>
                <span className="s7-tree-caret" aria-hidden="true">{collapsed.has(node.key) ? '+' : '−'}</span>
                {node.name} <span className="s7-tree-count">({node.count})</span>
              </button>
              <span /><span /><span />
              <span className={node.kind === 'group' ? 'tag-access tag-read-only' : 'tag-access tag-read-write'}>{node.kind === 'group' ? '分组' : '数组'}</span>
            </div>)}
      </div>
    </div>
  </section>
}

function TreeTagRow({ tag, depth, editable, onWrite }: { tag: S7Tag; depth: number; editable: boolean; onWrite: (address: string, value: string) => Promise<void> }) {
  const bool = tag.dataType.toLowerCase() === 'bool'
  const readOnly = tag.access === 'ReadOnly'
  const displayAddress = tag.address.replace(/^%/, '')
  return <div role="treeitem" className="s7-tree-tag" style={{ paddingLeft: 14 + depth * 22 }}>
    <span className="s7-tree-tag-name"><span className="s7-tree-leaf" aria-hidden="true">·</span>{tag.name}</span>
    <span className="s7-address">{displayAddress}</span>
    <span className="s7-tree-type">{tag.dataType}</span>
    <span className="tag-value">{editable
      ? bool
        ? <label className="tag-toggle"><input type="checkbox" checked={tag.value === 'True'} onChange={(event) => { const next = event.target.checked ? 'True' : 'False'; void onWrite(tag.address, next) }} /><span>{tag.value}</span></label>
        : <div className="tag-write"><input key={`${tag.address}:${tag.value}`} defaultValue={tag.value} onBlur={(event) => { const next = event.currentTarget.value; if (next.trim() !== '' && next !== tag.value) void onWrite(tag.address, next) }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></div>
      : readOnly ? tag.value : bool ? <label className="tag-toggle"><input type="checkbox" checked={tag.value === 'True'} readOnly disabled /><span>{tag.value}</span></label> : <div className="tag-write"><input value={tag.value} readOnly /></div>}</span>
    <span>{editable ? <span className="tag-access tag-read-write">模拟</span> : readOnly ? <span className="tag-access tag-read-only">只读</span> : <span className="tag-access tag-read-write">读写</span>}</span>
  </div>
}
