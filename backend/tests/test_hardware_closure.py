"""Cierre mensual: validación de lo que TI completa y qué aplica a cada mes."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hardware_closure import apply_patch, month_view, valid_month
import hardware_service

RID = '62398C9D-87EB-40F0-86CC-A714C1651FF6'


class ClosureTests(unittest.TestCase):
    def test_month(self):
        self.assertEqual(valid_month('2026-09'), '2026-09')
        for bad in ('2026-13', '2026-9', None, '2026-09x'):
            with self.assertRaises(ValueError):
                valid_month(bad)

    def test_repair_details(self):
        doc = apply_patch(None, {'repair': {'id': RID.lower(), 'reason': ' No enciende ', 'estimate': '1 semana', 'state': 'Retirado', 'cost': 103.5}}, 'ti@x')
        row = doc['repairs'][RID]
        self.assertEqual((row['reason'], row['estimate'], row['state'], row['cost'], row['by']), ('No enciende', '1 semana', 'Retirado', 103.5, 'ti@x'))
        for bad in ({'state': 'Otro'}, {'cost': -1}, {'cost': True}, {'cost': float('nan')}, {'reason': 'x' * 301}):
            with self.assertRaises(ValueError):
                apply_patch(doc, {'repair': {'id': RID, **bad}}, 'ti@x')
        with self.assertRaises(ValueError):
            apply_patch(doc, {'repair': {'id': "x'; drop"}}, 'ti@x')

    def test_extra_repairs_by_month(self):
        doc = apply_patch(None, {'extra': {'code': 'lt00229', 'name': 'LOVATO', 'supplier': 'LAPTOP REPAIR', 'sentAt': '2026-09-28',
                                           'returnedAt': '2026-10-02', 'state': 'Retirado', 'cost': 103.5}}, 'ti@x')
        row = doc['extraRepairs'][0]
        self.assertEqual(row['code'], 'LT00229')
        self.assertRegex(row['id'], r'^m-[0-9a-f]{32}$')
        self.assertEqual(len(month_view(doc, '2026-09')['extraRepairs']), 1)
        self.assertEqual(len(month_view(doc, '2026-10')['extraRepairs']), 1, 'sigue fuera hasta el retorno')
        self.assertEqual(month_view(doc, '2026-11')['extraRepairs'], [])
        self.assertEqual(month_view(doc, '2026-08')['extraRepairs'], [])
        edited = apply_patch(doc, {'extra': {**row, 'estimate': '3 días'}}, 'ti@x')
        self.assertEqual(len(edited['extraRepairs']), 1, 'editar no duplica')
        self.assertEqual(apply_patch(edited, {'removeExtra': row['id']}, 'ti@x')['extraRepairs'], [])
        for bad in ({'code': 'LT1', 'supplier': 'S'}, {'code': 'LT1', 'supplier': 'S', 'sentAt': '2026-02-30'},
                    {'code': 'LT1', 'supplier': 'S', 'sentAt': '2026-09-10', 'returnedAt': '2026-09-01'}):
            with self.assertRaises(ValueError):
                apply_patch(None, {'extra': bad}, 'ti@x')

    def test_notes(self):
        doc = apply_patch(None, {'notes': {'month': '2026-09', 'text': 'Sin novedades'}}, 'ti@x')
        self.assertEqual(month_view(doc, '2026-09')['notes'], 'Sin novedades')
        self.assertEqual(month_view(doc, '2026-10')['notes'], '')
        self.assertEqual(month_view(apply_patch(doc, {'notes': {'month': '2026-09', 'text': ' '}}, 'ti@x'), '2026-09')['notes'], '')
        with self.assertRaises(ValueError):
            apply_patch(None, {'nada': 1}, 'ti@x')

    def test_fetch_closure(self):
        class Response:
            def raise_for_status(self):
                pass

            def json(self):
                return {'purchases': [], 'repairs': [], 'reassignments': [], 'disposals': []}
        with patch.object(hardware_service.requests, 'get', return_value=Response()) as get:
            hardware_service.fetch_closure('https://mesa/', 'tok', '2026-09')
        self.assertEqual(get.call_args.args[0], 'https://mesa/api/integrations/hardware/closure')
        self.assertEqual(get.call_args.kwargs['params'], {'month': '2026-09'})
        with self.assertRaises(ValueError):
            hardware_service.fetch_closure('', 'tok', '2026-09')


if __name__ == '__main__':
    unittest.main()
