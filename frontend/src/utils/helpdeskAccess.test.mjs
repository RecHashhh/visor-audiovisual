import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchHelpdeskAccess } from './helpdeskAccess.js'
import { helpdeskEntry } from '../config/hubModules.js'
const account = { homeAccountId: 'a', idToken: 'cached-id-token' }
const msal = { acquireTokenSilent: async () => ({ idToken: 'silent-id-token', accessToken: 'do-not-use' }) }
const good = { ok: true, json: async () => ({ visible: true, href: helpdeskEntry() }) }
test('Mesa usa ID token sin credenciales y permite solo destino esperado', async () => {
  const card = await fetchHelpdeskAccess(msal, account, {}, { fetcher: async (url, options) => {
    assert.equal(url, 'https://app-rpc-helpdeskweb.azurewebsites.net/api/hub/visibility')
    assert.equal(options.headers.Authorization, 'Bearer silent-id-token')
    assert.equal(options.credentials, 'omit')
    return good
  } })
  assert.equal(card.id, 'helpdesk')
})
test('Mesa falla cerrada ante errores, denegación, destino ajeno o módulo deshabilitado', async () => {
  for (const fetcher of [async () => { throw Error('offline') }, async () => ({ ok: false }), async () => ({ ok: true, json: async () => ({ visible: false }) }), async () => ({ ok: true, json: async () => ({ visible: true, href: 'https://other.example' }) })]) {
    assert.equal(await fetchHelpdeskAccess(msal, account, {}, { fetcher }), null)
  }
  assert.equal(await fetchHelpdeskAccess(msal, account, { helpdeskEnabled: false }, { fetcher: async () => { throw Error('must not call') } }), null)
})
test('Mesa admite idToken de cuenta si MSAL silencioso falla', async () => {
  assert.equal((await fetchHelpdeskAccess({ acquireTokenSilent: async () => { throw Error('interaction') } }, account, {}, { fetcher: async (_, options) => { assert.equal(options.headers.Authorization, 'Bearer cached-id-token'); return good } })).id, 'helpdesk')
})
test('Mesa limita a cinco segundos incluso si MSAL no responde', async () => {
  const start = Date.now()
  assert.equal(await fetchHelpdeskAccess({ acquireTokenSilent: () => new Promise(() => {}) }, account), null)
  assert.ok(Date.now() - start < 6000)
})
