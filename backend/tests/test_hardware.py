"""Reglas y endpoints de Hardware con fuentes inventadas, sin red."""
import json
import sys
import unittest
from datetime import date
from io import BytesIO
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hardware_snapshot import build_snapshot, email_index, parse_payroll, person_status, project, purchase_year


def workbook(rows):
    from openpyxl import Workbook
    book = Workbook()
    sheet = book.active
    sheet.title = 'Ecuador'
    sheet.append(['Nómina de prueba'])
    sheet.append([])
    sheet.append([])
    sheet.append(['CEDULA', 'NOMBRES', 'CARGOS', 'F. INGRESO', 'F. SALIDA', 'PROYECTO', 'AREA', 'CCOS NOMBRE', 'SOFTWARE DISEÑO', 'EMPRESA'])
    for row in rows:
        sheet.append(row)
    output = BytesIO()
    book.save(output)
    return output.getvalue()


class HardwareTests(unittest.TestCase):
    def test_purchase_year_2000_is_placeholder(self):
        self.assertEqual(purchase_year('2000-07-08'), 'sin fecha')
        self.assertEqual(purchase_year('2024-07-08T12:00:00Z'), '2024')
        self.assertEqual(purchase_year(None), 'sin fecha')

    def test_project_key_and_name(self):
        self.assertEqual(project('4767-LOJA-Villonaco III-Genérico'), {'code': '4767', 'name': 'LOJA-Villonaco III', 'homologated': True})

    def test_status_first_failure(self):
        self.assertEqual(person_status([], '', None), 'sin_computadora')
        self.assertEqual(person_status([{}], '', None), 'sin_correo')
        self.assertEqual(person_status([{}], 'a@b.ec', None), 'sin_cuenta_m365')
        self.assertEqual(person_status([{}], 'a@b.ec', {'accountEnabled': False, 'assignedLicenses': [{}]}), 'cuenta_bloqueada')
        self.assertEqual(person_status([{}], 'a@b.ec', {'accountEnabled': True}), 'sin_licencia')
        self.assertEqual(person_status([{}], 'a@b.ec', {'accountEnabled': True, 'assignedLicenses': [{}]}), 'ok')

    def test_proxy_addresses_case_insensitive(self):
        user = {'userPrincipalName': 'new@b.ec', 'proxyAddresses': ['SMTP:OLD@B.EC', 'smtp:alias@b.ec']}
        index = email_index([user])
        self.assertIs(index['old@b.ec'], user)
        self.assertIs(index['alias@b.ec'], user)

    def test_exit_in_past_and_header_row(self):
        raw = workbook([[123456789, 'Ana', 'Ingeniera', None, '2026-01-01', '4767-Loja-Genérico', 'TECNICO'],
                        [223456789, 'Luis', 'Técnico', None, None, '4767-Loja-Genérico', 'TECNICO']])
        people = parse_payroll(raw, date(2026, 11, 6))
        self.assertEqual([p['name'] for p in people], ['Luis'])
        self.assertEqual(people[0]['cedula'], '0223456789')
        from zipfile import BadZipFile
        with self.assertRaises(BadZipFile):
            parse_payroll(b'invalid')

    def test_snapshot_coverage_quality_and_totals(self):
        payroll = [{'cedula': '0123456789', 'name': 'Ana', 'position': 'Ingeniera', 'area': 'TECNICO', 'project': project('4767-Loja-Genérico')}]
        mesa = {'items': [{'id': 1, 'code': 'L1', 'type': 'LAPTOP', 'value': 900, 'active': True, 'purchaseDate': '2000-01-01', 'companies': ['A', 'B']},
                          {'id': 2, 'code': 'C1', 'type': 'CPU', 'value': 300, 'active': True},
                          {'id': 3, 'code': 'L2', 'type': 'LAPTOP', 'value': 600, 'active': True},
                          {'id': 4, 'code': 'L3', 'type': 'LAPTOP', 'active': False}],
                'assignments': [{'itemId': 1, 'cedula': '0123456789', 'projectName': '999-Erróneo'}, {'itemId': 2, 'cedula': '9999999999', 'projectName': '888-Otro'}],
                'payroll': [{'cedula': '0123456789', 'email': 'alias@b.ec'}],
                'custodians': [{'cedula': '0123456789', 'email': 'incorrecto@b.ec'}],
                'disposals': [{'itemId': 4, 'date': '2026-06-01', 'reason': 'Daño'}],
                'disposalRequests': [{'itemId': 3, 'state': 'Pendiente', 'reason': 'Daño'}, {'itemId': 4, 'state': 'Autorizada'}]}
        snapshot = build_snapshot(mesa, payroll, [{'proxyAddresses': ['SMTP:ALIAS@B.EC'], 'accountEnabled': True, 'assignedLicenses': [{'skuId': 'premium'}]}], [{'skuId': 'premium', 'skuPartNumber': 'SPB'}], today=date(2026, 11, 6))
        self.assertEqual(snapshot['kpis']['activeComputers'], 3)
        self.assertEqual(snapshot['kpis']['licensedEmailPercent'], 100)
        self.assertEqual(snapshot['coverage']['people'][0]['licenses'], ['Microsoft 365 Empresa Premium'])
        self.assertEqual(snapshot['items'][0]['project']['code'], '4767')
        self.assertEqual(snapshot['quality']['recoverEquipment'], [2])
        self.assertEqual(snapshot['quality']['unmatchedProjects'], [{'project': '999-Erróneo', 'count': 1}, {'project': '888-Otro', 'count': 1}])
        self.assertEqual(len(snapshot['quality']['unassignedComputers']), 1)
        self.assertEqual(sum(r['value'] for r in snapshot['companiesByYear']), 1800)
        self.assertEqual(snapshot['kpis']['en_proceso'], 1)
        self.assertEqual(snapshot['kpis']['autorizadas'], 1)

    def test_inactive_computer_still_assigned_counts_for_the_person(self):
        payroll = [{'cedula': '0100000001', 'name': 'Ana', 'area': 'ADMINISTRATIVOS OFICINAS', 'project': project('Administración Quito')}]
        mesa = {'items': [{'id': 1, 'code': 'LT90002', 'type': 'LAPTOP', 'active': False}, {'id': 2, 'code': 'LT9', 'type': 'LAPTOP', 'active': False}],
                'assignments': [{'itemId': 1, 'cedula': '0100000001'}]}
        snapshot = build_snapshot(mesa, payroll)
        person = snapshot['coverage']['people'][0]
        self.assertNotEqual(person['status'], 'sin_computadora')
        self.assertEqual([(c['code'], c['inactive']) for c in person['computers']], [('LT90002', True)])
        self.assertEqual(snapshot['kpis']['activeComputers'], 1)
        self.assertEqual(snapshot['quality']['toActivate'], [1])
        mesa['assignments'] = [{'itemId': 1, 'cedula': '1111111111'}]
        self.assertEqual(build_snapshot(mesa, payroll)['quality']['toActivate'], [])

    def test_email_found_in_m365_by_name_when_payroll_has_none(self):
        payroll = [{'cedula': '0100000003', 'name': 'ZAMBRANO LEON PEDRO LUIS', 'area': 'ADMINISTRATIVOS OFICINAS', 'project': project('448 GYE')},
                   {'cedula': '0900000001', 'name': 'PEREZ LOPEZ ANA MARIA', 'area': 'ADMINISTRATIVOS OFICINAS', 'project': project('448 GYE')}]
        mesa = {'items': [{'id': 1, 'code': 'LT1', 'type': 'LAPTOP', 'active': True}, {'id': 2, 'code': 'LT2', 'type': 'LAPTOP', 'active': True}],
                'assignments': [{'itemId': 1, 'cedula': '0100000003'}, {'itemId': 2, 'cedula': '0900000001'}]}
        users = [{'displayName': 'Pedro Zambrano', 'userPrincipalName': 'pzambrano@ripconciv.com', 'accountEnabled': True, 'assignedLicenses': [{'skuId': 'p'}]},
                 {'displayName': 'Ana Pérez', 'userPrincipalName': 'aperez@ripconciv.com', 'accountEnabled': True},
                 {'displayName': 'Ana Pérez', 'userPrincipalName': 'aperez2@ripconciv.com', 'accountEnabled': True}]
        people = {p['cedula']: p for p in build_snapshot(mesa, payroll, users, [])['coverage']['people']}
        self.assertEqual((people['0100000003']['email'], people['0100000003']['status']), ('pzambrano@ripconciv.com', 'ok'))
        self.assertEqual(people['0100000003']['emailSource'], 'M365 por nombre')
        self.assertEqual(people['0900000001']['email'], 'aperez@ripconciv.com')  # «aperez» = inicial + apellido desempata

    def test_out_of_payroll_shows_custodian_project_and_consortium(self):
        mesa = {'items': [{'id': i, 'code': f'LT{i}', 'type': 'LAPTOP', 'active': True} for i in (1, 2, 3)],
                'assignments': [{'itemId': 1, 'cedula': '0100000004', 'projectCode': '99001', 'projectName': 'CENTRAL - CONSORCIO FERROVIARIO METRO DE QUITO'},
                                {'itemId': 2, 'cedula': '0100000005', 'projectName': 'CONSORCIO CONFLUENCIA - PUEMBO CALDERON'},
                                {'itemId': 3, 'cedula': '0100000006', 'projectName': '5067-UIO-Metro de Quito-Ripconciv-Generico'}],
                'custodians': [{'cedula': '0100000004', 'name': 'PRUEBA PRUEBA JUAN CARLOS'}]}
        snapshot = build_snapshot(mesa, [])
        first = snapshot['items'][0]
        self.assertEqual((first['project']['code'], first['project']['name'], first['custodian']),
                         ('99001', 'CENTRAL - CONSORCIO FERROVIARIO METRO DE QUITO', 'PRUEBA PRUEBA JUAN CARLOS'))
        self.assertEqual([i['consortium'] for i in snapshot['items']], ['METRO', 'CONFLUENCIA', None])
        self.assertEqual(snapshot['quality']['recoverEquipment'], [3])  # el personal de consorcio no se recupera

    def test_empty_payroll_does_not_restore_departed_people(self):
        result = build_snapshot({'payroll': [{'cedula': '123', 'name': 'Salida', 'costCenter': '4767-Loja'}]}, [])
        self.assertEqual(result['coverage']['people'], [])
        self.assertEqual(result['kpis']['targetPeople'], 0)

    def test_project_fallback_uses_nominagp_and_excel_catalog(self):
        mesa = {'items': [{'id': 1, 'type': 'LAPTOP', 'active': True}],
                'assignments': [{'itemId': 1, 'cedula': '9999999999', 'projectCode': '123', 'projectName': '123-Antiguo'}],
                'payroll': [{'cedula': '9999999999', 'name': 'Eva', 'costCenter': '4767-Nombre GP'}]}
        payroll = [{'cedula': '0123456789', 'name': 'Ana', 'area': 'TECNICO', 'project': project('4767-Nombre oficial-Genérico')}]
        result = build_snapshot(mesa, payroll)
        self.assertEqual(result['items'][0]['project']['name'], 'Nombre oficial')
        self.assertEqual(result['quality']['recoverEquipment'], [1])
        self.assertEqual(result['items'][0]['custodian'], 'Eva')
        self.assertEqual(result['items'][0]['area'], 'fuera de nómina')
        self.assertEqual(result['kpis']['targetPeople'], 1)


class HardwareIntegrationTests(unittest.TestCase):
    def test_payroll_binary_base64_and_size_limit(self):
        import base64
        import azure.functions as func
        import function_app as app
        raw = workbook([['0123456789', 'Ana', 'Técnica', None, None, '4767-Loja', 'TECNICO']])
        blob = Mock()
        for body, content_type in [(raw, 'application/octet-stream'), (json.dumps({'base64': base64.b64encode(raw).decode()}).encode(), 'application/json')]:
            req = func.HttpRequest(method='POST', url='http://local/api/hardware/nomina', headers={'Content-Type': content_type}, body=body)
            with patch.object(app, 'require_perms', return_value=({}, None)), patch.object(app, '_hardware_blob', return_value=blob), patch.object(app, '_hardware_refresh', return_value={'kpis': {}}):
                result = app.hardware_nomina.build().get_user_function()(req)
            self.assertEqual(result.status_code, 200)
            self.assertEqual(blob.upload_blob.call_args.args[0], raw)
        req = func.HttpRequest(method='POST', url='http://local/api/hardware/nomina', body=b'x' * (10 * 1024 * 1024 + 1))
        with patch.object(app, 'require_perms', return_value=({}, None)), patch.object(app, '_hardware_blob') as storage:
            self.assertEqual(app.hardware_nomina.build().get_user_function()(req).status_code, 413)
            storage.assert_not_called()

    def test_updates_check_permission_before_any_source_or_write(self):
        import azure.functions as func
        import function_app as app
        req = func.HttpRequest(method='POST', url='http://local/api/hardware/refresh', body=b'')
        with patch.object(app, 'require_perms', return_value=(None, app.err('Sin permiso', 403))), patch.object(app, '_hardware_blob') as storage, patch.object(app, '_hardware_refresh') as refresh:
            for endpoint in [app.hardware_refresh, app.hardware_nomina]:
                self.assertEqual(endpoint.build().get_user_function()(req).status_code, 403)
            storage.assert_not_called()
            refresh.assert_not_called()

    def test_hardware_capability_presets_and_group(self):
        import function_app as app
        self.assertTrue(app.ROLE_CAPS['admin']['hardware'])
        self.assertFalse(app.ROLE_CAPS['operador']['hardware'])
        self.assertFalse(app.ROLE_CAPS['viewer']['hardware'])
        cfg = {'restricted': True, 'groups': {'equipo-ti': {'members': ['ti@example.ec']}}}
        with patch.object(app, 'load_access_config', return_value=cfg):
            self.assertTrue(app.effective_perms({'email': 'ti@example.ec', 'name': 'TI'})['caps']['hardware'])

    def test_snapshot_and_kpi_history_persistence(self):
        import function_app as app
        snapshot = {'generatedAt': '2026-11-06T12:00:00Z', 'kpis': {'activeEquipment': 3}, 'coverage': {'people': []}}
        blobs = {}
        def blob(name):
            client = Mock()
            client.upload_blob.side_effect = lambda payload, **kwargs: blobs.update({name: json.loads(payload)})
            return client
        with patch('hardware_service.refresh', return_value=snapshot), patch.object(app, '_hardware_blob', side_effect=blob), patch.object(app, '_hardware_cached', None):
            self.assertEqual(app._hardware_refresh(), snapshot)
        self.assertEqual(blobs['snapshot.json'], snapshot)
        history = next(v for key, v in blobs.items() if key.startswith('history/'))
        self.assertEqual(set(history), {'generatedAt', 'kpis'})

    def test_graph_failure_does_not_replace_existing_license_inventory(self):
        import function_app as app
        previous = {'items': [{'id': 1}], 'licenses': {'bySku': [{'sku': 'SPB', 'assigned': 3}]}}
        partial = {'items': [{'id': 1}], 'sources': {'graph': {'error': 'No se pudo completar users'}}}
        with patch('hardware_service.refresh', return_value=partial), \
                patch.object(app, 'load_json_blob', return_value=previous), \
                patch.object(app, '_hardware_blob') as blob:
            with self.assertRaisesRegex(RuntimeError, 'inventario anterior'):
                app._hardware_refresh()
            blob.assert_not_called()

    def test_private_blobs_require_hardware_capability(self):
        import function_app as app
        with patch.object(app, 'require_perms', return_value=(None, None)) as gate:
            app.require_blob_access(Mock(), f'{app.CONFIG_PREFIX}/hardware/snapshot.json')
        self.assertEqual(gate.call_args.kwargs, {'cap': 'hardware'})

    def test_hardware_cannot_be_shared_as_a_project_or_parent_folder(self):
        import azure.functions as func
        import function_app as app
        for payload in [{'projectId': app.CONFIG_PREFIX}, {'projectId': app.CONFIG_PREFIX, 'week': 'hardware'}, {'projectId': app.CONFIG_PREFIX + '/hardware'}]:
            req = func.HttpRequest(method='POST', url='http://local/api/share/create', body=json.dumps(payload).encode())
            with patch.object(app, 'require_perms', return_value=({}, None)), patch.object(app, 'save_share') as save:
                result = app.share_create.build().get_user_function()(req)
            self.assertEqual(result.status_code, 403)
            save.assert_not_called()

    def test_partial_sources_are_saved_as_errors(self):
        from hardware_service import refresh
        with patch('hardware_service.fetch_mesa', side_effect=ValueError('Mesa no disponible')), patch('hardware_service.fetch_graph', return_value={'users': [], 'skus': []}):
            result = refresh(lambda: None, '', '', lambda: '')
        self.assertIn('error', result['sources']['mesa'])
        self.assertIn('error', result['sources']['nomina'])
        self.assertEqual(result['kpis']['activeEquipment'], 0)

    def test_graph_pagination(self):
        from hardware_service import fetch_graph
        responses = []
        for data in [{'value': [{'mail': 'a@b.ec'}], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=next'}, {'value': [{'mail': 'c@b.ec'}]}, {'value': [{'skuId': 'id'}]}]:
            response = Mock(); response.json.return_value = data; responses.append(response)
        with patch('hardware_service.requests.get', side_effect=responses):
            result = fetch_graph(lambda: 'fake')
        self.assertEqual(len(result['users']), 2)
        self.assertEqual(len(result['skus']), 1)

    def test_endpoints_require_capability_and_missing_snapshot_is_clear(self):
        import azure.functions as func
        import function_app as app
        req = func.HttpRequest(method='GET', url='http://local/api/hardware', body=b'')
        with patch.object(app, 'require_perms', return_value=(None, app.err('Sin permiso', 403))):
            self.assertEqual(app.hardware_get.build().get_user_function()(req).status_code, 403)
        with patch.object(app, 'require_perms', return_value=({}, None)), patch.object(app, 'load_json_blob', return_value=None), patch.object(app, '_hardware_cached', None):
            result = app.hardware_get.build().get_user_function()(req)
            self.assertEqual(result.status_code, 404)
            self.assertIn('foto', json.loads(result.get_body())['error'])

    def test_open_never_waits_for_refresh_and_marks_old_photo(self):
        # Abrir Hardware responde al instante con la foto guardada; la página la renueva en segundo plano.
        from datetime import datetime, timedelta, timezone
        import azure.functions as func
        import function_app as app
        now = datetime.now(timezone.utc)
        cases = [
            ({'generatedAt': now.isoformat(), 'licenses': {'bySku': [{'sku': 'SPB', 'assigned': 3}]}}, True),  # sin cuentas
            ({'generatedAt': (now - timedelta(hours=30)).isoformat(), 'licenses': {'bySku': [], 'accounts': []}}, True),  # de ayer
            ({'generatedAt': now.isoformat(), 'licenses': {'bySku': [], 'accounts': []}}, False),
        ]
        req = func.HttpRequest(method='GET', url='http://local/api/hardware', body=b'')
        for photo, stale in cases:
            with patch.object(app, 'require_perms', return_value=({}, None)),                     patch.object(app, 'load_json_blob', return_value=photo),                     patch.object(app, '_hardware_cached', None),                     patch.object(app, '_hardware_cached_at', 0),                     patch.object(app, '_hardware_refresh') as refresh:
                body = json.loads(app.hardware_get.build().get_user_function()(req).get_body())
                self.assertEqual(body['stale'], stale)
                self.assertEqual(body['licenses']['bySku'], photo['licenses']['bySku'])
                refresh.assert_not_called()

if __name__ == '__main__':
    unittest.main()
