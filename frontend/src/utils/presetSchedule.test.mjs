import test from 'node:test'
import assert from 'node:assert/strict'
import { workingHours, nextEvening, countdown, largeAnalysis, orderPresets } from './presetSchedule.mjs'

test('horario Ecuador con límites y fin de semana, independiente de la zona del equipo', () => {
  for (const [iso, expected] of [
    ['2026-11-06T12:59:59Z', false], ['2026-11-06T13:00:00Z', true],
    ['2026-11-06T22:59:59Z', true], ['2026-11-06T23:00:00Z', false],
    ['2026-11-07T15:00:00Z', false], ['2026-11-08T15:00:00Z', false],
    ['2026-11-09T13:00:00Z', true],
  ]) assert.equal(workingHours(Date.parse(iso)), expected, iso)
})

test('programa las 18:00 de Ecuador y muestra cuenta regresiva', () => {
  const at = Date.parse('2026-11-06T21:48:00Z')
  assert.equal(new Date(nextEvening(at)).toISOString(), '2026-11-06T23:00:00.000Z')
  assert.equal(countdown(nextEvening(at), at), 'Empieza en 1 h 12 min')
  assert.equal(countdown(at, at + 1), 'Empieza en 0 h 0 min')
})

test('umbrales estrictos y orden por bytes conocidos con desconocidos al final', () => {
  assert.equal(largeAnalysis({ nuevos: 2000, bytesNuevos: 20 * 1024 ** 3 }), false)
  assert.equal(largeAnalysis({ nuevos: 2001, bytesNuevos: 0 }), true)
  assert.equal(largeAnalysis({ nuevos: 1, bytesNuevos: 20 * 1024 ** 3 + 1 }), true)
  const rows = [{ id: 'sin' }, { id: 'mayor', lastAnalysis: { bytesNuevos: 200 } },
    { id: 'menor', lastAnalysis: { bytesNuevos: 0 } }, { id: 'sin2' }]
  assert.deepEqual(orderPresets(rows).map(p => p.id), ['menor', 'mayor', 'sin', 'sin2'])
  assert.equal(rows[0].id, 'sin')
})
