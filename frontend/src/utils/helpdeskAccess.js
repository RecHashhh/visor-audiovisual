import { useEffect, useState } from 'react'
import { helpdeskModule } from '../config/hubModules.js'

/** Devuelve el módulo si la Mesa confirma acceso, `false` si lo niega y `null` si no se pudo consultar. */
export async function fetchHelpdeskAccess(instance, account, settings = {}, { signal, fetcher = fetch, timeoutMs = 12000 } = {}) {
  const module = helpdeskModule(settings)
  if (!account || !module) return null
  const controller = new AbortController()
  let timer
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    if (signal?.aborted) return null
    // El límite cubre MSAL y fetch; MSAL no admite AbortSignal.
    return await Promise.race([
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null) }, timeoutMs) }),
      (async () => {
        let token
        try { token = (await instance.acquireTokenSilent({ account, scopes: ['openid', 'profile', 'email'] })).idToken }
        catch { token = account.idToken }
        token ||= account.idToken
        if (!token || controller.signal.aborted) return null
        const origin = new URL(module.href).origin
        const response = await fetcher(origin + '/api/hub/visibility', { method: 'GET', headers: { Authorization: 'Bearer ' + token }, credentials: 'omit', signal: controller.signal, cache: 'no-store' })
        if (controller.signal.aborted) return null
        if (response.status === 401 || response.status === 403) return false
        if (!response.ok) return null
        const result = await response.json()
        return result.visible === true && result.href === module.href ? module : false
      })(),
    ])
  } catch { return null }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
// Caché compartida entre pestañas: un «sí» dura 12 h y un «no» 10 min. Un fallo de red nunca se guarda.
const VISIBLE_MS = 12 * 60 * 60 * 1000
const HIDDEN_MS = 10 * 60 * 1000
function readVisibility(key) {
  try {
    const hit = key && JSON.parse(localStorage.getItem(key) || 'null')
    return hit && Date.now() - hit.at < (hit.visible === true ? VISIBLE_MS : HIDDEN_MS) ? hit.visible === true : null
  } catch { return null }
}
function writeVisibility(key, visible) {
  try { if (key) localStorage.setItem(key, JSON.stringify({ at: Date.now(), visible })) } catch { /* sin almacenamiento */ }
}
/** Enlace con la cuenta del Hub (login_hint): Microsoft entra en silencio, sin selector de cuentas. */
export function withLoginHint(module, account) {
  const hint = String(account?.username || '').trim().toLowerCase()
  return module && /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(hint) ? { ...module, href: module.href + '&login_hint=' + encodeURIComponent(hint) } : module
}
export function useHelpdeskAccess(instance, account, authorization, settings = {}) {
  const entry = helpdeskModule(settings)?.href
  const identity = account?.homeAccountId || account?.localAccountId || account?.username
  // v2: descarta los «sin acceso» guardados por error durante reinicios de la Mesa.
  const key = identity && entry ? 'hub-helpdesk-v2:' + identity + ':' + entry : null
  const [visible, setVisible] = useState(() => readVisibility(key))
  const [checking, setChecking] = useState(false)
  const allowed = authorization?.allowed === true && !authorization?.degraded
  useEffect(() => {
    const controller = new AbortController()
    setVisible(readVisibility(key))
    let retry
    const check = (again) =>
      fetchHelpdeskAccess(instance, account, settings, { signal: controller.signal }).then(result => {
        if (controller.signal.aborted) return
        if (result === null) {
          // La Mesa no respondió (p. ej. se está reiniciando): un reintento y, si sigue igual, se muestra la tarjeta;
          // la propia Mesa vuelve a comprobar el acceso al entrar.
          if (again) { retry = setTimeout(() => check(false), 4000); return }
          setVisible(v => v ?? true)
          setChecking(false)
          return
        }
        setVisible(!!result)
        setChecking(false)
        writeVisibility(key, !!result)
      })
    if (allowed && account && entry) {
      setChecking(true)
      check(true)
    }
    return () => { controller.abort(); clearTimeout(retry) }
  }, [instance, key, allowed])
  const module = allowed && visible ? withLoginHint(helpdeskModule(settings), account) : null
  // Sin resultado previo se espera la respuesta para mostrar todas las tarjetas a la vez.
  return { module, pending: allowed && checking && visible === null }
}
