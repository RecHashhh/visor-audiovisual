"""Reglas puras de estado y actividad de Microsoft 365."""
from datetime import datetime, timezone

LICENSE_PRICES = {
    "SPB": 22,
    "O365_BUSINESS_PREMIUM": 12.5,
    "O365_BUSINESS_ESSENTIALS": 6,
    "Microsoft_365_Business_Basic_(no Teams)": 4.75,
    "OFFICESUBSCRIPTION": 12,
    "ENTERPRISEPACK": 23,
    "STANDARDPACK": 10,
    "Office_365_E1_(no_Teams)": 7.75,
    "SPE_E3": 36,
    "SPE_E5": 57,
    "Microsoft_365_E5_(no_Teams)": 54.75,
    "MICROSOFT_365_COPILOT_FOR_BUSINESS": 30,
    "BUSINESS_PREMIUM_AND_MICROSOFT_365_COPILOT_FOR_BUSINESS": 52,
    "BUSINESS_PREMIUM_NO_TEAMS_AND_COPILOT_FOR_BUSINESS": 49.75,
    "BUSINESS_STANDARD_NO_TEAMS_AND_COPILOT_FOR_BUSINESS": 40.25,
    "EXCHANGESTANDARD": 4,
    "EXCHANGEENTERPRISE": 8,
    "EXCHANGEDESKLESS": 2,
    "POWER_BI_PRO": 14,
    "PROJECTPROFESSIONAL": 30,
    "PROJECT_PLAN3_DEPT": 30,
    "VISIOCLIENT": 15,
    "MCOEV": 10,
    "AAD_PREMIUM_P2": 9,
    "INTUNE_A_D": 2,
    "FLOW_FREE": 0,
    "POWER_BI_STANDARD": 0,
    "TEAMS_EXPLORATORY": 0,
    "Microsoft_Teams_Exploratory_Dept": 0,
    "POWERAPPS_VIRAL": 0,
    "POWERAPPS_DEV": 0,
    "CCIBOTS_PRIVPREV_VIRAL": 0,
    "Microsoft_Cloud_for_Sustainability_vTrial": 0,
    "PHONESYSTEM_VIRTUALUSER": 0
}


def computer_state(item):
    if 'active' in item and not item.get('active'):
        return 'Dado de baja'
    if item.get('pendingDisposal'):
        return 'En proceso de baja'
    usage, physical = item.get('usage') or '', item.get('physicalState') or ''
    if 'reparación' in usage.lower() or physical == 'En reparación':
        return 'En reparación'
    if physical == 'Con fallas':
        return 'Con fallas'
    if 'backup' in usage.lower():
        return 'Backup / stock'
    if item.get('cedula'):
        # Personal de consorcio: no está en la nómina de RIPCON, pero el equipo está en uso normal.
        return 'En uso' if item.get('inPayroll') or item.get('consortium') else 'Asignada a persona fuera de nómina'
    return 'Sin asignar (bodega)'


def last_sign_in(activity):
    values = []
    for key in ('lastSignInDateTime', 'lastNonInteractiveSignInDateTime', 'lastSuccessfulSignInDateTime'):
        raw = (activity or {}).get(key)  # Graph envía la clave con null cuando no hay ingreso
        if not raw:
            continue
        try:
            values.append(datetime.fromisoformat(str(raw).replace('Z', '+00:00')).astimezone(timezone.utc))
        except (ValueError, TypeError):
            pass
    return max(values).isoformat() if values else None


def license_accounts(users, skus, contacts):
    catalog = {s['skuId']: s.get('skuPartNumber') for s in skus}
    rows = []
    for user in users:
        assigned = [catalog.get(a.get('skuId'), a.get('skuId')) for a in user.get('assignedLicenses', [])]
        if not assigned:
            continue
        addresses = [user.get('mail'), user.get('userPrincipalName')]
        addresses.extend(a.split(':', 1)[-1] for a in user.get('proxyAddresses') or [])
        contact = next((contacts[str(address or '').lower()]
                        for address in addresses if str(address or '').lower() in contacts), {})
        rows.append({
            'account': user.get('userPrincipalName'),
            'name': contact.get('name', ''),
            'area': contact.get('area') or ('Perú' if user.get('usageLocation') == 'PE' else 'Sin cruce con nómina EC'),
            'usageLocation': user.get('usageLocation'),
            'project': contact.get('project'),
            'skus': assigned,
            'enabled': user.get('accountEnabled'),
            'lastSignIn': last_sign_in(user.get('signInActivity')),
            'activityKnown': 'signInActivity' in user,
            'createdDateTime': user.get('createdDateTime'),
        })
    return rows
