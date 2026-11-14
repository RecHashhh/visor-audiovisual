"""Clasificación del Helpdesk y reemplazo por Excel; solo datos sintéticos."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hardware_snapshot import build_snapshot, project


class HardwareAreaTests(unittest.TestCase):
    def mesa(self):
        return {
            'areas': [{'name': 'Técnico', 'countsForCoverage': True}, {'name': 'Pasantes', 'countsForCoverage': True}, {'name': 'Obrero', 'countsForCoverage': False}, {'name': 'Área nueva', 'countsForCoverage': True}],
            'payroll': [{'cedula': '0000000001', 'name': 'Persona sintética', 'position': 'Pasante TIC', 'area': 'Pasantes', 'areaSource': 'cargo', 'costCenter': '123-Proyecto sintético'},
                        {'cedula': '0000000002', 'name': 'Otra persona sintética', 'area': 'Área nueva', 'costCenter': '123-Proyecto sintético'}],
            'items': [{'id': 'l1', 'type': 'LAPTOP', 'code': 'L1', 'active': True, 'value': 100}],
            'assignments': [{'itemId': 'l1', 'cedula': '0000000001'}],
        }

    def test_helpdesk_populates_equipment_coverage_and_cost_centers(self):
        snapshot = build_snapshot(self.mesa(), target_areas=['Obrero'])
        self.assertFalse(snapshot['payrollUploaded'])
        self.assertTrue(snapshot['hasAreas'])
        self.assertEqual(snapshot['areaSource'], 'Helpdesk')
        self.assertEqual(snapshot['kpis']['targetPeople'], 2)
        self.assertEqual(snapshot['items'][0]['area'], 'PASANTES')
        people = snapshot['coverage']['people']
        self.assertEqual(people[0]['position'], 'Pasante TIC')
        self.assertEqual(people[0]['areaSource'], 'cargo')
        self.assertEqual(next(r['count'] for r in snapshot['laptopsByArea'] if r['area'] == 'PASANTES'), 1)
        self.assertIn('AREA NUEVA', [p['area'] for p in people])
        self.assertIn('PASANTES', str(snapshot['costCenters']))

    def test_excel_replaces_helpdesk_even_when_empty(self):
        excel = [{'cedula': '0000000001', 'area': 'Obrero', 'name': 'Persona sintética', 'project': project('123-Proyecto sintético')}]
        snapshot = build_snapshot(self.mesa(), excel)
        self.assertEqual(snapshot['kpis']['targetPeople'], 0)
        self.assertEqual(snapshot['items'][0]['area'], 'OBRERO')
        self.assertEqual(snapshot['areaSource'], 'Excel')
        self.assertTrue(snapshot['hasAreas'])
        self.assertFalse(build_snapshot(self.mesa(), [])['hasAreas'])

    def test_no_targets_and_unknown_area_do_not_restore_fixed_coverage(self):
        mesa = self.mesa()
        mesa['areas'] = [{'name': 'Pasantes', 'countsForCoverage': False}]
        snapshot = build_snapshot(mesa)
        self.assertEqual(snapshot['coverage']['people'], [])
        self.assertTrue(snapshot['hasAreas'])
        mesa['areas'] = []
        snapshot = build_snapshot(mesa)
        self.assertFalse(snapshot['hasAreas'])
        self.assertEqual(snapshot['coverage']['byArea'], [])

    def test_old_snapshot_uses_environment_then_defaults_and_validates_names(self):
        mesa = self.mesa()
        del mesa['areas']
        self.assertEqual(build_snapshot(mesa)['kpis']['targetPeople'], 1)
        self.assertEqual(build_snapshot(mesa, target_areas=['Obrero', 'Área inventada'])['kpis']['targetPeople'], 0)
        for row in mesa['payroll']:
            row.pop('area')
        self.assertFalse(build_snapshot(mesa)['hasAreas'])


if __name__ == '__main__':
    unittest.main()
