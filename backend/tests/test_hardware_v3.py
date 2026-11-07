"""Reglas puras y contratos de los datos nuevos de Hardware."""
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hardware_v3 import computer_state, last_sign_in, license_accounts, LICENSE_PRICES
from hardware_snapshot import build_snapshot, prepare_equipment
from hardware_preferences import validate_settings
from hardware_service import fetch_graph


class HardwareV3Tests(unittest.TestCase):
    def test_state_priority(self):
        base = {'cedula': '1', 'inPayroll': True, 'usage': 'Backup / Stock disponible'}
        self.assertEqual(computer_state({**base, 'physicalState': 'En reparación'}), 'En reparación')
        self.assertEqual(computer_state({**base, 'physicalState': 'Con fallas'}), 'Con fallas')
        self.assertEqual(computer_state(base), 'Backup / stock')
        self.assertEqual(computer_state({**base, 'usage': None}), 'En uso')
        self.assertEqual(computer_state({'cedula': '1'}), 'Asignada a persona fuera de nómina')
        self.assertEqual(computer_state({}), 'Sin asignar (bodega)')

    def test_current_assignment_and_departed_payroll(self):
        mesa = {'items': [{'id': 1, 'type': 'LAPTOP', 'active': True, 'physicalState': 'Con fallas',
                           'warrantyUntil': '2027-01-01', 'physicalStateDate': '2026-01-01'}],
                'assignments': [{'itemId': 1, 'cedula': '1', 'date': '2026-01-01', 'usage': 'Uso empresarial'},
                                {'itemId': 1, 'cedula': '2', 'date': '2026-03-01', 'usage': 'Envío a reparación/revisión técnica', 'usageDate': '2026-03-02'}]}
        row = prepare_equipment(mesa, {})[0]
        self.assertEqual(row['usageDate'], '2026-03-02')
        self.assertEqual(row['warrantyUntil'], '2027-01-01')
        self.assertEqual(build_snapshot(mesa, payroll=[])['items'][0]['equipmentState'], 'En reparación')

    def test_last_sign_in_and_alias_cross(self):
        activity = {'lastSignInDateTime': '2026-01-01T00:00:00Z',
                    'lastNonInteractiveSignInDateTime': '2026-03-01T00:00:00Z',
                    'lastSuccessfulSignInDateTime': '2026-02-01T00:00:00Z'}
        self.assertTrue(last_sign_in(activity).startswith('2026-03-01'))
        self.assertIsNone(last_sign_in({'lastSignInDateTime': 'inválida'}))
        rows = license_accounts([{'userPrincipalName': 'a@b', 'proxyAddresses': ['SMTP:Alias@b'],
                                  'usageLocation': 'EC', 'assignedLicenses': [{'skuId': '1'}], 'signInActivity': activity}],
                                [{'skuId': '1', 'skuPartNumber': 'SPB'}], {'alias@b': {'name': 'Ana'}})
        self.assertEqual(rows[0]['name'], 'Ana')
        self.assertEqual(rows[0]['skus'], ['SPB'])
        self.assertEqual(rows[0]['usageLocation'], 'EC')
        self.assertEqual(rows[0]['area'], 'Sin cruce con nómina EC')

    def test_prices_validation(self):
        self.assertEqual(validate_settings({'excludedPositions': [], 'licensePrices': {'SPB': 25}})['licensePrices']['SPB'], 25)
        self.assertEqual(LICENSE_PRICES['FLOW_FREE'], 0)
        for value in [-1, True, float('nan'), float('inf'), '22']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_settings({'excludedPositions': [], 'licensePrices': {'SPB': value}})

    def test_graph_retry_without_sign_in(self):
        failed = Mock(ok=False)
        users = Mock(ok=True)
        users.json.return_value = {'value': [{'userPrincipalName': 'a@b'}]}
        skus = Mock(ok=True)
        skus.json.return_value = {'value': []}
        with patch('hardware_service.requests.get', side_effect=[failed, users, skus]) as get:
            result = fetch_graph(lambda: 'token')
        self.assertIn('signInError', result)
        self.assertEqual(len(result['users']), 1)
        self.assertIn('signInActivity', get.call_args_list[0].args[0])
        self.assertNotIn('signInActivity', get.call_args_list[1].args[0])
        self.assertIn('createdDateTime', get.call_args_list[1].args[0])
        self.assertIn('usageLocation', get.call_args_list[0].args[0])
        self.assertIn('usageLocation', get.call_args_list[1].args[0])

    def test_partial_settings_keeps_prices_on_etag_retry(self):
        import json
        import azure.functions as func
        import function_app as app
        request = func.HttpRequest(method='POST', url='http://local/api/hardware/settings',
                                   body=json.dumps({'excludedPositions': []}).encode())
        with patch.object(app, 'require_perms', return_value=({}, None)), \
                patch.object(app, 'update_json_blob', side_effect=lambda path, transform:
                             transform({'excludedPositions': ['CHOFER'], 'licensePrices': {'SPB': 31}})):
            result = app.hardware_settings.build().get_user_function()(request)
        saved = json.loads(result.get_body())
        self.assertEqual(saved['excludedPositions'], [])
        self.assertEqual(saved['licensePrices']['SPB'], 31)


class SignInNullTests(unittest.TestCase):
    def test_claves_con_null_no_rompen(self):
        import hardware_v3
        activity = {'lastSignInDateTime': None, 'lastNonInteractiveSignInDateTime': '2026-10-01T10:00:00Z', 'lastSuccessfulSignInDateTime': None}
        self.assertTrue(hardware_v3.last_sign_in(activity).startswith('2026-10-01'))
        self.assertIsNone(hardware_v3.last_sign_in({'lastSignInDateTime': None}))
