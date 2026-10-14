import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useMsal } from '@azure/msal-react'
import { useAuthz } from '../utils/authz'
import { requestLogout } from '../authConfig'
import { availableModules } from '../config/hubModules'
import './ModulesPage.css'

export default function ModulesPage() {
  const { accounts, instance } = useMsal()
  const { me, loading, refresh } = useAuthz()
  // Same opt-in preview as RequireAuth; eliminated from production builds.
  const preview = import.meta.env.DEV && localStorage.getItem('ripcon-dev-preview') === '1' ? { username: me?.email || 'preview@ripconciv.com', name: 'Vista de desarrollo' } : null
  const account = instance.getActiveAccount() || accounts[0] || preview
  const settings = window.__APP_CONFIG__?.hubModules || {}
  const modules = availableModules(account, me, settings)
  useEffect(() => { document.title = 'RIPCONCIV · Hub corporativo' }, [])
  return <div className="hub-selector">
    <a className="hub-skip" href="#hub-modules">Ir a los módulos</a>
    <header className="hub-header"><div className="hub-brand"><img className="only-light" src="/brands/ripconciv/centrada-positivo-azul.png" alt="RIPCONCIV" /><img className="only-dark" src="/brands/ripconciv/centrada-blanco.png" alt="RIPCONCIV" /><span>Hub corporativo</span></div><div className="hub-account"><span>{account?.name || account?.username}</span><button className="btn btn-ghost" onClick={requestLogout}>Cerrar sesión</button></div></header>
    <main id="hub-modules" className="hub-main" tabIndex={-1}><div className="hub-intro"><span className="hub-eyebrow">TU ESPACIO DE TRABAJO</span><h1>¿A qué módulo deseas ingresar?</h1><p>Elige una herramienta para continuar con tu cuenta corporativa.</p></div>
      {loading ? <div className="hub-message" role="status">Verificando tus accesos…</div> : me?.degraded ? <div className="hub-message" role="alert"><h2>No pudimos verificar tus accesos</h2><p>Intenta nuevamente para cargar tus módulos.</p><button className="btn btn-ghost" onClick={refresh}>Reintentar</button></div> : modules.length ? <div className="hub-grid">{modules.map(module => { const insurance = module.id === 'insurance'; const content = <><div className="hub-module-art"><img src={insurance ? '/module-art/seguros.png' : '/module-art/audiovisual.png'} alt="" width="1536" height="1024" decoding="async" /></div><div className="hub-module-body"><h2>{module.title}</h2><p>{module.description}</p><span className="hub-module-action">{insurance ? 'Ingresar a Seguros' : 'Ingresar a Audiovisual'} <span aria-hidden="true">→</span></span></div></>; return module.external ? <a key={module.id} className="hub-module" href={module.href}>{content}</a> : <Link key={module.id} className="hub-module" to={module.href}>{content}</Link> })}</div> : <div className="hub-message"><h2>No tienes módulos habilitados</h2><p>Solicita al administrador del Hub que revise los permisos de tu cuenta.</p></div>}
      <p className="hub-footnote">Cada módulo muestra la información autorizada para tu cuenta.</p>
    </main>
  </div>
}
