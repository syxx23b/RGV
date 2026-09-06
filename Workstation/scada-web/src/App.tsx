import { DigitalTwinModule } from './DigitalTwinModule'
import { AdminLogin, ManagementApp } from './ManagementApp'
import { WallboardApp } from './OriginalWallboard'
import { useState } from 'react'

export default function App() {
  const [mode, setMode] = useState<'wallboard' | 'login' | 'management'>('wallboard')
  const [session, setSession] = useState<{ username: string } | null>(null)

  if (window.location.pathname.startsWith('/digital-twin')) return <DigitalTwinModule />
  if (mode === 'login') return <AdminLogin onLogin={(next) => { setSession(next); setMode('management') }} onBack={() => setMode('wallboard')} />
  if (mode === 'management' && session) return <ManagementApp session={session} onExit={() => { setSession(null); setMode('wallboard') }} />
  return <div className="wallboard-entry"><WallboardApp onExit={() => setMode('login')} /></div>
}
