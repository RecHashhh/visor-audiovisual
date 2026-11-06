"""Bloques agregados a Hardware: proveedores, durabilidad, licencias y centros de costo (sin red)."""
import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import hardware_snapshot as hw


def item(id, type='LAPTOP', bought='2022-01-15', ruc='', value=1000, active=True, ced=''):
    return {'id': id, 'type': type, 'purchaseDate': bought, 'year': hw.purchase_year(bought), 'supplierRuc': ruc,
            'value': value, 'active': active, 'cedula': ced}


class ExtrasTests(unittest.TestCase):
    def test_proveedor_con_nombre_de_s10_y_sin_factura(self):
        rows = hw.supplier_block([item('a', ruc='0991402160001'), item('b', ruc='N/A'), item('c', ruc='')],
                                 [{'ruc': '0991402160001', 'name': 'REDCOMPUT S.A.'}])
        names = {r['supplier']: r['count'] for r in rows}
        self.assertEqual(names, {'REDCOMPUT S.A.': 1, 'Sin factura en RIP_TIC': 2})

    def test_durabilidad_omite_sin_fecha_y_anio_2000(self):
        items = [item('a', bought='2020-01-01'), item('b', bought='2000-01-01'), item('c', bought=None)]
        disposals = [{'itemId': 'a', 'date': '2024-01-01', 'reason': 'Daño'}, {'itemId': 'b', 'date': '2024-01-01'}, {'itemId': 'c', 'date': '2024-01-01'}]
        block = hw.durability_block(items, disposals, date(2026, 11, 6))
        self.assertEqual(block['byType'][0]['count'], 1)
        self.assertAlmostEqual(block['byType'][0]['medianMonths'] / 12, 4.0, delta=0.05)
        self.assertEqual(block['byReason'][0]['reason'], 'Daño')

    def test_antiguedad_del_parque(self):
        block = hw.durability_block([item('a', bought='2026-03-01'), item('b', bought='2019-01-01'), item('c', bought='2000-01-01')], [], date(2026, 11, 6))
        fleet = {r['bucket']: r['LAPTOP'] for r in block['fleetAge']}
        self.assertEqual((fleet['< 1 año'], fleet['5+ años'], fleet['sin fecha']), (1, 1, 1))

    def test_licencias_compradas_asignadas_y_en_cuentas_bloqueadas(self):
        skus = [{'skuId': 's1', 'skuPartNumber': 'SPB', 'prepaidUnits': {'enabled': 10}, 'consumedUnits': 7}]
        users = [{'userPrincipalName': 'X@ripconciv.com', 'accountEnabled': False, 'assignedLicenses': [{'skuId': 's1'}]},
                 {'userPrincipalName': 'y@ripconciv.com', 'accountEnabled': True, 'assignedLicenses': [{'skuId': 's1'}]}]
        block = hw.license_block(users, skus, [{'licenses': ['Microsoft 365 Empresa Premium']}])
        row = block['bySku'][0]
        self.assertEqual((row['purchased'], row['assigned'], row['available'], row['blockedAccounts'], row['targetPeople']), (10, 7, 3, 1, 1))
        self.assertEqual(block['blockedWithLicense'][0]['account'], 'x@ripconciv.com')

    def test_centro_de_costo_coincide_distinto_y_sin_registro(self):
        c1, c2, c3, out = '0912345671', '0912345672', '0912345673', '0912345679'
        people = {c: {'name': c, 'area': 'TECNICO', 'project': {'code': '4767', 'name': 'LOJA-Villonaco III'}} for c in (c1, c2, c3)}
        mesa = {'custodians': [{'cedula': c1, 'costCenter': '4767-LOJA-Villonaco III-G'}, {'cedula': c2, 'costCenter': '4506-GYE-Monay'}],
                'assignments': [{'cedula': c1, 'projectCode': '33015'}, {'cedula': c2, 'projectCode': '33015'}, {'cedula': out, 'projectCode': '33015'}]}
        items = [item('a', ced=c1), item('b', ced=c2), item('c', ced=c3)]
        block = hw.cost_center_block(people, items, mesa)
        self.assertEqual(block['counts'], {'coincide': 1, 'distinto': 1, 'sin_registro_ti': 1})
        eq = block['equivalences'][0]
        self.assertEqual((eq['tiCode'], eq['thProject'], eq['share'], eq['outsidePayroll']), ('33015', '4767 · LOJA-Villonaco III', 100, 1))


if __name__ == '__main__':
    unittest.main()
