"""Favoritos sin red: versiones y conflictos simulados en memoria."""
import sys
import unittest
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from favorites_store import Favorites, members_list, origin


OWNER, EDITOR, OTHER = 'patricia@ripconciv.com', 'vicky@ripconciv.com', 'otro@tenant.com'
ITEM = {'path': '28002_obra/tramo/2026_S07/foto.jpg', 'name': 'foto.jpg'}


class Conflict(Exception):
    status_code = 412


class Memory:
    def __init__(self):
        self.blobs, self.versions, self.writes = {}, {}, []
        self.conflicts = {}
        self.before_conflict = None

    def read(self, key):
        return deepcopy(self.blobs.get(key)), self.versions.get(key)

    def write(self, key, data, etag):
        if self.conflicts.get(key, 0):
            self.conflicts[key] -= 1
            if self.before_conflict:
                self.before_conflict(key)
            raise Conflict()
        if etag != self.versions.get(key):
            raise Conflict()
        self.blobs[key] = deepcopy(data)
        self.versions[key] = self.versions.get(key, 0) + 1
        self.writes.append((key, etag))


class FavoritesTests(unittest.TestCase):
    def setUp(self):
        self.memory = Memory()
        self.store = Favorites(self.memory.read, self.memory.write, '_config', lambda e: '_config/favorites/' + e + '.json')
        self.store.create(OWNER, {'id': 'corporativas', 'name': 'Fotos corporativas', 'items': [deepcopy(ITEM)], 'createdAt': '2026-01-01'})

    def share(self):
        return self.store.set_members(OWNER, 'corporativas', [EDITOR])

    def test_mueve_personal_conserva_id_y_fechas(self):
        self.share()
        self.assertEqual(self.store.personal(OWNER)['collections'], [])
        col = self.store.shared('corporativas')
        self.assertEqual((col['id'], col['createdAt'], col['owner']), ('corporativas', '2026-01-01', OWNER))
        self.assertEqual(col['items'], [ITEM])
        self.assertEqual(self.memory.blobs['_config/favorites/shared-index.json']['corporativas']['members'], [EDITOR])

    def test_get_une_personales_compartidas_y_corazones(self):
        self.share()
        self.store.create(EDITOR, {'id': 'personal', 'name': 'Mías', 'items': [{'path': 'obra/2026_S08/otra.jpg'}]})
        result = self.store.get(EDITOR)
        self.assertEqual([c['id'] for c in result['collections']], ['personal', 'corporativas'])
        shared = result['collections'][1]
        self.assertEqual((shared['shared'], shared['role'], shared['owner']), (True, 'editor', OWNER))
        self.assertEqual(set(result['paths']), {ITEM['path'], 'obra/2026_S08/otra.jpg'})
        self.assertEqual(self.store.get(OTHER)['collections'], [])
        self.assertEqual(self.store.get(OWNER)['collections'][0]['role'], 'owner')

    def test_permisos_dueno_editor_ajeno(self):
        self.share()
        self.store.mutate(OWNER, 'corporativas', lambda c: c.update(name='Actual'), owner=True, metadata=True)
        for user in [EDITOR, OTHER]:
            with self.assertRaises(PermissionError):
                self.store.mutate(user, 'corporativas', lambda c: c.update(deleted=True), owner=True)
            with self.assertRaises(PermissionError):
                self.store.set_members(user, 'corporativas', [])
        with self.assertRaises(PermissionError):
            self.store.item(OTHER, 'corporativas', ITEM)
        self.assertEqual(self.memory.blobs['_config/favorites/shared-index.json']['corporativas']['name'], 'Actual')

    def test_editor_agrega_y_quita_y_registra_autoria(self):
        self.share()
        item = {'path': 'obra/2026_S08/nueva.mp4', 'name': 'nueva.mp4'}
        self.store.item(EDITOR, 'corporativas', item)
        col = self.store.shared('corporativas')
        self.assertEqual(col['items'][-1]['addedBy'], EDITOR)
        self.assertTrue(col['items'][-1]['addedAt'])
        self.assertEqual(col['updatedBy'], EDITOR)
        self.store.item(EDITOR, 'corporativas', item)
        self.assertEqual(len(self.store.shared('corporativas')['items']), 2)
        self.store.item(EDITOR, 'corporativas', ITEM, remove=True)
        self.assertEqual(len(self.store.shared('corporativas')['items']), 1)

    def test_quitar_de_todas_solo_editables(self):
        self.share()
        self.store.create(OTHER, {'id': 'ajena', 'name': 'Ajena', 'items': [ITEM]})
        self.store.set_members(OTHER, 'ajena', [OWNER])
        self.store.item(EDITOR, '', ITEM, remove=True)
        self.assertEqual(self.store.shared('corporativas')['items'], [])
        self.assertEqual(self.store.shared('ajena')['items'], [ITEM])

    def test_salir_y_revocacion(self):
        self.share()
        with self.assertRaises(PermissionError):
            self.store.leave(OWNER, 'corporativas')
        self.assertEqual(self.store.leave(EDITOR, 'corporativas')['collections'], [])
        self.assertEqual(self.store.shared('corporativas')['members'], [])
        self.assertTrue(self.store.get(OWNER)['collections'][0]['shared'])
        with self.assertRaises(PermissionError):
            self.store.item(EDITOR, 'corporativas', ITEM, remove=True)

    def test_dueno_quita_todos_y_elimina(self):
        self.share()
        self.store.set_members(OWNER, 'corporativas', [])
        self.assertTrue(self.store.get(OWNER)['collections'][0]['shared'])
        self.assertEqual(self.store.get(EDITOR)['collections'], [])
        self.store.mutate(OWNER, 'corporativas', lambda c: c.update(deleted=True), owner=True, metadata=True)
        self.assertEqual(self.store.get(OWNER)['collections'], [])
        self.assertNotIn('corporativas', self.memory.blobs['_config/favorites/shared-index.json'])

    def test_412_relee_y_conserva_edicion_concurrente(self):
        self.share()
        key = self.store.shared_key('corporativas')
        self.memory.conflicts[key] = 1
        def concurrent(k):
            self.memory.blobs[k]['items'].append({'path': 'obra/2026_S08/concurrente.jpg'})
            self.memory.versions[k] += 1
        self.memory.before_conflict = concurrent
        self.store.item(EDITOR, 'corporativas', {'path': 'obra/2026_S08/nueva.jpg'})
        self.assertEqual(len(self.store.shared('corporativas')['items']), 3)

    def test_cinco_reintentos_indice_y_limite(self):
        self.memory.conflicts['_config/favorites/shared-index.json'] = 5
        self.share()
        self.assertEqual(len(self.store.get(EDITOR)['collections']), 1)
        self.memory.conflicts[self.store.shared_key('corporativas')] = 6
        with self.assertRaises(Conflict):
            self.store.item(EDITOR, 'corporativas', {'path': 'obra/2026_S08/nueva.jpg'})

    def test_revalida_permiso_tras_conflicto(self):
        self.share()
        key = self.store.shared_key('corporativas')
        self.memory.conflicts[key] = 1
        def revoke(k):
            self.memory.blobs[k]['members'] = []
            self.memory.versions[k] += 1
        self.memory.before_conflict = revoke
        with self.assertRaises(PermissionError):
            self.store.item(EDITOR, 'corporativas', {'path': 'obra/2026_S08/nueva.jpg'})
        self.assertEqual(self.store.shared('corporativas')['items'], [ITEM])

    def test_indice_conserva_otras_colecciones_tras_conflicto(self):
        key = '_config/favorites/shared-index.json'
        self.memory.conflicts[key] = 1
        def concurrent(k):
            self.memory.blobs[k] = {'otra': {'name': 'Otra', 'owner': OTHER, 'members': []}}
            self.memory.versions[k] = 1
        self.memory.before_conflict = concurrent
        self.share()
        self.assertEqual(set(self.memory.blobs[key]), {'corporativas', 'otra'})

    def test_migracion_reanudable_tras_fallo_indice(self):
        self.memory.conflicts['_config/favorites/shared-index.json'] = 6
        with self.assertRaises(Conflict):
            self.share()
        self.share()
        self.assertEqual(len(self.store.get(OWNER)['collections']), 1)
        self.assertEqual(self.store.personal(OWNER)['collections'], [])

    def test_correos_normalizados_sin_duplicados_maximo(self):
        self.assertEqual(members_list([' VICKY@RIPCONCIV.COM ', EDITOR, OWNER, OTHER], OWNER), [EDITOR, OTHER])
        for raw in ['correo@tenant.com', ['sin-correo'], ['a b@tenant.com'], [f'u{i}@tenant.com' for i in range(51)]]:
            with self.assertRaises(ValueError):
                members_list(raw, OWNER)

    def test_origen_simple_subcarpeta_y_legado(self):
        self.assertEqual(origin('obra/2026_S02/foto.jpg'), ('obra', '2026_S02'))
        self.assertEqual(origin(ITEM['path']), ('28002_obra', 'tramo/2026_S07'))
        item = self.store.get(OWNER)['collections'][0]['items'][0]
        self.assertEqual((item['projectCode'], item['week'], item['folder']), ('28002_obra', 'tramo/2026_S07', 'tramo/2026_S07'))


if __name__ == '__main__':
    unittest.main()
