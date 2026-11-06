"""Colecciones de favoritos; almacenamiento inyectable y escrituras optimistas."""
import re
from copy import deepcopy
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat()


def origin(path):
    parts = path.split('/')
    week = next((i for i, p in enumerate(parts[1:-1], 1) if re.fullmatch(r'\d{4}_S\d{2}', p)), None)
    return parts[0], '/'.join(parts[1:week + 1]) if week is not None else '/'.join(parts[1:-1])


def members_list(raw, owner):
    if not isinstance(raw, list):
        raise ValueError('members debe ser una lista')
    out = []
    for value in raw:
        email = str(value).strip().lower()
        local = email.split('@')[0]
        if len(email) > 254 or len(local) > 64 or local.startswith('.') or local.endswith('.') or '..' in local or not re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+", email):
            raise ValueError('Correo inválido')
        if email != owner and email not in out:
            out.append(email)
    if len(out) > 50:
        raise ValueError('Máximo 50 miembros')
    return out


class Favorites:
    def __init__(self, read, write, prefix, personal_key):
        self.read, self.write = read, write
        self.base, self.personal_key = prefix.strip('/') + '/favorites/', personal_key

    def cas(self, key, change, default=None):
        for attempt in range(6):  # primer intento y hasta cinco reintentos
            data, etag = self.read(key)
            data = deepcopy(data if data is not None else default)
            result = change(data)
            try:
                self.write(key, data, etag)
                return result
            except Exception as exc:
                if getattr(exc, 'status_code', None) not in (409, 412) or attempt == 5:
                    raise

    def shared_key(self, cid):
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', cid):
            raise ValueError('Colección inválida')
        return self.base + 'shared/' + cid + '.json'

    def personal(self, email):
        data, _ = self.read(self.personal_key(email))
        return data or {'collections': []}

    def shared(self, cid):
        data, _ = self.read(self.shared_key(cid))
        return data if data and not data.get('deleted') else None

    def permit(self, col, email, owner=False):
        if not col or col.get('deleted'):
            raise LookupError('Colección no encontrada')
        if email != col['owner'] and (owner or email not in col.get('members', [])):
            raise PermissionError('No tienes permiso para esta colección')

    def decorate(self, col, email):
        col = deepcopy(col)
        col.update(shared=True, role='owner' if col['owner'] == email else 'editor')
        return col

    def create(self, email, col):
        def change(data):
            if len(data['collections']) >= 200:
                raise ValueError('Máximo 200 colecciones')
            data['collections'].append(col)
        self.cas(self.personal_key(email), change, {'collections': []})
        return col

    def get(self, email):
        index, _ = self.read(self.base + 'shared-index.json')
        index = index or {}
        cols = [c for c in self.personal(email)['collections'] if c['id'] not in index]
        for cid, entry in index.items():
            if email == entry['owner'] or email in entry.get('members', []):
                col = self.shared(cid)
                if col and (col['owner'] == email or email in col.get('members', [])):
                    cols.append(self.decorate(col, email))
        for col in cols:
            for item in col.get('items', []):
                project, folder = origin(item['path'])
                item.update(projectCode=project, week=folder, folder=folder)
        paths = list(dict.fromkeys(it['path'] for c in cols for it in c.get('items', [])))
        return {'collections': cols, 'paths': paths}

    def sync_index(self, cid):
        def change(index):
            col = self.shared(cid)
            if col:
                index[cid] = {k: col[k] for k in ('name', 'owner', 'members')}
            else:
                index.pop(cid, None)
        self.cas(self.base + 'shared-index.json', change, {})

    def mutate(self, email, cid, change, owner=False, metadata=False):
        if self.shared(cid):
            def edit(col):
                self.permit(col, email, owner)
                change(col)
                col.update(updatedAt=now(), updatedBy=email)
                return self.decorate(col, email)
            result = self.cas(self.shared_key(cid), edit)
            if metadata:
                self.sync_index(cid)
            return result
        def edit_personal(data):
            col = next((c for c in data['collections'] if c['id'] == cid), None)
            if not col:
                raise LookupError('Colección no encontrada')
            change(col)
            if col.get('deleted'):
                data['collections'].remove(col)
            return deepcopy(col)
        return self.cas(self.personal_key(email), edit_personal, {'collections': []})

    def set_members(self, email, cid, raw):
        members = members_list(raw, email)
        existing = self.shared(cid)
        if not existing:
            personal = next((c for c in self.personal(email)['collections'] if c['id'] == cid), None)
            if not personal:
                raise LookupError('Colección no encontrada')
            def move(col):
                if col:
                    self.permit(col, email, True)
                else:
                    col.update(deepcopy(personal), owner=email, members=[])
                col.update(members=members, updatedAt=now(), updatedBy=email)
            self.cas(self.shared_key(cid), move, {})
        else:
            self.mutate(email, cid, lambda c: c.update(members=members), owner=True)
        self.sync_index(cid)
        # Publicar antes de retirar la copia personal permite reanudar una migración fallida.
        self.cas(self.personal_key(email), lambda d: d.update(collections=[c for c in d['collections'] if c['id'] != cid]), {'collections': []})
        return self.get(email)

    def leave(self, email, cid):
        if not self.shared(cid):
            raise LookupError('Colección no encontrada')
        def change(col):
            if col['owner'] == email:
                raise PermissionError('El dueño no puede salir de la colección')
            col['members'].remove(email)
        self.mutate(email, cid, change, metadata=True)
        return self.get(email)

    def item(self, email, cid, item, remove=False):
        targets = [cid] if cid else [c['id'] for c in self.get(email)['collections']]
        for target in targets:
            def change(col):
                items = col.setdefault('items', [])
                if remove:
                    col['items'] = [it for it in items if it['path'] != item['path']]
                elif not any(it['path'] == item['path'] for it in items):
                    items.append(dict(item, addedBy=email, addedAt=now()))
            try:
                self.mutate(email, target, change)
            except (PermissionError, LookupError):
                if cid or not remove:
                    raise
        return self.get(email)
