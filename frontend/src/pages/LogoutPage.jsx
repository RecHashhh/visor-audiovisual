import { useEffect, useRef, useState } from 'react'
import { useMsal } from '@azure/msal-react'
import { InteractionStatus } from '@azure/msal-browser'
import { logoutLocal } from '../authConfig'

export default function LogoutPage() {
  const { inProgress } = useMsal()
  const started = useRef(false)
  const [error, setError] = useState(false)
  function exit() {
    if (started.current) return
    started.current = true
    setError(false)
    logoutLocal().catch(() => { started.current = false; setError(true) })
  }
  useEffect(() => { if (inProgress === InteractionStatus.None) exit() }, [inProgress])
  return <main className="noaccess"><div className="noaccess-card">{error ? <><h1 className="noaccess-title">No pudimos cerrar la sesión del Hub</h1><p className="noaccess-text">Intenta nuevamente para volver al inicio de sesión.</p><button className="btn btn-ghost" onClick={exit}>Reintentar</button></> : <p role="status">Cerrando sesión del Hub…</p>}</div></main>
}
