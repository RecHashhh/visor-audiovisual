"""Cargas guardadas con blobs en memoria, sin servicios externos."""
import sys
import json
from unittest.mock import patch
import unittest
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from presets_store import Presets, seed_presets, validate_preset
import azure.functions as func
import function_app as app


class Memory:
    def __init__(self):
        self.blobs = {}
        self.writes = 0

    def read(self, key):
        return deepcopy(self.blobs.get(key))

    def update(self, key, transform):
        result = transform(self.read(key))
        self.blobs[key] = deepcopy(result)
        self.writes += 1
        return deepcopy(result)


class PresetsTests(unittest.TestCase):
    def setUp(self):
        self.memory = Memory()
        self.store = Presets(self.memory.read, self.memory.update, '_config/')
        self.body = {k: v for k, v in seed_presets()[0].items() if k not in ('id', 'createdBy', 'updatedAt')}

    def test_siembra_diez_solo_si_no_existe(self):
        rows = self.store.get()
        self.assertEqual(len(rows), 10)
        self.assertEqual(len({r['id'] for r in rows}), 10)
        self.assertEqual(sum(r['source'] == 'onedrive' for r in rows), 1)
        self.assertEqual([(r['projectCode'], r['projectName'], r['prefijo']) for r in rows], [
            ('33013', 'vivantino', 'DRN'), ('33014', 'promart-quitumbe', 'DRN'),
            ('00000', 'attiva', 'FOT'), ('00000', 'puente-daule', 'FOT'),
            ('22012', 'pavimento-zona-wpto-posorja', 'FOT'), ('19004', 'vial-4-av-las-americas', 'FOT'),
            ('22006', 'promart-orellana', 'DRN'), ('22005', 'ptap-mancha-grande', 'DRN'),
            ('27020', 'promart-congregacion-epc', 'DRN'), ('00000', 'puente-los-pajaros', 'DRN')])
        self.assertTrue(all(validate_preset(r) for r in rows))
        self.assertEqual(self.store.get(), rows)
        self.assertEqual(self.memory.writes, 1)
        self.memory.blobs[self.store.key] = []
        self.assertEqual(self.store.get(), [])
        self.assertEqual(self.store.key, '_config/upload-presets.json')

    def test_validacion_prefijo_url_correo_y_campos(self):
        for patch in ({'prefijo': 'OTRO'}, {'source': 'local'}, {'userEmail': 'sin-correo'},
                      {'folderPath': 'relativa'}, {'name': ''}, {'projectCode': '../x'},
                      {'projectName': 'a/b'}, {'subfolder': '..'}, {'recursive': 'false'}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                validate_preset({**self.body, **patch})
        for url in ('http://empresa.sharepoint.com/x', 'https://sharepoint.com/x',
                    'https://empresa.sharepoint.com.evil.com/x', 'https://otro.com/x',
                    'https://user@empresa.sharepoint.com/x', 'https://empresa.sharepoint.com:8080/x'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                validate_preset({**self.body, 'source': 'sharepoint', 'sharepointUrl': url})
        valid = validate_preset({**self.body, 'source': 'sharepoint', 'sharepointUrl': 'https://empresa.sharepoint.com/sites/Fotos con espacios'})
        self.assertNotIn('userEmail', valid)
        with self.assertRaises(ValueError):
            validate_preset([])

    def test_crear_editar_eliminar_preserva_autoria_y_resultado(self):
        saved = self.store.save({**self.body, 'createdBy': 'falso'}, 'autor@ripconciv.com')
        self.assertEqual(len(self.store.get()), 11)
        self.assertEqual(saved['createdBy'], 'autor@ripconciv.com')
        result = self.store.run_result(saved['id'], dict(nuevos=3, existentes=4, subidos=2, errores=1, duracionS=1.5), 'equipo@ripconciv.com')
        edited = self.store.save({**saved, 'name': 'Vivantino — Dron', 'lastRun': {}}, 'editor@ripconciv.com')
        self.assertEqual(edited['name'], 'Vivantino — Dron')
        self.assertEqual(edited['createdBy'], saved['createdBy'])
        self.assertEqual(edited['lastRun'], result)
        self.assertEqual(result['by'], 'equipo@ripconciv.com')
        self.assertTrue(result['at'])
        self.store.delete(saved['id'])
        self.assertEqual(len(self.store.get()), 10)
        for operation in (lambda: self.store.delete(saved['id']),
                          lambda: self.store.save(saved, 'x'),
                          lambda: self.store.run_result(saved['id'], dict(nuevos=0, existentes=0, subidos=0, errores=0, duracionS=0), 'x')):
            with self.assertRaises(KeyError): operation()

    def test_run_result_valida_y_no_modifica_configuracion(self):
        before = self.store.get()[0]
        body = dict(nuevos=4, existentes=7, subidos=3, errores=1, duracionS=42, by='falso', at='falso')
        result = self.store.run_result(before['id'], body, 'real@ripconciv.com')
        after = self.store.get()[0]
        self.assertEqual({k: v for k, v in before.items() if k != 'updatedAt'},
                         {k: v for k, v in after.items() if k not in ('updatedAt', 'lastRun')})
        self.assertEqual(after['lastRun'], result)
        self.assertNotEqual(result['at'], 'falso')
        self.assertEqual(result['by'], 'real@ripconciv.com')
        for key, value in [('nuevos', -1), ('errores', True), ('subidos', 1.5), ('duracionS', float('nan')), ('duracionS', '5')]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                self.store.run_result(before['id'], {**body, key: value}, 'x')
        self.assertEqual(self.store.get()[0]['lastRun'], result)


class PresetEndpointsTests(unittest.TestCase):
    def setUp(self):
        self.memory = Memory()
        for item in (patch.object(app, 'load_json_blob', side_effect=self.memory.read),
                     patch.object(app, 'update_json_blob', side_effect=self.memory.update),
                     patch.object(app, 'require_perms', return_value=({'email': 'ti@ripconciv.com'}, None))):
            item.start()
            self.addCleanup(item.stop)

    def call(self, endpoint, method, body=None, pid=None):
        req = func.HttpRequest(method=method, url='http://local/api/upload/presets',
                               route_params={'id': pid} if pid else {},
                               body=json.dumps(body).encode() if body is not None else b'no json')
        response = endpoint.build().get_user_function()(req)
        return response.status_code, json.loads(response.get_body()) if response.get_body() else None

    def test_endpoints_sin_red(self):
        status, rows = self.call(app.upload_presets, 'GET')
        self.assertEqual((status, len(rows)), (200, 10))
        body = {k: v for k, v in rows[0].items() if k not in ('id', 'updatedAt', 'createdBy')}
        status, created = self.call(app.upload_presets, 'POST', body)
        self.assertEqual((status, created['createdBy']), (200, 'ti@ripconciv.com'))
        status, edited = self.call(app.upload_presets, 'POST', {**created, 'name': 'Editada'})
        self.assertEqual((status, edited['name']), (200, 'Editada'))
        status, result = self.call(app.upload_preset_result, 'POST',
                                  dict(nuevos=2, existentes=5, subidos=2, errores=0, duracionS=6), created['id'])
        self.assertEqual((status, result['subidos'], result['by']), (200, 2, 'ti@ripconciv.com'))
        self.assertEqual(self.call(app.delete_upload_preset, 'DELETE', pid=created['id'])[0], 200)
        self.assertEqual(self.call(app.delete_upload_preset, 'DELETE', pid=created['id'])[0], 404)
        self.assertEqual(self.call(app.upload_presets, 'POST')[0], 400)
        self.assertEqual(self.call(app.upload_presets, 'POST', {**body, 'prefijo': 'BAD'})[0], 400)
        self.assertEqual(self.call(app.upload_preset_result, 'POST', {}, rows[0]['id'])[0], 400)

    def test_permiso_upload_antes_de_tocar_blobs_y_preflight(self):
        with patch.object(app, 'require_perms', return_value=(None, app.err('Sin permiso', 403))) as auth:
            for endpoint, method in ((app.upload_presets, 'GET'), (app.upload_presets, 'POST'),
                                     (app.delete_upload_preset, 'DELETE'), (app.upload_preset_result, 'POST')):
                self.assertEqual(self.call(endpoint, method, {}, 'notebook-1')[0], 403)
                self.assertEqual(auth.call_args.kwargs, {'cap': 'upload'})
            self.assertEqual(self.memory.blobs, {})
            auth.reset_mock()
            self.assertEqual(self.call(app.upload_presets, 'OPTIONS')[0], 204)
            auth.assert_not_called()

    def test_reintento_etag_no_pierde_cambios_concurrentes(self):
        original_update = self.memory.update
        def retry(key, transform):
            transform(self.memory.read(key))  # Primer intento pierde la carrera de ETag.
            concurrent = seed_presets()
            concurrent[1]['name'] = 'Editada por otro usuario'
            self.memory.blobs[key] = concurrent
            return original_update(key, transform)
        with patch.object(app, 'update_json_blob', side_effect=retry):
            status, _ = self.call(app.upload_preset_result, 'POST',
                                 dict(nuevos=1, existentes=0, subidos=1, errores=0, duracionS=2), 'notebook-1')
        self.assertEqual(status, 200)
        rows = next(iter(self.memory.blobs.values()))
        self.assertEqual(rows[1]['name'], 'Editada por otro usuario')
        self.assertEqual(rows[0]['lastRun']['subidos'], 1)


if __name__ == '__main__':
    unittest.main()
