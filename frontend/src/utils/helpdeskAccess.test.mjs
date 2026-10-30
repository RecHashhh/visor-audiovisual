import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchHelpdeskAccess } from './helpdeskAccess.js'
import { helpdeskEntry } from '../config/hubModules.js'
const account = { homeAccountId: 'a', idToken: 'cached-id-token' }
const msal = { acquireTokenSilent: async () => ({ idToken: 'silent-id-token', accessToken: 'do-not-use' }) }
const good = { ok: true, json: async () => ({ visible: true, href: helpdeskEntry() }) }
test('Mesa usa ID token sin credenciales y permite solo destino esperado', async () => {
  const card = await fetchHelpdeskAccess(msal, account, {}, { fetcher: async (url, options) => {
    assert.equal(url, 'https://help.ripconciv.com/api/hub/visibility')
    assert.equal(options.headers.Authorization, 'Bearer silent-id-token')
    assert.equal(options.credentials, 'omit')
    return good
  } })
  assert.equal(card.id, 'helpdesk')
})
test('Mesa distingue denegación (false) de fallo de red (null) y nunca muestra un destino ajeno', async () => {
  for (const fetcher of [async () => { throw Error('offline') }, async () => ({ ok: false, status: 503 })]) {
    assert.equal(await fetchHelpdeskAccess(msal, account, {}, { fetcher }), null)
  }
  for (const fetcher of [async () => ({ ok: false, status: 401 }), async () => ({ ok: true, json: async () => ({ visible: false }) }), async () => ({ ok: true, json: async () => ({ visible: true, href: 'https://other.example' }) })]) {
    assert.equal(await fetchHelpdeskAccess(msal, account, {}, { fetcher }), false)
  }
  assert.equal(await fetchHelpdeskAccess(msal, account, { helpdeskEnabled: false }, { fetcher: async () => { throw Error('must not call') } }), null)
})
test('Mesa admite idToken de cuenta si MSAL silencioso falla', async () => {
  assert.equal((await fetchHelpdeskAccess({ acquireTokenSilent: async () => { throw Error('interaction') } }, account, {}, { fetcher: async (_, options) => { assert.equal(options.headers.Authorization, 'Bearer cached-id-token'); return good } })).id, 'helpdesk')
})
test('Mesa respeta el límite de espera incluso si MSAL no responde', async () => {
  const start = Date.now()
  assert.equal(await fetchHelpdeskAccess({ acquireTokenSilent: () => new Promise(() => {}) }, account, {}, { timeoutMs: 300 }), null)
  assert.ok(Date.now() - start < 1300)
})

test('login_hint: añade la cuenta del Hub al enlace solo si es un correo válido', async () => {
  const { withLoginHint } = await import('./helpdeskAccess.js')
  const module = { id: 'helpdesk', href: 'https://mesa.example/api/auth/microsoft/start?entry=hub' }
  assert.equal(withLoginHint(module, { username: 'AGarzon@ripconciv.com' }).href, module.href + '&login_hint=agarzon%40ripconciv.com')
  assert.equal(withLoginHint(module, { username: 'sin correo' }).href, module.href)
  assert.equal(withLoginHint(module, undefined).href, module.href)
  assert.equal(withLoginHint(null, { username: 'a@b.c' }), null)
})
