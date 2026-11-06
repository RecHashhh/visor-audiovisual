"""Clasificación de Obra; almacenamiento inyectado para pruebas sin red."""
import re
import unicodedata
from copy import deepcopy

BASE = [dict(id=id, label=label, color=color) for id, label, color in (
    ('sin-personas', 'Sin personas', 'blue'), ('imagen-limpia', 'Imagen limpia', 'accent'),
    ('revista', 'Revista', 'orange'), ('web', 'Web', 'blue'),
    ('dron', 'Dron', 'orange'), ('portada', 'Portada', 'red'))]
COLORS = ('blue', 'accent', 'orange', 'red', 'dim')


def obra_path(path):
    if not isinstance(path, str) or '\\' in path or '%' in path or any(ord(c) < 32 for c in path):
        return False
    parts = path.split('/')
    return (len(parts) >= 3 and not parts[0].startswith(('_', '.'))
            and all(p and p not in ('.', '..') for p in parts))


def paths_list(raw, limit):
    if not isinstance(raw, list) or not raw or len(raw) > limit or not all(obra_path(p) for p in raw):
        raise ValueError(f'Indica entre 1 y {limit} rutas de archivos de Obra')
    return list(dict.fromkeys(raw))


class Tags:
    def __init__(self, read, update, prefix):
        self.read, self.update = read, update
        self.catalog_key = f"{prefix.strip('/')}/tags/catalog.json"
        self.assignments_key = f"{prefix.strip('/')}/tags/assignments.json"

    def catalog(self):
        data = self.read(self.catalog_key)
        return deepcopy(BASE) if data is None else data

    def assignments(self):
        return self.read(self.assignments_key) or {}

    def visible(self, allowed):
        valid = {t['id'] for t in self.catalog()}
        return {p: [t for t in v.get('tags', []) if t in valid]
                for p, v in self.assignments().items() if obra_path(p) and allowed(p.split('/')[0])}

    def files(self, tag, allowed):
        return [dict(path=p, name=p.rsplit('/', 1)[-1], projectCode=p.split('/')[0],
                     week='/'.join(p.split('/')[1:-1]))
                for p, ids in sorted(self.visible(allowed).items()) if tag in ids]

    def apply(self, paths, add, remove, by, at):
        paths = paths_list(paths, 2000)
        for ids in (add, remove):
            if not isinstance(ids, list) or not all(isinstance(t, str) for t in ids):
                raise ValueError('Etiquetas inválidas')
        def transform(data):
            valid = {t['id'] for t in self.catalog()}
            if (set(add) | set(remove)) - valid:
                raise ValueError('La etiqueta no existe en el catálogo')
            data = dict(data or {})
            for p in paths:
                tags = sorted(((set(data.get(p, {}).get('tags', [])) | set(add)) - set(remove)) & valid)
                if tags:
                    data[p] = dict(tags=tags, by=by, at=at)
                else:
                    data.pop(p, None)
            return data
        return self.update(self.assignments_key, transform)

    def cleanup(self, paths=None, tag=None):
        def transform(data):
            result = deepcopy(data or {})
            for p in paths or []:
                result.pop(p, None)
            if tag:
                for p, value in list(result.items()):
                    value['tags'] = [t for t in value.get('tags', []) if t != tag]
                    if not value['tags']:
                        result.pop(p)
            return result
        return self.update(self.assignments_key, transform)

    def edit_catalog(self, body):
        if not isinstance(body, dict) or len(body) != 1 or not set(body) <= {'add', 'rename', 'remove'}:
            raise ValueError('Indica una acción de catálogo')
        action, value = next(iter(body.items()))
        if action != 'remove':
            if not isinstance(value, dict) or not isinstance(value.get('label'), str):
                raise ValueError('Nombre inválido')
            label = value['label'].strip()
            if not label or len(label) > 60:
                raise ValueError('El nombre admite entre 1 y 60 caracteres')
        def transform(data):
            data = deepcopy(BASE if data is None else data)
            if action == 'add':
                color = value.get('color', 'blue')
                if color not in COLORS:
                    raise ValueError('Color inválido')
                slug = re.sub(r'[^a-z0-9]+', '-', unicodedata.normalize('NFKD', label).encode('ascii', 'ignore').decode().lower()).strip('-')
                if not slug or any(t['id'] == slug for t in data):
                    raise ValueError('Ya existe una etiqueta con ese nombre o el nombre no es válido')
                data.append(dict(id=slug, label=label, color=color))
            else:
                id = value if action == 'remove' else value.get('id')
                if not any(t['id'] == id for t in data):
                    raise ValueError('La etiqueta no existe')
                if action == 'remove':
                    data = [t for t in data if t['id'] != id]
                else:
                    for t in data:
                        if t['id'] == id:
                            t['label'] = label
            return data
        result = self.update(self.catalog_key, transform)
        if action == 'remove':
            self.cleanup(tag=value)
        return result
