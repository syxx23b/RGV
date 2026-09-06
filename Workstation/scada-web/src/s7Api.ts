// Each workstation owns its S7 process; the default is the local workstation API.
export const S7_API = import.meta.env.VITE_S7_API ?? 'http://127.0.0.1:9104'

export type TwinLayoutState = {
  schemaVersion: number
  carRelativeX: number
  stationRelativeX: Record<string, number>
}

export async function postS7Command(command: string, payload: { stationIndex?: number; direction?: string; active?: boolean } = {}) {
  const response = await fetch(`${S7_API}/api/s7/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, active: true, ...payload }),
  })
  if (!response.ok) throw new Error((await response.text()) || 'S7 控制命令执行失败。')
  return response.json()
}

export async function readTwinLayoutState() {
  const response = await fetch(`${S7_API}/api/twin/layout`)
  if (response.status === 404) return null
  if (!response.ok) throw new Error((await response.text()) || '数字孪生布局读取失败。')
  return response.json() as Promise<TwinLayoutState>
}

export async function saveTwinLayoutState(layout: TwinLayoutState) {
  const response = await fetch(`${S7_API}/api/twin/layout`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(layout),
  })
  if (!response.ok) throw new Error((await response.text()) || '数字孪生布局保存失败。')
  return response.json() as Promise<TwinLayoutState>
}

export async function putSimulationTagValue(address: string, value: string) {
  const response = await fetch(`${S7_API}/api/s7/simulation/tags/${encodeURIComponent(address)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  })
  if (!response.ok) throw new Error((await response.text()) || '模拟标签写入失败。')
  return response.json()
}
