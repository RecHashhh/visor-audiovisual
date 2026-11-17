"""Cierre mensual de Hardware: datos que RIP_TIC no guarda (detalle de reparaciones, reparaciones sin registrar,
novedades del mes). Puro, sin Azure: function_app lo guarda en hardware/closure.json."""
import math
import re
import uuid
from datetime import datetime, timezone

REPAIR_STATES = ['Pendiente', 'Retirado', 'Sin reparación']
MONTH = re.compile(r'^\d{4}-(0[1-9]|1[0-2])$')
DAY = re.compile(r'^\d{4}-\d{2}-\d{2}$')
EMPTY = {'repairs': {}, 'extraRepairs': [], 'notes': {}}


def valid_month(value):
    if not isinstance(value, str) or not MONTH.match(value):
        raise ValueError('Mes inválido: usa AAAA-MM')
    return value


def _text(data, key, limit, required=False):
    value = data.get(key, '')
    if value is None:
        value = ''
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError(f'{key}: texto de hasta {limit} caracteres')
    value = value.strip()
    if required and not value:
        raise ValueError(f'Falta {key}')
    return value


def _day(data, key, required=False):
    value = _text(data, key, 10, required)
    if value:
        if not DAY.match(value):
            raise ValueError(f'{key}: fecha AAAA-MM-DD')
        datetime.strptime(value, '%Y-%m-%d')
    return value or None


def _details(data):
    """Campos que TI completa en una reparación: motivo, tiempo estimado, estado y costo."""
    if not isinstance(data, dict):
        raise ValueError('Reparación inválida')
    state = data.get('state') or ''
    if state and state not in REPAIR_STATES:
        raise ValueError('Estado de reparación inválido')
    cost = data.get('cost')
    if cost in ('', None):
        cost = None
    elif isinstance(cost, bool) or not isinstance(cost, (int, float)) or not math.isfinite(cost) or not 0 <= cost <= 100000:
        raise ValueError('Costo inválido: importe USD entre 0 y 100000')
    return {'reason': _text(data, 'reason', 300), 'estimate': _text(data, 'estimate', 60), 'state': state,
            'cost': None if cost is None else round(float(cost), 2)}


def _extra(data):
    """Reparación que no está en RIP_TIC (equipo enviado sin cambiar su custodia)."""
    row = _details(data)
    row.update({
        'code': _text(data, 'code', 40, True).upper(), 'type': _text(data, 'type', 40) or 'LAPTOP',
        'name': _text(data, 'name', 160), 'project': _text(data, 'project', 160),
        'supplier': _text(data, 'supplier', 160, True), 'sentAt': _day(data, 'sentAt', True),
        'returnedAt': _day(data, 'returnedAt'),
    })
    if row['returnedAt'] and row['returnedAt'] < row['sentAt']:
        raise ValueError('El retorno no puede ser anterior al envío')
    identity = data.get('id')
    row['id'] = identity if isinstance(identity, str) and re.match(r'^m-[0-9a-f]{32}$', identity) else 'm-' + uuid.uuid4().hex
    return row


def normalize(doc):
    doc = doc if isinstance(doc, dict) else {}
    return {'repairs': doc.get('repairs') if isinstance(doc.get('repairs'), dict) else {},
            'extraRepairs': doc.get('extraRepairs') if isinstance(doc.get('extraRepairs'), list) else [],
            'notes': doc.get('notes') if isinstance(doc.get('notes'), dict) else {}}


def apply_patch(doc, patch, editor):
    """Un cambio por llamada; se reaplica sobre la versión más reciente si otro guardó antes (ETag)."""
    if not isinstance(patch, dict):
        raise ValueError('Cambio inválido')
    doc = normalize(doc)
    stamp = {'by': editor, 'at': datetime.now(timezone.utc).isoformat(timespec='seconds')}
    if 'repair' in patch:
        repair = patch['repair'] if isinstance(patch['repair'], dict) else {}
        identity = repair.get('id')
        if not isinstance(identity, str) or not re.match(r'^[0-9A-Fa-f-]{36}$', identity):
            raise ValueError('Reparación inválida')
        doc['repairs'] = {**doc['repairs'], identity.upper(): {**_details(repair), **stamp}}
    elif 'extra' in patch:
        row = {**_extra(patch['extra']), **stamp}
        doc['extraRepairs'] = [r for r in doc['extraRepairs'] if r.get('id') != row['id']] + [row]
        if len(doc['extraRepairs']) > 500:
            raise ValueError('Demasiadas reparaciones manuales')
    elif 'removeExtra' in patch:
        doc['extraRepairs'] = [r for r in doc['extraRepairs'] if r.get('id') != patch['removeExtra']]
    elif 'notes' in patch:
        notes = patch['notes'] if isinstance(patch['notes'], dict) else {}
        month = valid_month(notes.get('month'))
        text = _text(notes, 'text', 4000)
        doc['notes'] = {k: v for k, v in doc['notes'].items() if k != month}
        if text:
            doc['notes'][month] = {'text': text, **stamp}
    else:
        raise ValueError('Cambio inválido')
    return doc


def month_view(doc, month):
    """Lo manual que aplica al mes: detalle de reparaciones, reparaciones manuales activas en el mes y novedades."""
    doc = normalize(doc)
    start = month + '-01'
    year, index = int(month[:4]), int(month[5:])
    end = f'{year + 1}-01-01' if index == 12 else f'{year}-{index + 1:02d}-01'
    extra = [r for r in doc['extraRepairs'] if str(r.get('sentAt') or '') < end
             and (not r.get('returnedAt') or str(r['returnedAt']) >= start)]
    return {'repairs': doc['repairs'], 'extraRepairs': sorted(extra, key=lambda r: (r.get('sentAt') or '', r.get('code') or '')),
            'notes': (doc['notes'].get(month) or {}).get('text', '')}
