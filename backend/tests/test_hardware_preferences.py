"""Preferencias de Hardware: contratos, permisos y aislamiento por usuario."""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hardware_preferences import DEFAULT_EXCLUDED_POSITIONS, DEFAULT_GROUP_COMPANIES, LICENSE_PRICES, validate_settings, validate_views


def card(identity='one'):
    return {
        'id': identity, 'name': 'Inversión', 'measure': 'value',
        'dimension': 'type', 'split': '', 'kind': 'bars', 'top': 10,
    }


class PreferencesValidationTests(unittest.TestCase):
    def test_settings_defaults_and_validation(self):
        self.assertEqual(DEFAULT_EXCLUDED_POSITIONS, [
            'CHOFER', 'LIMPIEZA', 'SERVICIOS GENERALES', 'CONSERJE', 'GUARDIA', 'MENSAJERO',
        ])
        self.assertEqual(validate_settings({'excludedPositions': [], 'licensePrices': LICENSE_PRICES, 'groupCompanies': DEFAULT_GROUP_COMPANIES}), {'excludedPositions': [], 'licensePrices': LICENSE_PRICES, 'groupCompanies': DEFAULT_GROUP_COMPANIES})
        self.assertEqual(validate_settings({'excludedPositions': [' Técnico ', 'Técnico']}),
                         {'excludedPositions': ['Técnico'], 'licensePrices': LICENSE_PRICES, 'groupCompanies': DEFAULT_GROUP_COMPANIES})
        for data in [None, {}, {'excludedPositions': 'CHOFER'},
                     {'excludedPositions': [None]}, {'excludedPositions': ['']},
                     {'excludedPositions': ['x' * 121]}, {'excludedPositions': ['x'] * 101}]:
            with self.subTest(data=data), self.assertRaises(ValueError):
                validate_settings(data)

    def test_group_companies_defaults_editing_and_validation(self):
        self.assertEqual(validate_settings({'excludedPositions': []})['groupCompanies'], DEFAULT_GROUP_COMPANIES)
        self.assertEqual(validate_settings({'excludedPositions': [], 'groupCompanies': []})['groupCompanies'], [])
        company = {'ruc': '1791344154001', 'shortName': ' Construcción '}
        self.assertEqual(validate_settings({'excludedPositions': [], 'groupCompanies': [company]})['groupCompanies'],
                         [{'ruc': company['ruc'], 'shortName': 'Construcción'}])
        invalid = [None, {}, [None], [company, company], [company] * 101]
        for patch_data in [{'ruc': '0920349388'}, {'ruc': 1791344154001}, {'ruc': 'x' * 13},
                           {'ruc': '１' * 13}, {'shortName': ''}, {'shortName': 'x' * 81}]:
            invalid.append([{**company, **patch_data}])
        invalid.append([company, {'ruc': '0992480440001', 'shortName': 'construcción'}])
        for companies in invalid:
            with self.subTest(companies=companies), self.assertRaises(ValueError):
                validate_settings({'excludedPositions': [], 'groupCompanies': companies})

    def test_views_limit_dimensions_and_fields(self):
        self.assertEqual(len(validate_views({'views': [card(str(i)) for i in range(24)]})['views']), 24)
        invalid = [None, {}, {'views': {}}, {'views': [card(str(i)) for i in range(25)]},
                   {'views': [card(), card()]}]
        for patch_data in [
            {'measure': 'unknown'}, {'dimension': 'license'}, {'top': True},
            {'top': 7}, {'kind': 'pie'}, {'split': 'type'}, {'split': 'unknown'},
            {'name': ''}, {'name': 'x' * 121}, {'id': ''},
        ]:
            invalid.append({'views': [{**card(), **patch_data}]})
        for data in invalid:
            with self.subTest(data=data), self.assertRaises(ValueError):
                validate_views(data)


class PreferencesEndpointsTests(unittest.TestCase):
    def request(self, method='GET', payload=None):
        import azure.functions as func
        return func.HttpRequest(method=method, url='http://local/api/hardware/settings',
                                body=json.dumps(payload).encode() if payload is not None else b'')

    def call(self, endpoint, req):
        return endpoint.build().get_user_function()(req)

    def test_permission_before_reads_or_writes(self):
        import function_app as app
        with patch.object(app, 'require_perms', return_value=(None, app.err('Sin permiso', 403))) as gate, \
                patch.object(app, 'load_json_blob') as read, \
                patch.object(app, 'update_json_blob') as write:
            for endpoint in [app.hardware_settings, app.hardware_views]:
                for method in ['GET', 'POST']:
                    self.assertEqual(self.call(endpoint, self.request(method)).status_code, 403)
                    self.assertEqual(gate.call_args.kwargs, {'cap': 'hardware'})
            read.assert_not_called()
            write.assert_not_called()

    def test_defaults_and_empty_list_are_distinct(self):
        import function_app as app
        with patch.object(app, 'require_perms', return_value=({}, None)), \
                patch.object(app, 'load_json_blob', return_value=None):
            result = self.call(app.hardware_settings, self.request())
            self.assertEqual(json.loads(result.get_body())['excludedPositions'], DEFAULT_EXCLUDED_POSITIONS)
        with patch.object(app, 'require_perms', return_value=({}, None)), \
                patch.object(app, 'load_json_blob', return_value={'excludedPositions': [], 'licensePrices': LICENSE_PRICES, 'groupCompanies': DEFAULT_GROUP_COMPANIES}):
            self.assertEqual(json.loads(self.call(app.hardware_settings, self.request()).get_body()),
                             {'excludedPositions': [], 'licensePrices': LICENSE_PRICES, 'groupCompanies': DEFAULT_GROUP_COMPANIES})

    def test_write_uses_optimistic_update_and_safe_user_key(self):
        import function_app as app
        with patch.object(app, 'require_perms', return_value=({}, None)), \
                patch.object(app, 'get_caller', return_value={'email': ' ANA+TI@Example.ec '}), \
                patch.object(app, 'update_json_blob', side_effect=lambda path, transform: transform(None)) as write:
            payload = {'views': [card()]}
            result = self.call(app.hardware_views, self.request('POST', payload))
            self.assertEqual(json.loads(result.get_body()), payload)
            self.assertEqual(write.call_args.args[0],
                             f"{app.CONFIG_PREFIX.strip('/')}/hardware/views/ana_ti_example.ec.json")
            result = self.call(app.hardware_settings,
                               self.request('POST', {'excludedPositions': ['CHOFER']}))
            self.assertEqual(result.status_code, 200)
            self.assertTrue(write.call_args.args[0].endswith('/hardware/settings.json'))

    def test_user_views_read_isolated_and_missing_identity_rejected(self):
        import function_app as app
        with patch.object(app, 'require_perms', return_value=({}, None)), \
                patch.object(app, 'get_caller', return_value={'email': 'b@example.ec'}), \
                patch.object(app, 'load_json_blob', return_value=None) as read:
            self.assertEqual(json.loads(self.call(app.hardware_views, self.request()).get_body()), {'views': []})
            self.assertTrue(read.call_args.args[0].endswith('/hardware/views/b_example.ec.json'))
        with patch.object(app, 'require_perms', return_value=({}, None)), \
                patch.object(app, 'get_caller', return_value=None), patch.object(app, 'load_json_blob') as read:
            self.assertEqual(self.call(app.hardware_views, self.request()).status_code, 401)
            read.assert_not_called()

    def test_invalid_payload_never_writes(self):
        import function_app as app
        with patch.object(app, 'require_perms', return_value=({}, None)), \
                patch.object(app, 'get_caller', return_value={'email': 'a@example.ec'}), \
                patch.object(app, 'update_json_blob') as write:
            for endpoint, payload in [
                (app.hardware_settings, {'excludedPositions': [1]}),
                (app.hardware_views, {'views': [card(str(i)) for i in range(25)]}),
            ]:
                self.assertEqual(self.call(endpoint, self.request('POST', payload)).status_code, 400)
            self.assertEqual(self.call(app.hardware_views, self.request('POST')).status_code, 400)
            write.assert_not_called()

    def test_personal_views_cannot_be_downloaded_by_another_hardware_user(self):
        import function_app as app
        with patch.object(app, 'require_perms', return_value=({}, None)), \
                patch.object(app, 'get_caller', return_value={'email': 'a@example.ec'}):
            own = f"{app.CONFIG_PREFIX.strip('/')}/hardware/views/a_example.ec.json"
            self.assertIsNone(app.require_blob_access(self.request(), own)[1])
            other = f"{app.CONFIG_PREFIX.strip('/')}/hardware/views/b_example.ec.json"
            self.assertEqual(app.require_blob_access(self.request(), other)[1].status_code, 403)
