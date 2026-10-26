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
export function useHelpdeskAccess(instance, account, authorization, settings = {}) {
  const [result, setResult] = useState(null)
  const entry = helpdeskModule(settings)?.href
  const identity = account?.homeAccountId || account?.localAccountId || account?.username
  const allowed = authorization?.allowed === true && !authorization?.degraded
  useEffect(() => {
    const controller = new AbortController()
    setResult(null)
    if (allowed && account && entry) {
      fetchHelpdeskAccess(instance, account, settings, { signal: controller.signal }).then(module => {
        if (!controller.signal.aborted) setResult({ identity, entry, module })
      })
    }
    return () => controller.abort()
  }, [instance, identity, entry, allowed])
  return allowed && result?.identity === identity && result?.entry === entry ? result.module : null
}
