"""Cálculo de Hardware: datos de entrada inyectados, sin acceso a red."""
from hardware_v3 import computer_state, license_accounts
import re
import unicodedata
from collections import defaultdict
from datetime import date, datetime, timezone
from io import BytesIO

AREAS = ['OBRERO', 'OPERATIVO', 'TECNICO', 'ADMINISTRATIVO PROYECTOS', 'ADMINISTRATIVOS OFICINAS']
TARGET_AREAS = AREAS[2:]
STATES = ['sin_computadora', 'sin_correo', 'sin_cuenta_m365', 'cuenta_bloqueada', 'sin_licencia', 'ok']
SKU_NAMES = {
    'SPB': 'Microsoft 365 Empresa Premium', 'O365_BUSINESS_PREMIUM': 'Microsoft 365 Empresa Estándar',
    'O365_BUSINESS_ESSENTIALS': 'Microsoft 365 Empresa Básico', 'ENTERPRISEPACK': 'Office 365 E3', 'STANDARDPACK': 'Office 365 E1',
    'SPE_E3': 'Microsoft 365 E3', 'SPE_E5': 'Microsoft 365 E5', 'Microsoft_365_Copilot': 'Microsoft 365 Copilot',
    'EXCHANGESTANDARD': 'Exchange Online (Plan 1)', 'EXCHANGEENTERPRISE': 'Exchange Online (Plan 2)', 'FLOW_FREE': 'Power Automate Free',
    'POWER_BI_STANDARD': 'Power BI (gratis)', 'POWER_BI_PRO': 'Power BI Pro', 'PROJECTPROFESSIONAL': 'Project Plan 3',
    'VISIOCLIENT': 'Visio Plan 2', 'TEAMS_EXPLORATORY': 'Teams Exploratory', 'O365_BUSINESS': 'Microsoft 365 Apps para empresas',
    'BUSINESS_PREMIUM_AND_MICROSOFT_365_COPILOT_FOR_BUSINESS': 'Microsoft 365 Empresa Premium + Copilot',
    'BUSINESS_PREMIUM_NO_TEAMS_AND_COPILOT_FOR_BUSINESS': 'Microsoft 365 Empresa Premium (sin Teams) + Copilot',
    'BUSINESS_STANDARD_NO_TEAMS_AND_COPILOT_FOR_BUSINESS': 'Microsoft 365 Empresa Estándar (sin Teams) + Copilot',
    'MICROSOFT_365_COPILOT_FOR_BUSINESS': 'Microsoft 365 Copilot (empresas)', 'Microsoft_365_Business_Basic_(no Teams)': 'Microsoft 365 Empresa Básico (sin Teams)',
    'Microsoft_365_E5_(no_Teams)': 'Microsoft 365 E5 (sin Teams)', 'Office_365_E1_(no_Teams)': 'Office 365 E1 (sin Teams)',
    'EXCHANGEDESKLESS': 'Exchange Online Kiosk', 'INTUNE_A_D': 'Intune (dispositivos)', 'MCOEV': 'Teams Phone', 'AAD_PREMIUM_P2': 'Entra ID P2',
    'OFFICESUBSCRIPTION': 'Microsoft 365 Apps para empresas', 'WACONEDRIVEENTERPRISE': 'OneDrive (Plan 2)', 'PROJECT_PLAN3_DEPT': 'Project Plan 3',
    'POWERAPPS_DEV': 'Power Apps (desarrollador)', 'POWERAPPS_VIRAL': 'Power Apps (prueba)', 'AGENT_365': 'Agent 365',
    'Microsoft_Teams_Exploratory_Dept': 'Teams Exploratory', 'PHONESYSTEM_VIRTUALUSER': 'Teams Phone (cuenta de recurso)',
}


def text(value):
    return str(value or '').strip()


def normalized(value):
    return ''.join(c for c in unicodedata.normalize('NFD', text(value).upper()) if unicodedata.category(c) != 'Mn')


def cedula(value):
    value = text(value).removesuffix('.0')
    return value.zfill(10) if value.isdigit() else value


def day(value):
    if isinstance(value, (datetime, date)):
        return value.date() if isinstance(value, datetime) else value
    for fmt in ('%Y-%m-%d', '%d/%m/%Y', '%d-%m-%Y'):
        try:
            return datetime.strptime(text(value)[:10], fmt).date()
        except ValueError:
            pass
    return None


def purchase_year(value):
    parsed = day(value)
    return str(parsed.year) if parsed and parsed.year != 2000 else 'sin fecha'


def project(value, homologated=True):
    value = text(value)
    match = re.match(r'^(\d+)', value)
    code = match.group(1) if match else ''
    name = re.sub(r'-?Genérico\s*$', '', value, flags=re.I)
    name = re.sub(r'^\d+\s*[-–]?\s*', '', name).strip(' -')
    return {'code': code, 'name': name or 'Sin proyecto', 'homologated': homologated}


def parse_payroll(content, today=None):
    from openpyxl import load_workbook
    today = today or date.today()
    book = load_workbook(BytesIO(content), read_only=True, data_only=True)
    try:
        if 'Ecuador' not in book.sheetnames:
            raise ValueError('Falta la hoja Ecuador')
        rows = iter(book['Ecuador'].iter_rows(values_only=True))
        header = next((r for r in rows if sum(v is not None and text(v) != '' for v in r) >= 5), ())
        names = [normalized(v) for v in header]
        required = ['CEDULA', 'NOMBRES', 'CARGOS', 'F. INGRESO', 'F. SALIDA', 'PROYECTO', 'AREA', 'CCOS NOMBRE', 'SOFTWARE DISEÑO', 'EMPRESA']
        if any(normalized(k) not in names for k in required):
            raise ValueError('Encabezados de nómina incompletos')
        result = {}
        for row in rows:
            data = dict(zip(names, row))
            key = cedula(data.get('CEDULA'))
            if not key:
                continue
            end = day(data.get('F. SALIDA'))
            if end and end < today:
                continue
            result[key] = {'cedula': key, 'name': text(data.get('NOMBRES')), 'position': text(data.get('CARGOS')), 'area': normalized(data.get('AREA')), 'project': project(data.get('PROYECTO')), 'company': text(data.get('EMPRESA'))}
        return list(result.values())
    finally:
        book.close()


def email_index(users):
    result = {}
    for user in users:
        for address in [user.get('userPrincipalName'), user.get('mail'), *(user.get('proxyAddresses') or [])]:
            address = re.sub(r'^smtp:', '', text(address), flags=re.I).lower()
            if address:
                result[address] = user
    return result


PARTICLES = {'DE', 'DEL', 'LA', 'LAS', 'LOS', 'Y'}


def name_tokens(value):
    return [t for t in re.split(r'[^A-Z]+', normalized(value)) if t]


def name_directory(users):
    # Se prepara una vez: tokens del nombre visible y usuario del correo de cada cuenta.
    return [(u, set(name_tokens(u.get('displayName'))), text(u.get('userPrincipalName')).split('@')[0].lower()) for u in users]


def account_by_name(name, ced, directory):
    """Cuenta M365 de una persona sin correo en nómina ni RIP_TIC: por cédula (employeeId) o por nombre.
    Nómina: «APELLIDO1 APELLIDO2 NOMBRE1 NOMBRE2». Exige el primer apellido y un nombre, y una sola cuenta ganadora."""
    for user, _, _ in directory:
        if ced and cedula(user.get('employeeId')) == ced:
            return user
    tokens = [t for t in name_tokens(name) if t not in PARTICLES]
    if len(tokens) < 3:
        return None
    surname, second, given = tokens[0], tokens[1], tokens[2:]
    best, best_score, tie = None, 0, False
    for user, words, local in directory:
        if surname not in words or not any(g in words for g in given):
            continue
        score = 2 + (second in words) + sum(g in words for g in given) + 2 * (local == (given[0][0] + surname).lower()) + bool(user.get('accountEnabled'))
        if score > best_score:
            best, best_score, tie = user, score, False
        elif score == best_score:
            tie = True
    return None if tie else best


def person_status(computers, email, account):
    if not computers:
        return STATES[0]
    if not email:
        return STATES[1]
    if account is None:
        return STATES[2]
    if not account.get('accountEnabled'):
        return STATES[3]
    return 'ok' if account.get('assignedLicenses') else 'sin_licencia'


def real_person(key):
    # Cédulas de relleno de RIP_TIC (1111111111, 2222222222...) no son personas.
    return bool(key) and len(set(key)) > 1


def prepare_equipment(mesa, people):
    assignments = {}
    for a in sorted(mesa.get('assignments', []), key=lambda a: text(a.get('date'))):
        assignments[str(a.get('itemId'))] = a
    custodians = {cedula(p.get('cedula')): p for p in mesa.get('custodians', [])}
    rows = []
    for item in mesa.get('items', []):
        a = assignments.get(str(item.get('id')), {})
        key = cedula(a.get('cedula'))
        person = people.get(key)
        # Proyecto de la asignación: código + nombre (la Mesa ya resolvió el nombre por TIC_Proyecto → S10 → vista de RIP_TIC).
        assigned = ' '.join(dict.fromkeys(t for t in (text(a.get('projectCode')), text(a.get('projectName'))) if t))
        canonical = person['project'] if person else project(assigned, False)
        companies = item.get('companies') or ['Sin empresa']
        if isinstance(companies, str):
            companies = [companies]
        area = person.get('area') if person else ''
        area = area if area in AREAS else ('fuera de nómina' if key else 'sin asignar/bodega')
        kind = normalized(item.get('type'))
        # Inactiva en RIP_TIC pero con asignación vigente a una persona real: la tiene en la mano, cuenta como activa.
        # Calidad de datos la lista para que TI la reactive (o cierre la asignación si de verdad está dañada).
        to_activate = not item.get('active') and kind in ('LAPTOP', 'CPU') and real_person(key)
        rows.append({**item, 'active': bool(item.get('active')) or to_activate, 'toActivate': to_activate, 'type': kind, 'value': float(item.get('value') or 0), 'year': purchase_year(item.get('purchaseDate')), 'companies': companies, 'cedula': key, 'project': canonical, 'area': area, 'usage': a.get('usage'), 'usageDate': a.get('usageDate'), 'inPayroll': key in people, 'assignmentDate': a.get('date'), 'ripProject': assigned, 'custodian': (person or {}).get('name') or custodians.get(key, {}).get('name') or ''})
    return rows


def equipment_blocks(items, disposals, requests, year):
    by_type, purchases, companies, reasons, years, states = (defaultdict(lambda: defaultdict(float)) for _ in range(6))
    lookup = {str(i['id']): i for i in items}
    for i in items:
        by_type[i['type']]['active' if i.get('active') else 'disposed'] += 1
        purchases[(i['year'], i['type'])]['count'] += 1
        purchases[(i['year'], i['type'])]['value'] += i['value']
        # Copropiedad: repartir el valor evita inflar el total financiero.
        for company in i['companies']:
            companies[(i['year'], text(company))]['count'] += 1
            companies[(i['year'], text(company))]['value'] += i['value'] / len(i['companies'])
    ds, rs = [], []
    for d in disposals:
        if str(d.get('itemId')) not in lookup:
            continue
        disposal_day = day(d.get('date'))
        d = {**d, 'year': str(disposal_day.year) if disposal_day else 'sin fecha', 'reason': text(d.get('reason')) or 'Sin motivo'}
        ds.append(d)
        reasons[d['reason']]['count'] += 1
        years[(d['year'], d['reason'])]['count'] += 1
    for r in requests:
        if str(r.get('itemId')) not in lookup:
            continue
        state = normalized(r.get('state'))
        category = 'autorizadas' if 'AUTORIZ' in state or 'APROBAD' in state else 'rechazadas' if 'RECHAZ' in state else 'en_proceso'
        r = {**r, 'category': category, 'code': lookup[str(r['itemId'])].get('code'), 'equipmentType': lookup[str(r['itemId'])]['type']}
        rs.append(r)
        states[(text(r.get('state')) or 'Sin estado', text(r.get('reason')) or 'Sin motivo')]['count'] += 1
    def flatten(data, keys):
        return [dict(zip(keys, k if isinstance(k, tuple) else (k,)), **v) for k, v in data.items()]
    active = [i for i in items if i.get('active')]
    return {'byType': flatten(by_type, ['type']), 'purchasesByYear': flatten(purchases, ['year', 'type']), 'companiesByYear': flatten(companies, ['year', 'company']), 'disposalsByReason': flatten(reasons, ['reason']), 'disposalsByYear': flatten(years, ['year', 'reason']), 'disposalRequestsByState': flatten(states, ['state', 'reason']), 'disposals': ds, 'disposalRequests': rs, 'equipmentKpis': {'activeEquipment': len(active), 'activeComputers': sum(i['type'] in ('LAPTOP', 'CPU') for i in active), 'laptops': sum(i['type'] == 'LAPTOP' for i in active), 'cpu': sum(i['type'] == 'CPU' for i in active), 'activeValue': sum(i['value'] for i in active), 'purchasedThisYear': sum(i['year'] == str(year) for i in items), 'disposalsTotal': len(ds), 'disposalsThisYear': sum(d['year'] == str(year) for d in ds), **{c: sum(r['category'] == c for r in rs) for c in ('en_proceso', 'autorizadas', 'rechazadas')}}}


def coverage_block(people, items, mesa, users, skus, target_areas):
    accounts, directory = email_index(users), name_directory(users)
    payroll = {cedula(p.get('cedula')): p for p in mesa.get('payroll', [])}
    custodians = {cedula(p.get('cedula')): p for p in mesa.get('custodians', [])}
    licenses = {s['skuId']: SKU_NAMES.get(s.get('skuPartNumber'), s.get('skuPartNumber')) for s in skus}
    computers = defaultdict(list)
    for i in items:
        if i.get('active') and i['type'] in ('LAPTOP', 'CPU'):
            computers[i['cedula']].append({**{k: i.get(k) for k in ('code', 'type', 'brand', 'model', 'year')}, 'inactive': bool(i.get('toActivate'))})
    rows = []
    for key, p in people.items():
        if p.get('area') not in target_areas:
            continue
        email = text(payroll.get(key, {}).get('email') or custodians.get(key, {}).get('email')).lower()
        account, source = accounts.get(email), 'Nómina / RIP_TIC' if email else ''
        if account is None:
            # Nómina y RIP_TIC casi nunca traen el correo: se busca la cuenta en M365 por cédula o nombre.
            found = account_by_name(p.get('name'), key, directory)
            if found:
                account, source = found, 'M365 por nombre'
                email = text(found.get('mail') or found.get('userPrincipalName')).lower()
        rows.append({**p, 'email': email, 'emailSource': source, 'status': person_status(computers[key], email, account), 'licenses': [licenses.get(l['skuId'], l['skuId']) for l in (account or {}).get('assignedLicenses', [])], 'computers': computers[key]})
    return {'people': rows, 'byArea': [{'area': area, **{s: sum(p['area'] == area and p['status'] == s for p in rows) for s in STATES}} for area in target_areas]}


def project_blocks(items, coverage):
    projects = {}
    areas = {a: 0 for a in [*AREAS, 'fuera de nómina', 'sin asignar/bodega']}
    def row(p):
        key = (p['code'], p['name'], p['homologated'])
        return projects.setdefault(key, {**p, 'laptops': 0, 'cpu': 0, 'other': 0, 'value': 0, 'targetPeople': 0, 'withoutComputer': 0, 'purchasesByYear': {}, 'states': {}})
    for i in items:
        r = row(i['project'])
        r['purchasesByYear'][i['year']] = r['purchasesByYear'].get(i['year'], 0) + 1
        state = 'vigente' if i.get('active') else 'baja'
        r['states'][state] = r['states'].get(state, 0) + 1
        if not i.get('active'):
            continue
        r['laptops' if i['type'] == 'LAPTOP' else 'cpu' if i['type'] == 'CPU' else 'other'] += 1
        r['value'] += i['value']
        if i['type'] == 'LAPTOP':
            areas[i['area'] or 'fuera de nómina'] = areas.get(i['area'], 0) + 1
    for p in coverage['people']:
        r = row(p['project'])
        r['targetPeople'] += 1
        r['withoutComputer'] += p['status'] == 'sin_computadora'
    return {'byProject': list(projects.values()), 'laptopsByArea': [{'area': a, 'count': n} for a, n in areas.items()]}


def quality_block(items, people, catalog, mesa_catalog=None):
    recover = [i for i in items if i.get('active') and i['cedula'] and i['cedula'] not in people]
    projects = defaultdict(int)
    for i in items:
        rip_code = project(i['ripProject'])['code']
        if i.get('catalogMatch') or resolve_project(i['ripProject'], mesa_catalog or {}):
            continue
        if i['cedula'] and (not rip_code or rip_code not in catalog):
            projects[i['ripProject'] or 'Sin proyecto'] += 1
    # Solo ids: los equipos completos ya viajan en items (copiarlos aquí duplicaba ~2 MB de la foto).
    return {'recoverEquipment': [i['id'] for i in recover], 'unmatchedProjects': [{'project': p, 'count': n} for p, n in projects.items()], 'withoutPurchaseDate': [i['id'] for i in items if i['year'] == 'sin fecha'], 'unassignedComputers': [i['id'] for i in items if i.get('active') and i['type'] in ('LAPTOP', 'CPU') and not i['cedula']], 'toActivate': [i['id'] for i in items if i.get('toActivate')]}



def license_block(users, skus, coverage_people):
    """Licencias de Microsoft 365: compradas, asignadas, libres, en cuentas bloqueadas y en el personal objetivo."""
    names = {s.get('skuId'): SKU_NAMES.get(s.get('skuPartNumber'), s.get('skuPartNumber')) for s in skus or []}
    blocked = defaultdict(int)
    blocked_people = []
    for u in users or []:
        if u.get('accountEnabled') is False and u.get('assignedLicenses'):
            lic = [names.get(l.get('skuId'), l.get('skuId')) for l in u['assignedLicenses']]
            for name in lic:
                blocked[name] += 1
            blocked_people.append({'account': text(u.get('userPrincipalName')).lower(), 'licenses': lic})
    in_target = defaultdict(int)
    for person in coverage_people:
        for name in person.get('licenses') or []:
            in_target[name] += 1
    rows = []
    for sku in skus or []:
        name = names.get(sku.get('skuId'))
        bought = int((sku.get('prepaidUnits') or {}).get('enabled') or 0)
        used = int(sku.get('consumedUnits') or 0)
        if not bought and not used:
            continue
        rows.append({'license': name, 'sku': sku.get('skuPartNumber'), 'purchased': bought, 'assigned': used,
                     'available': max(bought - used, 0), 'blockedAccounts': blocked.get(name, 0), 'targetPeople': in_target.get(name, 0)})
    rows.sort(key=lambda r: -r['assigned'])
    return {'bySku': rows, 'blockedWithLicense': blocked_people}


def cost_center_code(value):
    match = re.match(r'^\s*(\d{3,})', text(value))
    return match.group(1) if match else ''


def cost_center_block(people, items, mesa):
    """Centro de costo de TI (custodio en RIP_TIC) frente al de Talento Humano (nómina), por código numérico.
    Y equivalencias entre el código de obra que usa TI en las asignaciones y el centro de costo de nómina."""
    custodians = {cedula(c.get('cedula')): c for c in mesa.get('custodians', [])}
    holders = defaultdict(list)
    for i in items:
        if i.get('active') and i.get('cedula'):
            holders[i['cedula']].append(i)
    rows = []
    for key, person in people.items():
        if key not in holders and key not in custodians:
            continue
        th = person.get('project') or {}
        ti_raw = text((custodians.get(key) or {}).get('costCenter'))
        ti_code = cost_center_code(ti_raw)
        status = 'sin_registro_ti' if not ti_raw else 'coincide' if ti_code and ti_code == th.get('code') else 'distinto'
        rows.append({'cedula': key, 'name': person.get('name'), 'area': person.get('area'), 'thCode': th.get('code'), 'thName': th.get('name'),
                     'tiCostCenter': ti_raw, 'tiCode': ti_code, 'status': status, 'equipment': len(holders.get(key, []))})
    counts = {k: sum(r['status'] == k for r in rows) for k in ('coincide', 'distinto', 'sin_registro_ti')}
    # Equivalencias: para cada código de obra de TI, el centro de costo de nómina más común entre quienes tienen esos equipos.
    tally = defaultdict(lambda: defaultdict(int))
    ti_names = {}
    for a in mesa.get('assignments', []):
        ti_code = text(a.get('projectCode')) or 'sin código'
        ti_names.setdefault(ti_code, text(a.get('projectName')))
        person = people.get(cedula(a.get('cedula')))
        th = (person or {}).get('project') or {}
        tally[ti_code][f"{th.get('code')} · {th.get('name')}" if th.get('code') else 'Fuera de nómina'] += 1
    equivalences = []
    for ti_code, targets in tally.items():
        total = sum(targets.values())
        outside = targets.get('Fuera de nómina', 0)
        inside = {k: v for k, v in targets.items() if k != 'Fuera de nómina'}
        best, n = max(inside.items(), key=lambda kv: kv[1]) if inside else ('Sin personas en nómina', 0)
        equivalences.append({'tiCode': ti_code, 'tiName': ti_names.get(ti_code) or '', 'thProject': best,
                             'share': round(100 * n / (total - outside)) if total > outside else 0, 'assignments': total,
                             'outsidePayroll': outside, 'alternatives': max(len(inside) - 1, 0)})
    equivalences.sort(key=lambda r: -r['assignments'])
    return {'people': rows, 'counts': counts, 'equivalences': equivalences}


def median(values):
    ordered = sorted(values)
    if not ordered:
        return None
    mid = len(ordered) // 2
    return ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2


def supplier_block(items, suppliers):
    """Compras por año y proveedor. RIP_TIC guarda el RUC; el nombre viene de S10."""
    names = {text(s.get('ruc')): text(s.get('name')) for s in suppliers or []}
    groups = defaultdict(lambda: {'count': 0, 'value': 0.0})
    for item in items:
        ruc = text(item.get('supplierRuc'))
        if not ruc or ruc.upper() == 'N/A':
            ruc, name = '', 'Sin factura en RIP_TIC'
        else:
            name = names.get(ruc) or ruc
        row = groups[(item['year'], ruc, name)]
        row['count'] += 1
        row['value'] += item['value']
    return [{'year': y, 'ruc': r, 'supplier': n, **v} for (y, r, n), v in groups.items()]


def durability_block(items, disposals, today):
    """Vida útil real = meses entre la compra y la baja; y antigüedad del parque vigente."""
    lookup = {str(i['id']): i for i in items}
    months_by_type, months_by_reason = defaultdict(list), defaultdict(list)
    for d in disposals:
        item = lookup.get(str(d.get('itemId')))
        bought, gone = day(item.get('purchaseDate')) if item else None, day(d.get('date'))
        if not item or not bought or bought.year == 2000 or not gone or gone < bought:
            continue
        months = round((gone - bought).days / 30.44, 1)
        months_by_type[item['type']].append(months)
        months_by_reason[text(d.get('reason')) or 'Sin motivo'].append(months)

    def summary(groups, key):
        return sorted(({key: k, 'count': len(v), 'medianMonths': median(v), 'avgMonths': round(sum(v) / len(v), 1)}
                       for k, v in groups.items()), key=lambda r: -r['count'])

    buckets = [('< 1 año', 0, 1), ('1-2 años', 1, 2), ('2-3 años', 2, 3), ('3-5 años', 3, 5), ('5+ años', 5, 999)]
    ages = defaultdict(lambda: defaultdict(int))
    for item in items:
        bought = day(item.get('purchaseDate'))
        if not item.get('active') or item['type'] not in ('LAPTOP', 'CPU'):
            continue
        if not bought or bought.year == 2000:
            ages['sin fecha'][item['type']] += 1
            continue
        years = (today - bought).days / 365.25
        label = next(b for b, lo, hi in buckets if lo <= years < hi)
        ages[label][item['type']] += 1
    order = [b for b, _, _ in buckets] + ['sin fecha']
    fleet = [{'bucket': b, 'LAPTOP': ages[b].get('LAPTOP', 0), 'CPU': ages[b].get('CPU', 0)} for b in order]
    return {'byType': summary(months_by_type, 'type'), 'byReason': summary(months_by_reason, 'reason'), 'fleetAge': fleet}


def site_catalog(mesa):
    """Catálogo único de la Mesa (sitios + alias): nombre normalizado o código → proyecto homologado."""
    index = {}
    for site in mesa.get('sites') or []:
        code = text(site.get('code') or site.get('gpCode'))
        entry = {'code': code, 'name': text(site.get('name')) or 'Sin proyecto', 'homologated': True}
        for key in [site.get('code'), site.get('gpCode'), site.get('name'), *(site.get('aliases') or [])]:
            key = normalized(key)
            if key:
                index.setdefault(key, entry)
    return index


def resolve_project(value, catalog):
    """Busca el proyecto libre de RIP_TIC en el catálogo de la Mesa: texto completo, sin código o por código."""
    value = text(value)
    if not value or not catalog:
        return None
    parsed = project(value)
    for key in (value, parsed['name'], parsed['code']):
        hit = catalog.get(normalized(key))
        if hit:
            return hit
    return None


def mesa_extras(items, mesa):
    """Sede del custodio, póliza vigente y proyecto homologado con el catálogo de la Mesa (datos opcionales)."""
    sites = {cedula(p.get('cedula')): p for p in mesa.get('payroll') or [] if p.get('site') or p.get('city')}
    policies = {}
    for row in mesa.get('insurance') or []:
        key = text(row.get('itemCode')).upper()
        if key and text(row.get('to')) >= text(policies.get(key, {}).get('to')):
            policies[key] = row
    catalog = site_catalog(mesa)
    for item in items:
        place = sites.get(item['cedula']) or {}
        item['site'] = text(place.get('site')) or None
        item['city'] = text(place.get('city')) or None
        item['siteKind'] = text(place.get('siteKind')) or None
        policy = policies.get(text(item.get('code')).upper())
        if policy:
            item.update(insurer=text(policy.get('insurer')) or None, policy=text(policy.get('policy')) or None,
                        insuredFrom=day(policy.get('from')) and str(day(policy.get('from'))),
                        insuredTo=day(policy.get('to')) and str(day(policy.get('to'))),
                        insuredValue=float(policy.get('insuredValue') or 0))
        if not item['project'].get('homologated'):
            hit = resolve_project(item.get('ripProject'), catalog)
            if hit:
                item['project'], item['catalogMatch'] = hit, True
    return catalog


def deliveries_block(mesa):
    """Equipos pedidos por ticket en la Mesa: Pendiente → Aprobado → Entregado / Rechazado."""
    rows = []
    for row in mesa.get('deliveries') or []:
        created, delivered = day(row.get('createdAt')), day(row.get('deliveredAt'))
        rows.append({**row, 'state': text(row.get('state')) or 'Pendiente', 'itemType': normalized(row.get('itemType')) or 'SIN TIPO',
                     'createdAt': created and str(created), 'deliveredAt': delivered and str(delivered),
                     'deliveryDays': (delivered - created).days if created and delivered else None})
    return rows


def build_snapshot(mesa=None, payroll=None, users=None, skus=None, sources=None, today=None, target_areas=None):
    mesa, today = mesa or {}, today or date.today()
    target_areas = [normalized(a) for a in (target_areas or TARGET_AREAS)]
    # Una nómina cargada es autoritativa: las salidas no reaparecen vía NominaGP.
    people = {p['cedula']: dict(p) for p in (payroll or [])}
    if payroll is None:
        people = {cedula(p.get('cedula')): {**p, 'cedula': cedula(p.get('cedula')), 'area': '', 'project': project(p.get('costCenter'))} for p in mesa.get('payroll', [])}
    catalog = {p['project']['code']: p['project'] for p in people.values() if p['project']['code']}
    for p in people.values():
        p['project'] = catalog.get(p['project']['code'], p['project'])
    assignment_people = dict(people)
    for p in mesa.get('payroll', []):
        key = cedula(p.get('cedula'))
        if key and key not in assignment_people:
            fallback = project(p.get('costCenter'))
            assignment_people[key] = {**p, 'area': '', 'project': catalog.get(fallback['code'], fallback)}
    items = prepare_equipment(mesa, assignment_people)
    for item in items:
        item['inPayroll'] = item['cedula'] in people
        item['equipmentState'] = computer_state(item)
    mesa_catalog = mesa_extras(items, mesa)
    blocks = equipment_blocks(items, mesa.get('disposals', []), mesa.get('disposalRequests', []), today.year)
    coverage = coverage_block(people, items, mesa, users or [], skus or [], target_areas)
    count = len(coverage['people'])
    kpis = blocks.pop('equipmentKpis')
    kpis.update(targetPeople=count, withComputerPercent=round(100 * sum(p['status'] != 'sin_computadora' for p in coverage['people']) / count, 1) if count else 0, licensedEmailPercent=round(100 * sum(p['status'] == 'ok' for p in coverage['people']) / count, 1) if count else 0)
    blocks['purchasesBySupplier'] = supplier_block(items, mesa.get('suppliers', []))
    blocks['durability'] = durability_block(items, mesa.get('disposals', []), today)
    blocks['licenses'] = license_block(users or [], skus or [], coverage['people'])
    contacts = email_index([
        {'userPrincipalName': p.get('email'), **people[cedula(p.get('cedula'))]}
        for p in [*mesa.get('custodians', []), *mesa.get('payroll', [])]
        if cedula(p.get('cedula')) in people
    ])
    blocks['licenses']['accounts'] = license_accounts(users or [], skus or [], contacts)
    blocks['costCenters'] = cost_center_block(people, items, mesa)
    return {'generatedAt': datetime.now(timezone.utc).isoformat(), 'kpis': kpis, **blocks, **project_blocks(items, coverage), 'coverage': coverage, 'quality': quality_block(items, people, catalog, mesa_catalog), 'deliveries': deliveries_block(mesa), 'catalogSites': len({(v['code'], v['name']) for v in mesa_catalog.values()}), 'sources': sources or {}, 'items': items, 'payrollUploaded': payroll is not None}
