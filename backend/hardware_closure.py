"""Cierre mensual de Hardware. Desde nov-2026 todo se guarda en la base de la Mesa (tablas hardware_closures);
aquí solo queda validar el mes y el traspaso único de lo que TI guardó antes en hardware/closure.json."""
import re

MONTH = re.compile(r'^\d{4}-(0[1-9]|1[0-2])$')


def valid_month(value):
    if not isinstance(value, str) or not MONTH.match(value):
        raise ValueError('Mes inválido: usa AAAA-MM')
    return value


def normalize(doc):
    doc = doc if isinstance(doc, dict) else {}
    return {'repairs': doc.get('repairs') if isinstance(doc.get('repairs'), dict) else {},
            'extraRepairs': doc.get('extraRepairs') if isinstance(doc.get('extraRepairs'), list) else [],
            'notes': doc.get('notes') if isinstance(doc.get('notes'), dict) else {}}


def pending_import(doc):
    """Lo manual del archivo del Hub que aún no se pasó a la Mesa (None si no hay nada que pasar)."""
    if not isinstance(doc, dict) or doc.get('importedAt'):
        return None
    manual = normalize(doc)
    return manual if any(manual.values()) else None
