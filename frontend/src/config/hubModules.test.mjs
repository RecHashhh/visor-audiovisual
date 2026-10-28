import test from 'node:test'
import assert from 'node:assert/strict'
import { availableModules, insuranceEntry, helpdeskEntry, helpdeskModule } from './hubModules.js'
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

test('Mesa: origen HTTPS y módulo configurable', () => {
  assert.equal(helpdeskEntry(), 'https://help.ripconciv.com/api/auth/microsoft/start?entry=hub')
  assert.equal(helpdeskModule().id, 'helpdesk')
  assert.equal(helpdeskModule({ helpdeskEnabled: false }), null)
  assert.equal(helpdeskEntry({ helpdeskUrl: 'https://mesa.example/' }), 'https://mesa.example/api/auth/microsoft/start?entry=hub')
  for (const url of ['http://mesa.example', 'javascript:alert(1)', 'https://user:pass@mesa.example', 'https://mesa.example/path', 'https://mesa.example/?next=bad', 'https://mesa.example/#bad', 'invalid']) {
    assert.equal(helpdeskEntry({ helpdeskUrl: url }), null)
    assert.equal(helpdeskModule({ helpdeskUrl: url }), null)
  }
})
