"""Validación de preferencias del tablero; no depende de Azure."""

from hardware_v3 import LICENSE_PRICES
import math

DEFAULT_EXCLUDED_POSITIONS = [
    'CHOFER', 'LIMPIEZA', 'SERVICIOS GENERALES', 'CONSERJE', 'GUARDIA', 'MENSAJERO',
]

DEFAULT_GROUP_COMPANIES = [
    {'ruc': '1791344154001', 'shortName': 'RIPCONCIV'},
    {'ruc': '0992480440001', 'shortName': 'GEOFORCE'},
    {'ruc': '0993122882001', 'shortName': 'Consorcio Puente Daule'},
    {'ruc': '1792615593001', 'shortName': 'Urban Projects'},
]


def validate_group_companies(companies):
    if not isinstance(companies, list) or len(companies) > 100:
        raise ValueError('Empresas del grupo: usa una lista de hasta 100 empresas')
    result, seen = [], set()
    for company in companies:
        if not isinstance(company, dict):
            raise ValueError('Empresa del grupo inválida')
        ruc, name = company.get('ruc'), company.get('shortName')
        if not isinstance(ruc, str) or len(ruc) != 13 or not ruc.isascii() or not ruc.isdigit():
            raise ValueError('El RUC debe contener exactamente 13 dígitos')
        if ruc in seen:
            raise ValueError('No se permite repetir el RUC de una empresa')
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
            raise ValueError('El nombre corto debe tener entre 1 y 80 caracteres')
        if name.strip().casefold() in {row['shortName'].casefold() for row in result}:
            raise ValueError('No se permite repetir el nombre corto de una empresa')
        seen.add(ruc)
        result.append({'ruc': ruc, 'shortName': name.strip()})
    return result


DIMENSIONS = {
    'equipment': {'year', 'month', 'type', 'brand', 'company', 'supplier', 'project', 'area'},
    'value': {'year', 'month', 'type', 'brand', 'company', 'supplier', 'project', 'area'},
    'disposals': {'year', 'month', 'type', 'brand', 'company', 'supplier', 'project', 'area', 'reason'},
    'requests': {'year', 'month', 'type', 'brand', 'company', 'supplier', 'project', 'area', 'reason', 'category'},
    'people': {'project', 'area', 'status', 'position', 'license'},
    'licenses': {'license'},
}


def validate_settings(data):
    values = data.get('excludedPositions') if isinstance(data, dict) else None
    if not isinstance(values, list) or len(values) > 100:
        raise ValueError('Cargos excluidos: usa una lista de hasta 100 textos')
    if any(not isinstance(v, str) or not v.strip() or len(v) > 120 for v in values):
        raise ValueError('Cada cargo debe tener entre 1 y 120 caracteres')
    prices = data.get('licensePrices', {})
    if not isinstance(prices, dict) or len(prices) > 300 or any(
        not isinstance(k, str) or not 1 <= len(k) <= 160 or isinstance(v, bool) or
        not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 100000
        for k, v in prices.items()
    ):
        raise ValueError('Precios de licencia inválidos: usa importes USD no negativos')
    return {'excludedPositions': list(dict.fromkeys(v.strip() for v in values)),
            'licensePrices': {**LICENSE_PRICES, **prices},
            'groupCompanies': validate_group_companies(data.get('groupCompanies', DEFAULT_GROUP_COMPANIES))}


def validate_views(data):
    views = data.get('views') if isinstance(data, dict) else None
    if not isinstance(views, list) or len(views) > 24:
        raise ValueError('Se permiten hasta 24 tarjetas personales')
    result, ids = [], set()
    for view in views:
        if not isinstance(view, dict):
            raise ValueError('Tarjeta inválida')
        identity, name = view.get('id'), view.get('name')
        if not isinstance(identity, str) or not 1 <= len(identity) <= 80 or identity in ids:
            raise ValueError('Cada tarjeta debe tener un identificador único')
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 120:
            raise ValueError('El nombre debe tener entre 1 y 120 caracteres')
        measure = view.get('measure')
        dimension, split = view.get('dimension'), view.get('split', '')
        if not isinstance(measure, str) or not isinstance(dimension, str) or \
                measure not in DIMENSIONS or dimension not in DIMENSIONS[measure]:
            raise ValueError('Medida o dimensión inválida')
        if not isinstance(split, str):
            raise ValueError('La segunda dimensión debe ser texto')
        if split and (split not in DIMENSIONS[measure] or split == dimension):
            raise ValueError('La segunda dimensión debe ser válida y distinta')
        if view.get('kind') not in ('bars', 'horizontal', 'stacked', 'grouped', 'line', 'table'):
            raise ValueError('Tipo de gráfico inválido')
        if type(view.get('top')) is not int or view['top'] not in (0, 5, 10, 20):
            raise ValueError('Top N inválido')
        ids.add(identity)
        result.append({
            'id': identity, 'name': name.strip(), 'measure': measure,
            'dimension': dimension, 'split': split, 'kind': view['kind'], 'top': view['top'],
        })
    return {'views': result}
