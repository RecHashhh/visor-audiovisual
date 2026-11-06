"""Etiquetas con blobs en memoria, sin red."""
import json
import sys
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import Mock, patch
from types import SimpleNamespace
import azure.functions as func

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import function_app as app
from tags_store import Tags, paths_list

PHOTO = 'obra/sub/2026_S07/foto.jpg'
VIDEO = 'otro/2026_S08/video.mp4'
PERMS = {'email': 'ti@ripconciv.com', 'sections': ['proyectos'], 'scopes': {'proyectos': ['obra']}}


class TagsTests(unittest.TestCase):
    def setUp(self):
        self.blobs = {}
        self.store = Tags(lambda key: deepcopy(self.blobs.get(key)), self.update, '_config')
        app.tags_invalidate()

    def update(self, key, transform):
        result = transform(deepcopy(self.blobs.get(key)))
        self.blobs[key] = deepcopy(result)
        return result

    def apply(self, paths, add=(), remove=()):
        return self.store.apply(paths, list(add), list(remove), PERMS['email'], '2026-01-01')

    def endpoint(self, method, action='', detail='', body=None, perms=None):
        req = func.HttpRequest(method=method, url='http://local/api/tags',
                               route_params={'action': action, 'detail': detail},
                               body=json.dumps(body).encode() if body is not None else b'')
        with patch.object(app, 'tags_store', return_value=self.store), \
             patch.object(app, 'require_perms', return_value=(perms or PERMS, None)), \
             patch.object(app, 'require_blob_access', side_effect=lambda req, p: (PERMS, None) if p.startswith('obra/') else (None, app.err('Sin acceso', 403))):
            return app.tags_endpoint.build().get_user_function()(req)

    def test_catalogo_base_y_vacio_persistido(self):
        self.assertEqual([t['id'] for t in self.store.catalog()], ['sin-personas', 'imagen-limpia', 'revista', 'web', 'dron', 'portada'])
        self.assertEqual(self.store.catalog()[0]['label'], 'Sin personas')
        self.blobs[self.store.catalog_key] = []
        self.assertEqual(self.store.catalog(), [])

    def test_apply_add_remove_y_autoria(self):
        self.apply([PHOTO], ['web', 'revista'])
        self.apply([PHOTO], ['web', 'dron'], ['revista'])
        self.assertEqual(self.store.assignments()[PHOTO], {'tags': ['dron', 'web'], 'by': PERMS['email'], 'at': '2026-01-01'})
        self.apply([PHOTO], remove=['web', 'dron'])
        self.assertEqual(self.store.assignments(), {})

    def test_ids_inexistentes_no_escriben(self):
        for add, remove in ((['fantasma'], []), ([], ['fantasma'])):
            with self.assertRaises(ValueError):
                self.apply([PHOTO], add, remove)
        self.assertEqual(self.blobs, {})

    def test_catalogo_crear_renombrar_quitar_limpia_asignaciones(self):
        self.store.edit_catalog({'add': {'label': 'Edición pública', 'color': 'blue'}})
        self.apply([PHOTO, VIDEO], ['edicion-publica', 'web'])
        self.store.edit_catalog({'rename': {'id': 'edicion-publica', 'label': 'Selección'}})
        self.assertEqual(self.store.catalog()[-1]['label'], 'Selección')
        self.store.edit_catalog({'remove': 'edicion-publica'})
        self.assertEqual(self.store.assignments()[VIDEO]['tags'], ['web'])
        self.store.edit_catalog({'remove': 'web'})
        self.assertEqual(self.store.assignments(), {})

    def test_scopes_y_conteos_cache_por_usuario(self):
        self.apply([PHOTO, VIDEO], ['web'])
        files = self.endpoint('GET', 'web', 'files')
        self.assertEqual(json.loads(files.get_body()), [{'path': PHOTO, 'name': 'foto.jpg', 'projectCode': 'obra', 'week': 'sub/2026_S07'}])
        for perms, count in (({'sections': '*', 'scopes': {}}, 2), (PERMS, 1)):
            result = json.loads(self.endpoint('GET', perms=perms).get_body())
            self.assertEqual(next(t['count'] for t in result['catalog'] if t['id'] == 'web'), count)

    def test_lookup_una_lectura_y_gate_de_rutas(self):
        self.apply([PHOTO], ['web'])
        with patch.object(self.store, 'assignments', wraps=self.store.assignments) as read:
            response = self.endpoint('POST', 'lookup', body={'paths': [PHOTO]})
            self.assertEqual(json.loads(response.get_body()), {PHOTO: ['web']})
            read.assert_called_once()
        self.assertEqual(self.endpoint('POST', 'lookup', body={'paths': [VIDEO]}).status_code, 403)
        self.assertEqual(self.endpoint('POST', 'apply', body={'paths': [VIDEO], 'add': ['web']}).status_code, 403)

    def test_limites_y_rutas_de_obra(self):
        for raw in ([PHOTO] * 3001, [], 'ruta', ['_config/2026_S01/a.jpg'], ['obra/../2026_S01/a.jpg'], ['obra/2026_S01/a\\b.jpg']):
            with self.assertRaises(ValueError):
                paths_list(raw, 3000)
        with self.assertRaises(ValueError):
            self.apply([PHOTO] * 2001, ['web'])
        self.assertEqual(paths_list(['obra/carpeta-antigua/foto.jpg'], 3000), ['obra/carpeta-antigua/foto.jpg'])

    def test_etag_reintenta_conservando_edicion_concurrente(self):
        self.apply([PHOTO], ['web'])
        key, version, attempts = self.store.assignments_key, 1, []
        def download():
            payload = json.dumps(self.blobs[key]).encode()
            return SimpleNamespace(properties=SimpleNamespace(etag=str(version)), readall=lambda: payload)
        def upload(payload, **options):
            nonlocal version
            attempts.append(options)
            self.assertEqual(options['etag'], str(version))
            self.assertEqual(options['match_condition'], app.MatchConditions.IfNotModified)
            if len(attempts) == 1:
                self.blobs[key][VIDEO] = {'tags': ['dron'], 'by': 'otro', 'at': 'hoy'}
                version += 1
                raise app.ResourceModifiedError('Conflicto ETag simulado')
            self.blobs[key] = json.loads(payload)
            version += 1
        bc = Mock(download_blob=download, upload_blob=upload)
        service = Mock()
        service.get_blob_client.return_value = bc
        self.store.update = app.update_json_blob
        with patch.object(app, 'get_blob_service', return_value=service):
            self.apply([PHOTO], ['revista'])
        self.assertEqual(len(attempts), 2)
        self.assertEqual(self.store.assignments()[VIDEO]['tags'], ['dron'])
        self.assertEqual(self.store.assignments()[PHOTO]['tags'], ['revista', 'web'])

    def test_capacidad_se_exige_antes_de_acceder_a_blobs(self):
        perms = {**PERMS, 'allowed': True, 'caps': {}}
        req = func.HttpRequest(method='POST', url='http://local/api/tags/apply',
                               route_params={'action': 'apply'}, body=json.dumps({'paths': [PHOTO], 'add': ['web']}).encode())
        with patch.object(app, 'get_caller', return_value={'email': PERMS['email']}), \
             patch.object(app, 'effective_perms', return_value=perms), patch.object(app, 'tags_store') as store:
            response = app.tags_endpoint.build().get_user_function()(req)
        self.assertEqual(response.status_code, 403)
        store.assert_not_called()

    def test_borrado_endpoint_limpia_solo_archivos_borrados(self):
        self.apply([PHOTO, VIDEO], ['web'])
        req = func.HttpRequest(method='POST', url='http://local/api/projects/obra/delete',
                               route_params={'project_id': 'obra'}, body=json.dumps({'paths': [PHOTO]}).encode())
        with patch.object(app, 'require_perms', return_value=(PERMS, None)), \
             patch.object(app, 'get_blob_service', return_value=Mock()), \
             patch.object(app, 'tags_store', return_value=self.store), \
             patch.object(app, 'update_json_blob', side_effect=self.update), \
             patch.object(app, 'refresh_project_indexes'):
            response = app.project_delete.build().get_user_function()(req)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(self.store.assignments()), {VIDEO})


if __name__ == '__main__':
    unittest.main()
