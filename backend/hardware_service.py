"""Adquisición de fuentes; el Hub nunca consulta SQL."""
import logging
import time
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, wait
import requests
from hardware_snapshot import build_snapshot, parse_payroll


def fetch_mesa(url, token):
    if not url or not token:
        raise ValueError('Faltan MESA_URL o HARDWARE_SNAPSHOT_TOKEN')
    response = requests.get(url.rstrip('/') + '/api/integrations/hardware', headers={'X-Hardware-Token': token}, timeout=(5, 35))
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict) or not isinstance(data.get('items'), list):
        raise ValueError('Respuesta de Mesa inválida')
    return data


def fetch_graph(token_provider):
    token = token_provider()
    deadline = time.monotonic() + 65
    result = {'users': [], 'skus': []}
    errors = []
    for key, endpoint in [('users', '/users?$select=userPrincipalName,mail,displayName,employeeId,proxyAddresses,accountEnabled,assignedLicenses,signInActivity,createdDateTime,usageLocation&$top=999'), ('skus', '/subscribedSkus')]:
        url = 'https://graph.microsoft.com/v1.0' + endpoint
        try:
            while url:
                remaining = deadline - time.monotonic()
                if remaining < 2:
                    raise TimeoutError('Tiempo de Graph agotado')
                if not url.startswith('https://graph.microsoft.com/'):
                    raise ValueError('Paginación de Graph inválida')
                response = requests.get(url, headers={'Authorization': 'Bearer ' + token}, timeout=(3, min(12, remaining)))
                if key == 'users' and not response.ok and 'signInActivity' in url:
                    result['signInError'] = 'No se pudo consultar signInActivity; actividad desconocida'
                    result[key] = []
                    url = 'https://graph.microsoft.com/v1.0' + endpoint.replace(',signInActivity', '')
                    continue
                response.raise_for_status()
                data = response.json()
                result[key].extend(data['value'])
                url = data.get('@odata.nextLink')
        except Exception:
            errors.append('No se pudo completar ' + key)
    if errors:
        result['error'] = '; '.join(errors)
    return result


def refresh(read_payroll, mesa_url, mesa_token, token_provider, target_areas=None):
    sources = {}
    values = {'mesa': {}, 'graph': {}, 'nomina': None}
    def payroll():
        raw = read_payroll()
        if raw is None:
            raise ValueError('Aún no se ha subido la nómina')
        content, modified = raw if isinstance(raw, tuple) else (raw, None)
        return {'people': parse_payroll(content), 'generatedAt': modified}
    pool = ThreadPoolExecutor(max_workers=3)
    jobs = {name: pool.submit(callback) for name, callback in [('mesa', lambda: fetch_mesa(mesa_url, mesa_token)), ('graph', lambda: fetch_graph(token_provider)), ('nomina', payroll)]}
    # Reservar tiempo para cálculo y persistencia, incluso si la autenticación se atasca.
    done, pending = wait(jobs.values(), timeout=95)
    pool.shutdown(wait=False, cancel_futures=True)
    for name, job in jobs.items():
        if job in pending:
            job.cancel()
            sources[name] = {'error': 'Fuente no disponible dentro del tiempo de actualización'}
            continue
        try:
            value = job.result()
            values[name] = value['people'] if name == 'nomina' else value
            sources[name] = {'generatedAt': value.get('generatedAt') or datetime.now(timezone.utc).isoformat(), 'counts': {k: len(v) for k, v in value.items() if isinstance(v, list)}}
            if value.get('signInError'):
                sources[name]['signInError'] = value['signInError']
            if value.get('error'):
                sources[name]['error'] = value['error']
        except Exception as exc:
            logging.warning('Hardware fuente %s: %s', name, type(exc).__name__)
            sources[name] = {'error': str(exc) if isinstance(exc, ValueError) else 'Fuente no disponible; revisar el servicio y sus permisos'}
    return build_snapshot(values['mesa'], values['nomina'], values['graph'].get('users', []), values['graph'].get('skus', []), sources, target_areas=target_areas)
