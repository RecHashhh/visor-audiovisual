import { useEffect, useState } from 'react'
import { helpdeskModule } from '../config/hubModules.js'

export async function fetchHelpdeskAccess(instance, account, settings = {}, { signal, fetcher = fetch } = {}) {
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
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null) }, 5000) }),
      (async () => {
        let token
        try { token = (await instance.acquireTokenSilent({ account, scopes: ['openid', 'profile', 'email'] })).idToken }
        catch { token = account.idToken }
        token ||= account.idToken
        if (!token || controller.signal.aborted) return null
        const origin = new URL(module.href).origin
        const response = await fetcher(origin + '/api/hub/visibility', { method: 'GET', headers: { Authorization: 'Bearer ' + token }, credentials: 'omit', signal: controller.signal, cache: 'no-store' })
        if (!response.ok || controller.signal.aborted) return null
        const result = await response.json()
        return result.visible === true && result.href === module.href ? module : null
      })(),
    ])
  } catch { return null }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
const VISIBILITY_MS = 10 * 60 * 1000
function readVisibility(key) {
  try {
    const hit = key && JSON.parse(sessionStorage.getItem(key) || 'null')
    return hit && Date.now() - hit.at < VISIBILITY_MS ? hit.visible === true : null
  } catch { return null }
}
function writeVisibility(key, visible) {
  try { if (key) sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), visible })) } catch { /* sin almacenamiento */ }
}
/** Enlace con la cuenta del Hub (login_hint): Microsoft entra en silencio, sin selector de cuentas. */
export function withLoginHint(module, account) {
  const hint = String(account?.username || '').trim().toLowerCase()
  return module && /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(hint) ? { ...module, href: module.href + '&login_hint=' + encodeURIComponent(hint) } : module
}
export function useHelpdeskAccess(instance, account, authorization, settings = {}) {
  const entry = helpdeskModule(settings)?.href
  const identity = account?.homeAccountId || account?.localAccountId || account?.username
  const key = identity && entry ? 'hub-helpdesk:' + identity + ':' + entry : null
  // Último resultado conocido (10 min, por pestaña): la tarjeta aparece al instante y se revalida detrás
  const [visible, setVisible] = useState(() => readVisibility(key))
  const allowed = authorization?.allowed === true && !authorization?.degraded
  useEffect(() => {
    const controller = new AbortController()
    setVisible(readVisibility(key))
    if (allowed && account && entry) {
      fetchHelpdeskAccess(instance, account, settings, { signal: controller.signal }).then(module => {
        if (controller.signal.aborted) return
        setVisible(!!module)
        writeVisibility(key, !!module)
      })
    }
    return () => controller.abort()
  }, [instance, key, allowed])
  return allowed && visible ? withLoginHint(helpdeskModule(settings), account) : null
}
