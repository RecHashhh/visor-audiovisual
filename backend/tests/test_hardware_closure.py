"""Cierre mensual: el Hub valida el mes, reenvía los cambios a la Mesa y traspasa una vez lo del archivo antiguo."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hardware_closure import pending_import, valid_month
import hardware_service


class Response:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self.body = body if body is not None else {'purchases': [], 'repairs': [], 'reassignments': [], 'disposals': []}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError('http')

    def json(self):
        return self.body


class ClosureTests(unittest.TestCase):
    def test_month(self):
        self.assertEqual(valid_month('2026-09'), '2026-09')
        for bad in ('2026-13', '2026-9', None, '2026-09x'):
            with self.assertRaises(ValueError):
                valid_month(bad)

    def test_pending_import(self):
        self.assertIsNone(pending_import(None))
        self.assertIsNone(pending_import({'repairs': {}, 'extraRepairs': [], 'notes': {}}), 'vacío: nada que pasar')
        doc = {'notes': {'2026-09': {'text': 'x'}}}
        self.assertEqual(pending_import(doc)['notes'], doc['notes'])
        self.assertIsNone(pending_import({**doc, 'importedAt': '2026-11-17T00:00:00+00:00'}), 'una sola vez')

    def test_fetch_closure(self):
        with patch.object(hardware_service.requests, 'get', return_value=Response()) as get:
            hardware_service.fetch_closure('https://mesa/', 'tok', '2026-09')
        self.assertEqual(get.call_args.args[0], 'https://mesa/api/integrations/hardware/closure')
        self.assertEqual(get.call_args.kwargs['params'], {'month': '2026-09'})
        with self.assertRaises(ValueError):
            hardware_service.fetch_closure('', 'tok', '2026-09')

    def test_save_and_import_forward_to_mesa(self):
        with patch.object(hardware_service.requests, 'post', return_value=Response(body={'status': 'Cerrado'})) as post:
            self.assertEqual(hardware_service.save_closure('https://mesa', 'tok', '2026-09', {'close': True}, 'ti@x')['status'], 'Cerrado')
        self.assertEqual(post.call_args.args[0], 'https://mesa/api/integrations/hardware/closure')
        self.assertEqual(post.call_args.kwargs['json'], {'patch': {'close': True}, 'editor': 'ti@x'})
        self.assertEqual(post.call_args.kwargs['headers'], {'X-Hardware-Token': 'tok'})
        with patch.object(hardware_service.requests, 'post', return_value=Response(body={'imported': 1})) as post:
            hardware_service.import_closure('https://mesa', 'tok', {'notes': {}}, 'ti@x')
        self.assertEqual(post.call_args.args[0], 'https://mesa/api/integrations/hardware/closure/import')
        rejected = Response(409, {'message': 'El cierre de este mes está cerrado; reábrelo para editarlo'})
        with patch.object(hardware_service.requests, 'post', return_value=rejected):
            with self.assertRaises(hardware_service.MesaRejected) as caught:
                hardware_service.save_closure('https://mesa', 'tok', '2026-09', {'notes': {'text': 'x'}}, 'ti@x')
        self.assertEqual((caught.exception.status, str(caught.exception)), (409, 'El cierre de este mes está cerrado; reábrelo para editarlo'))


if __name__ == '__main__':
    unittest.main()
