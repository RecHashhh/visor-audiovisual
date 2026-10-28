import test from 'node:test'
import assert from 'node:assert/strict'
import { availableModules, insuranceEntry, helpdeskEntry, helpdeskModule, treasuryEntry } from './hubModules.js'
const account = { username: 'jmorales@ripconciv.com' }
const permissions = { allowed: true, sections: '*' }
test('selector: permisos confirmados, revisión limitada y destino seguro', () => {
  assert.deepEqual(availableModules(account, permissions).map(m => m.id), ['audiovisual', 'insurance', 'treasury'])
  assert.deepEqual(availableModules({ username: 'otro@ripconciv.com' }, permissions).map(m => m.id), ['audiovisual', 'treasury'])
  assert.deepEqual(availableModules(account, { ...permissions, degraded: true }), [])
  assert.deepEqual(availableModules(account, { ...permissions, allowed: false }), [])
  assert.deepEqual(availableModules(null, permissions), [])
  assert.deepEqual(availableModules(account, permissions, { insuranceEnabled: false }).map(m => m.id), ['audiovisual', 'treasury'])
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


test('Tesorería: disponible para cualquier cuenta autorizada del Hub, con destino HTTPS configurable', () => {
  const ordinary = { username: 'persona@ripconciv.com' }
  const modules = availableModules(ordinary, { allowed: true, sections: [] })
  assert.deepEqual(modules.map(m => m.id), ['treasury'])
  assert.equal(modules[0].title, 'Tesorería')
  assert.equal(modules[0].external, true)
  assert.equal(modules[0].href, 'https://appweb-tesoreriaweb-ahend3bzcpecaffv.eastus-01.azurewebsites.net/')
  assert.equal(treasuryEntry({ treasuryUrl: 'https://tesoreria.example' }), 'https://tesoreria.example/')
  assert.deepEqual(availableModules(ordinary, { allowed: true, sections: [] }, { treasuryEnabled: false }), [])
  for (const treasuryUrl of ['http://example.com', 'javascript:alert(1)', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com/?next=bad', 'https://example.com/#bad', 'invalid']) {
    assert.equal(treasuryEntry({ treasuryUrl }), null)
    assert.deepEqual(availableModules(ordinary, { allowed: true, sections: [] }, { treasuryUrl }), [])
  }
})
