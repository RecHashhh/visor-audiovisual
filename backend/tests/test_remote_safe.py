"""Copias remotas con Graph, reloj y blobs falsos; sin conexiones externas."""
import base64
import json
import sys
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import azure.functions as func
from azure.core import MatchConditions
from azure.core.exceptions import HttpResponseError, ResourceNotFoundError
import function_app as app
import uploader


class BlockCopyTests(unittest.TestCase):
    def setUp(self):
        self.size = 1024 ** 3 + 17
        self.item = dict(driveId='drive', itemId='video', size=self.size,
                         metadata=uploader.metadata_origen('Video río.mp4', self.size))
        self.blob = Mock()
        self.blob.get_blob_properties.side_effect = ResourceNotFoundError('Sin commit')
        self.blob.get_block_list.return_value = ([], [])
        self.graph = patch.object(uploader, 'graph_item_download_url', return_value='https://graph-download/video')
        self.url = self.graph.start()
        self.addCleanup(self.graph.stop)

    def test_reanuda_bloques_y_commit_con_metadata_tipo_tier_y_condicion(self):
        bid = base64.b64encode(b'000000').decode()
        self.blob.get_block_list.return_value = ([], [NS(id=bid, size=app._REMOTE_BLOCK_BYTES)])
        result = app._remote_block_copy(self.blob, 'token', self.item)
        self.assertTrue(result['done'])
        self.assertEqual(result['stagedBytes'], self.size)
        self.assertEqual(self.blob.stage_block_from_url.call_count, 10)
        first = self.blob.stage_block_from_url.call_args_list[0]
        self.assertEqual(first.args, (base64.b64encode(b'000001').decode(), 'https://graph-download/video'))
        self.assertEqual(first.kwargs['source_offset'], app._REMOTE_BLOCK_BYTES)
        last = self.blob.stage_block_from_url.call_args_list[-1]
        self.assertEqual(last.kwargs['source_length'], self.size - 10 * app._REMOTE_BLOCK_BYTES)
        commit = self.blob.commit_block_list.call_args
        ids = commit.args[0]
        self.assertEqual(ids, [base64.b64encode(f'{i:06d}'.encode()).decode() for i in range(11)])
        self.assertEqual(len({len(b) for b in ids}), 1)
        self.assertEqual(commit.kwargs['metadata'], self.item['metadata'])
        self.assertEqual(commit.kwargs['content_settings'].content_type, 'video/mp4')
        self.assertEqual(commit.kwargs['standard_blob_tier'], uploader.StandardBlobTier.COOL)
        self.assertEqual(commit.kwargs['match_condition'], MatchConditions.IfMissing)
        self.assertNotIn('etag', commit.kwargs)

    def test_presupuesto_agotado_y_ids_estables_al_reanudar(self):
        with patch.object(app.time, 'monotonic', side_effect=[0, 0, 121]):
            first = app._remote_block_copy(self.blob, 'token', self.item)
        self.assertFalse(first['done'])
        self.assertEqual(first['stagedBytes'], app._REMOTE_BLOCK_BYTES)
        bid = self.blob.stage_block_from_url.call_args.args[0]
        self.blob.get_block_list.return_value = ([], [NS(id=bid, size=app._REMOTE_BLOCK_BYTES)])
        self.blob.stage_block_from_url.reset_mock()
        second = app._remote_block_copy(self.blob, 'token', self.item)
        self.assertTrue(second['done'])
        self.assertNotIn(bid, [c.args[0] for c in self.blob.stage_block_from_url.call_args_list])

    def test_blob_comprometido_mismo_origen_existe(self):
        self.blob.get_blob_properties.side_effect = None
        self.blob.get_blob_properties.return_value = NS(metadata=self.item['metadata'], size=self.size, copy=None)
        self.assertEqual(app._remote_block_copy(self.blob, 'token', self.item)['status'], 'existe')
        self.blob.stage_block_from_url.assert_not_called()
        self.blob.commit_block_list.assert_not_called()
        self.url.assert_not_called()

    def test_no_sobrescribe_otro_origen(self):
        self.blob.get_blob_properties.side_effect = None
        self.blob.get_blob_properties.return_value = NS(metadata={}, size=self.size, copy=None)
        with self.assertRaises(ValueError): app._remote_block_copy(self.blob, 'token', self.item)
        self.blob.commit_block_list.assert_not_called()

    def test_throttle_y_error_de_bloque_devuelven_progreso(self):
        bid = base64.b64encode(b'000000').decode()
        self.blob.get_block_list.return_value = ([], [NS(id=bid, size=app._REMOTE_BLOCK_BYTES)])
        for target in (self.url, self.blob.stage_block_from_url):
            with self.subTest(target=target):
                target.side_effect = RuntimeError('Limitado por Graph o Azure')
                result = app._remote_block_copy(self.blob, 'token', self.item)
                self.assertFalse(result['done'])
                self.assertEqual(result['stagedBytes'], app._REMOTE_BLOCK_BYTES)
                self.assertIn('Limitado', result['error'])
                target.side_effect = None
        self.blob.commit_block_list.assert_not_called()

    def test_commit_perdido_se_reconoce_en_la_siguiente_llamada(self):
        self.blob.commit_block_list.side_effect = RuntimeError('Respuesta perdida')
        result = app._remote_block_copy(self.blob, 'token', self.item)
        self.assertFalse(result['done'])
        self.assertEqual(result['stagedBytes'], self.size)
        self.blob.get_blob_properties.side_effect = None
        self.blob.get_blob_properties.return_value = NS(metadata=self.item['metadata'], size=self.size, copy=None)
        self.assertTrue(app._remote_block_copy(self.blob, 'token', self.item)['done'])

    def test_carrera_commit_con_otro_origen_no_se_silencia(self):
        self.blob.commit_block_list.side_effect = HttpResponseError('Ocupado')
        self.blob.commit_block_list.side_effect.status_code = 412
        self.blob.get_blob_properties.side_effect = [ResourceNotFoundError('Sin commit'), NS(metadata={}, size=self.size, copy=None)]
        with self.assertRaises(ValueError): app._remote_block_copy(self.blob, 'token', self.item)

    def test_endpoint_permiso_prefijo_y_metadata(self):
        endpoint = app.upload_remote_block_copy.build().get_user_function()
        body = dict(projectCode='33013', projectName='obra', subfolder='tramo',
                    item={**self.item, 'blobPath': '33013_obra/tramo/2024_S01/VID_20240101_001.mp4'})
        def call(payload=body, method='POST'):
            return endpoint(func.HttpRequest(method=method, url='http://local/block-copy', body=json.dumps(payload).encode()))
        with patch.object(app, 'require_perms', return_value=(None, app.err('Sin permiso', 403))):
            self.assertEqual(call().status_code, 403)
            self.assertEqual(call(method='OPTIONS').status_code, 204)
        with patch.object(app, 'require_perms', return_value=({}, None)), patch.object(app, 'get_blob_service') as svc, patch.object(uploader, '_get_graph_token', return_value='token'), patch.object(app, '_remote_block_copy', return_value={'done': False, 'stagedBytes': 0, 'totalBytes': self.size}):
            for change in ({'blobPath': 'otro/video.mp4'}, {'blobPath': '33013_obra/tramo/../video.mp4'},
                           {'metadata': {}}, {'size': True}, {'size': 5}, {'metadata': {**self.item['metadata'], 'srcsize': '1'}},
                           {'metadata': {**self.item['metadata'], 'srcname': 'carpeta/'}}):
                self.assertEqual(call({**body, 'item': {**body['item'], **change}}).status_code, 400)
            svc.assert_not_called()
            self.assertEqual(call().status_code, 200)


class RemoteFoldersTests(unittest.TestCase):
    def test_sondeo_lista_solo_padres_distintos_y_devuelve_pendientes(self):
        cc = Mock()
        def listing(name_starts_with, include):
            self.assertEqual(include, ['copy', 'metadata'])
            return [NS(name=p, copy=NS(status=s), metadata={}) for p, s in (
                ('obra/2024_S01/a', 'success'), ('obra/2024_S01/b', 'pending'),
                ('obra/2024_S01/ajeno', 'failed'), ('obra/2024_S02/c', 'failed')) if p.startswith(name_starts_with)]
        cc.list_blobs.side_effect = listing
        svc = Mock(); svc.get_container_client.return_value = cc
        expected = {'obra/2024_S01/a', 'obra/2024_S01/b', 'obra/2024_S02/c', 'obra/2024_S02/d'}
        with patch.object(app, 'get_blob_service', return_value=svc):
            result = app._copy_status_counts('obra/', expected)
        self.assertEqual([c.kwargs['name_starts_with'] for c in cc.list_blobs.call_args_list], ['obra/2024_S01/', 'obra/2024_S02/'])
        self.assertEqual((result['done'], result['pending'], result['failed'], result['missing']), (1, 1, 1, 1))
        self.assertEqual(result['pendingPaths'], ['obra/2024_S01/b'])
        self.assertEqual(set(result['notDone']), {'obra/2024_S02/c', 'obra/2024_S02/d'})

    def test_primer_nivel_paginado_no_recorre_subcarpetas(self):
        folder = dict(id='folder', name='2024-03 Marzo', folder={}, parentReference={'driveId': 'drive'})
        file = dict(id='file', name='foto.jpg', file={}, size=10, parentReference={'driveId': 'drive'})
        with patch.object(uploader, '_graph_get', side_effect=[{'value': [folder], '@odata.nextLink': 'next'}, {'value': [file]}]) as graph:
            rows, pending = uploader.list_drive_tree_budgeted('token', [['root', '']], recursive=False, include_folders=True)
        self.assertEqual([r['name'] for r in rows], ['2024-03 Marzo', 'foto.jpg'])
        self.assertTrue(rows[0]['folder'])
        self.assertEqual(rows[0]['relDir'], '2024-03 Marzo')
        self.assertEqual(pending, [])
        self.assertEqual([c.args[1] for c in graph.call_args_list], ['root', 'next'])

    def test_listado_cede_en_medio_de_paginas(self):
        with patch.object(uploader, '_graph_get', return_value={'value': [], '@odata.nextLink': 'next'}), patch.object(uploader.time, 'monotonic', side_effect=[0, 0, 121]):
            rows, pending = uploader.list_drive_tree_budgeted('token', [['root', 'marzo']])
        self.assertEqual(rows, [])
        self.assertEqual(pending, [['next', 'marzo']])

    def test_reserva_conserva_destino_sin_marcarlo_existente(self):
        index = dict(rutas={}, origenes=set(), rutas_origen={}, con_origen=set(), maximos={})
        video = dict(name='video_20240301.mp4', size=1024 ** 3, id='video', parentReference={'driveId': 'drive'})
        photo = dict(name='foto_20240301.jpg', size=100, id='foto', parentReference={'driveId': 'drive'})
        stored = {}
        def update(key, transform):
            stored[key] = transform(deepcopy(stored.get(key)))
            return stored[key]
        with patch.object(app, 'update_json_blob', side_effect=update):
            first = app._prepare_remote_project_jobs([video, photo], '33013_obra', 'VID', index)
            video_job = next(j for j in first if j['nombre_orig'] == video['name'])
            self.assertEqual(video_job['status'], 'nuevo')
            photo_job = next(j for j in first if j['nombre_orig'] == photo['name'])
            origin = uploader.clave_origen(photo['name'], 100)
            index['rutas'][photo_job['blob_path']] = 100
            index['con_origen'].add(photo_job['blob_path'])
            index['origenes'].add(origin); index['rutas_origen'][origin] = photo_job['blob_path']
            index['maximos']['VID_20240301'] = 2
            again = app._prepare_remote_project_jobs([video, photo], '33013_obra', 'VID', index)
        resumed = next(j for j in again if j['nombre_orig'] == video['name'])
        self.assertEqual(resumed['blob_path'], video_job['blob_path'])
        self.assertEqual(resumed['status'], 'nuevo')


if __name__ == '__main__':
    unittest.main()
