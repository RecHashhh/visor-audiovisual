"""Sede, seguros, catálogo único de proyectos y entregas que agrega la Mesa (datos opcionales)."""
import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hardware_snapshot import build_snapshot  # noqa: E402

BASE = {
    'items': [{'id': 1, 'code': 'L1', 'type': 'LAPTOP', 'value': 900, 'active': True},
              {'id': 2, 'code': 'l2', 'type': 'LAPTOP', 'value': 700, 'active': True}],
    'assignments': [{'itemId': 1, 'cedula': '0123456789', 'projectName': 'x'},
                    {'itemId': 2, 'cedula': '', 'projectName': '448 GYE-Adm.Financ.-TIC'}],
    'payroll': [{'cedula': '0123456789', 'costCenter': '4767-Loja', 'site': 'Loja', 'siteKind': 'Proyecto', 'city': 'Loja'}],
}


class MesaExtrasTest(unittest.TestCase):
    def test_without_extras_keeps_previous_shape(self):
        mesa = {**BASE, 'payroll': [{'cedula': '0123456789', 'costCenter': '4767-Loja'}]}
        snapshot = build_snapshot(mesa, None, today=date(2026, 11, 7))
        self.assertEqual(snapshot['deliveries'], [])
        self.assertIsNone(snapshot['items'][0]['site'])
        self.assertNotIn('insurer', snapshot['items'][0])

    def test_site_policy_catalog_and_deliveries(self):
        mesa = {**BASE,
                'insurance': [{'itemCode': 'L2', 'insurer': 'Vieja', 'to': '2025-05-01', 'insuredValue': 1},
                              {'itemCode': 'L2', 'insurer': 'Aseguradora', 'policy': 'P-9', 'from': '2025-12-17', 'to': '2026-12-17', 'insuredValue': '650.5'}],
                'sites': [{'code': '448', 'name': 'Oficina Guayaquil', 'kind': 'Oficina', 'aliases': ['GYE-Adm.Financ.-TIC']}],
                'deliveries': [{'ticketId': 'T1', 'createdAt': '2026-10-01T10:00:00', 'deliveredAt': '2026-10-11', 'state': 'Entregado', 'itemType': 'Laptop'},
                               {'ticketId': 'T2', 'createdAt': '2026-11-01', 'state': None, 'itemType': None}]}
        snapshot = build_snapshot(mesa, None, today=date(2026, 11, 7))
        first, second = snapshot['items']
        self.assertEqual((first['site'], first['city']), ('Loja', 'Loja'))
        self.assertEqual((second['insurer'], second['policy'], second['insuredTo'], second['insuredValue']), ('Aseguradora', 'P-9', '2026-12-17', 650.5))
        self.assertEqual(second['project'], {'code': '448', 'name': 'Oficina Guayaquil', 'homologated': True})
        self.assertEqual(snapshot['quality']['unmatchedProjects'], [{'project': 'x', 'count': 1}])
        self.assertEqual([(d['state'], d['itemType'], d['deliveryDays']) for d in snapshot['deliveries']],
                         [('Entregado', 'LAPTOP', 10), ('Pendiente', 'SIN TIPO', None)])


if __name__ == '__main__':
    unittest.main()
