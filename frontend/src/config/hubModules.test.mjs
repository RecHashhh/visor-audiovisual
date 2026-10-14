import test from 'node:test'
import assert from 'node:assert/strict'
import { availableModules, insuranceEntry } from './hubModules.js'
const account = { username: 'jmorales@ripconciv.com' }
const permissions = { allowed: true, sections: '*' }
test('selector: permisos confirmados, revisión limitada y destino seguro', () => {
  assert.deepEqual(availableModules(account, permissions).map(m => m.id), ['audiovisual', 'insurance'])
  assert.deepEqual(availableModules({ username: 'otro@ripconciv.com' }, permissions).map(m => m.id), ['audiovisual'])
  assert.deepEqual(availableModules(account, { ...permissions, degraded: true }), [])
  assert.deepEqual(availableModules(account, { ...permissions, allowed: false }), [])
  assert.deepEqual(availableModules(null, permissions), [])
  assert.deepEqual(availableModules(account, permissions, { insuranceEnabled: false }).map(m => m.id), ['audiovisual'])
  assert.equal(insuranceEntry({ insuranceUrl: 'javascript:alert(1)' }), null)
  assert.equal(insuranceEntry({ insuranceUrl: 'https://user:password@example.com' }), null)
  assert.equal(insuranceEntry({ insuranceUrl: 'https://example.com/?redirect=bad' }), null)
  const william = { username: 'william@ripconciv.com', idTokenClaims: { oid: '46107a85-cfda-45fb-a058-ff32f1d8e9c9' } }
  assert.ok(availableModules(william, permissions).some(m => m.id === 'insurance'))
  assert.match(insuranceEntry(), /\/api\/auth\/microsoft\/start\?entry=hub$/)
})
