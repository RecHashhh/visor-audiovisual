import test from 'node:test';
import assert from 'node:assert/strict';
import { areaStatus } from './areaStatus.js';

test('áreas de Helpdesk ocultan aviso sin Excel y muestran origen', () => {
  const status = areaStatus({ hasAreas: true, areaSource: 'Helpdesk', payrollUploaded: false });
  assert.equal(status.available, true);
  assert.match(status.tooltip, /Helpdesk/);
});
test('Excel vacío no oculta el aviso y el Excel con áreas reemplaza Helpdesk', () => {
  assert.equal(areaStatus({ hasAreas: false, payrollUploaded: true }).available, false);
  assert.match(areaStatus({ hasAreas: true, areaSource: 'Excel', payrollUploaded: true }).tooltip, /Áreas: Excel/);
});
test('snapshots anteriores siguen funcionando', () => {
  assert.equal(areaStatus({ payrollUploaded: true }).available, true);
  assert.equal(areaStatus({}).available, false);
});
