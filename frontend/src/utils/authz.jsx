// src/utils/authz.jsx
// Contexto de permisos: consulta /api/me una vez por sesión y expone helpers
// para que el shell, las rutas y las páginas decidan qué mostrar/permitir.
import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { useMsal } from '@azure/msal-react'
import { api } from './api'

// Última respuesta de /api/me por cuenta y por pestaña (10 min): los módulos aparecen al instante y se
// confirman con el servidor en segundo plano. Solo presentación: el servidor sigue autorizando cada petición.
const CACHE_MS = 10 * 60 * 1000
const cacheKey = account => account ? 'hub-authz:' + (account.homeAccountId || account.localAccountId || account.username) : null
function readCache(key) {
  try {
    const hit = key && JSON.parse(sessionStorage.getItem(key) || 'null')
    return hit && Date.now() - hit.at < CACHE_MS && hit.data?.allowed !== undefined ? hit.data : null
  } catch { return null }
}
function writeCache(key, data) {
  try { if (key) data?.degraded ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), data })) } catch { /* sin almacenamiento */ }
}

// Sin confirmación del servidor no mostramos contenido ni acciones autorizadas.
const DEGRADED = {
  allowed: false, role: null, isAdmin: false, isManager: false,
  caps: {}, sections: [], scopes: {}, degraded: true,
}

const AuthzContext = createContext(null)

export function AuthzProvider({ children }) {
  const { instance, accounts } = useMsal()
  const key = cacheKey(instance.getActiveAccount() || accounts[0])
  const [me, setMe] = useState(() => readCache(key))
  const [loading, setLoading] = useState(() => !readCache(key))

  const refresh = useCallback(() => {
    // Con caché, se revalida sin volver a mostrar «Verificando tus accesos…»
    if (!readCache(key)) setLoading(true)
    return api.getMe()
      .then(data => { setMe(data); writeCache(key, data) })
      .catch(() => { setMe(DEGRADED); writeCache(key, DEGRADED) })
      .finally(() => setLoading(false))
  }, [key])

  useEffect(() => { refresh() }, [refresh])

  return (
    <AuthzContext.Provider value={{ me, loading, refresh }}>
      {children}
    </AuthzContext.Provider>
  )
}

export function useAuthz() {
  return useContext(AuthzContext) || { me: DEGRADED, loading: false, refresh: () => {} }
}

// ── Helpers de permiso ──────────────────────────────────────────────────────
export function hasCap(me, cap) {
  return Boolean(me && me.allowed !== false && me.caps && me.caps[cap])
}

export function canSection(me, sectionId) {
  if (!me || me.allowed === false) return false
  // La visibilidad la gobiernan sections/scopes aunque el usuario pueda subir
  // (isManager): así un operador/personalizado se puede limitar por sección.
  if (me.sections === '*') return true
  return Array.isArray(me.sections) && me.sections.includes(sectionId)
}

// ¿Puede ver un ítem concreto (proyecto, carpeta de marca…) dentro de una sección?
export function canItem(me, sectionId, itemId) {
  if (!canSection(me, sectionId)) return false
  const scope = me.scopes && me.scopes[sectionId]
  if (!scope || !Array.isArray(scope) || scope.length === 0) return true
  return scope.includes(itemId)
}

function AccessDenied({ title, text }) {
  return (
    <div className="coming-soon">
      <h1 className="coming-soon-title">{title}</h1>
      <p className="coming-soon-text">{text}</p>
    </div>
  )
}

export function RequireSection({ section, children }) {
  const { me, loading } = useAuthz()
  if (loading) return <div className="loading"><div className="spinner" /></div>
  if (!canSection(me, section)) {
    return <AccessDenied
      title="Sin acceso a esta sección"
      text="Tu cuenta no tiene permisos para ver este contenido. Pídeselo a quien administra el hub." />
  }
  return children
}

export function RequireCap({ cap, children }) {
  const { me, loading } = useAuthz()
  if (loading) return <div className="loading"><div className="spinner" /></div>
  if (!hasCap(me, cap)) {
    return <AccessDenied
      title="Sin permiso para esta acción"
      text="Tu cuenta no tiene esta capacidad habilitada. Pídeselo a quien administra el hub." />
  }
  return children
}

// Retrocompatibilidad: RequireAdmin ahora exige la capacidad de gestionar accesos.
export function RequireAdmin({ children }) {
  return <RequireCap cap="manageAccess">{children}</RequireCap>
}
