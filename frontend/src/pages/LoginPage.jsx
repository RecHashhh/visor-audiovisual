// src/pages/LoginPage.jsx
import { useMsal, useIsAuthenticated } from '@azure/msal-react'
import { Navigate } from 'react-router-dom'
import { loginRequest } from '../authConfig'

export default function LoginPage() {
  const { instance } = useMsal()
  const isAuth = useIsAuthenticated()
  if (isAuth) return <Navigate to="/" replace />

  return (
    <div className="login-screen" style={{ gridColumn: '1/-1', gridRow: '1/-1', margin: '-28px' }}>
      <div className="login-card">
        <div className="login-logo">VISOR</div>
        <div style={{ fontSize: '0.65rem', letterSpacing: '0.2em', color: 'var(--text-dim)', marginBottom: '4px', fontFamily: 'var(--font-mono)' }}>
          AUDIOVISUAL · AZURE BLOB STORAGE
        </div>
        <div className="login-subtitle">
          Plataforma de visualización de proyectos audiovisuales
        </div>

        <button
          className="login-btn"
          onClick={() => instance.loginRedirect(loginRequest)}
        >
          <MsIcon />
          Iniciar sesión con Microsoft
        </button>

        <div className="login-note">
          Solo usuarios con cuenta corporativa Microsoft 365 pueden acceder
        </div>
      </div>
    </div>
  )
}

function MsIcon() {
  return (
    <svg className="ms-logo" viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
      <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
      <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
    </svg>
  )
}
