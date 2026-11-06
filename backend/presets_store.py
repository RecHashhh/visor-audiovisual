"""Cargas guardadas; persistencia inyectada para probar sin red."""
from copy import deepcopy
from datetime import datetime, timezone
from urllib.parse import urlsplit
import math
import re
import uuid


def now():
    return datetime.now(timezone.utc).isoformat()


def seed_presets():
    sp = "https://ripconcivcialtda.sharepoint.com/sites/"
    rows = [
        ("Vivantino — Vuelos dron", "33013", "vivantino", "DRN", None),
        ("Promart Quitumbe — 03.10 Fotos y videos", "33014", "promart-quitumbe", "DRN", "GestindeProyectos/Documentos%20compartidos/33014%20PROMART%20QUITUMBE%20FASE%20IV%20EPC/03.%20INFORMACION%20TECNICA%20QUITUMBE%20EPC/03.10%20FOTOS%20Y%20VIDEOS"),
        ("Attiva — Video 2020", "00000", "attiva", "FOT", "BibliotecaProyectos/Documentos compartidos/General/00.Proyectos/98.Video 2020/Attiva"),
        ("Puente Daule — Video 2020", "00000", "puente-daule", "FOT", "BibliotecaProyectos/Documentos compartidos/General/00.Proyectos/98.Video 2020/Puente Daule"),
        ("Pavimento Zona W — Fotos y videos", "22012", "pavimento-zona-wpto-posorja", "FOT", "GestindeProyectos/Documentos%20compartidos/22012%20PAVIMENTO%20ZONA%20W%20PTO%20POSORJA/02.%20PLANIFICACION%20Y%20CONTROL/02.6%20FOTOS%20Y%20VIDEOS"),
        ("Vial 4 Av. Las Américas — Fotos y videos", "19004", "vial-4-av-las-americas", "FOT", "GestindeProyectos/Documentos%20compartidos/19004%20VIAL%204%20%20AV%20DE%20LAS%20AMERICAS/02.%20PLANIFICACION%20Y%20CONTROL/02.7%20FOTOS%20Y%20VIDEOS"),
        ("Promart Orellana — Fotos y videos", "22006", "promart-orellana", "DRN", "GestindeProyectos/Documentos%20compartidos/22006%20PROMART%20ORELLANA/02.%20PLAN.%20Y%20CNTRL%20PROMART/02.6%20FOTOS%20Y%20VIDEOS%20PROMART"),
        ("PTAP Mancha Grande — Fotos y videos", "22005", "ptap-mancha-grande", "DRN", "GestindeProyectos/Documentos%20compartidos/22005%20PTAP%20MANCHA%20GRANDE/02.%20PLANIFICACION%20Y%20CONTROL/02.6%20FOTOS%20Y%20VIDEOS"),
        ("Promart Congregación EPC — Miguel Larrea", "27020", "promart-congregacion-epc", "DRN", "BibliotecaProyectos/Documentos%20compartidos/Miguel%20Larrea/FOTOGRAI%CC%81AS%20-%20VIDEOS"),
        ("Puente los Pájaros — Simón Bolívar", "00000", "puente-los-pajaros", "DRN", "BibliotecaProyectos/Documentos%20compartidos/General/00.Proyectos/Sim%C3%B3nBolivar/33.Puente%20los%20pajaros"),
    ]
    stamp = now()
    return [dict(id=f"notebook-{i + 1}", name=name, projectCode=code, projectName=short, prefijo=prefix,
                 source="sharepoint" if path else "onedrive", recursive=True, subfolder="",
                 createdBy="notebook", updatedAt=stamp,
                 **({"sharepointUrl": sp + path} if path else {"userEmail": "wperalta@ripconciv.com", "folderPath": "/CONSULTORES/CC-VIVANTINO/VUELOS DRON"}))
            for i, (name, code, short, prefix, path) in enumerate(rows)]


def validate_preset(body):
    if not isinstance(body, dict):
        raise ValueError("Carga inválida")
    result = {}
    for key in ("name", "source", "projectCode", "projectName", "prefijo"):
        value = body.get(key)
        if not isinstance(value, str) or not value.strip() or len(value) > 300:
            raise ValueError(f"Campo inválido: {key}")
        result[key] = value.strip()
    if result["prefijo"] not in {"FOT", "DRN", "VID", "I360", "E360"}:
        raise ValueError("Prefijo inválido")
    for key in ("projectCode", "projectName"):
        value = body.get(key, "")
        if not isinstance(value, str) or any(c in value for c in ("/", "\\")) or value.strip() in (".", ".."):
            raise ValueError(f"Campo inválido: {key}")
    subfolder = body.get("subfolder", "")
    if not isinstance(subfolder, str) or "\\" in subfolder or any(p in (".", "..") for p in subfolder.split("/")):
        raise ValueError("Subcarpeta inválida")
    result["subfolder"] = subfolder.strip().strip("/")
    result["recursive"] = body.get("recursive", True)
    if not isinstance(result["recursive"], bool):
        raise ValueError("Recursivo debe ser booleano")
    if result["source"] == "sharepoint":
        value = body.get("sharepointUrl", "")
        if not isinstance(value, str) or len(value) > 8000:
            raise ValueError("URL inválida")
        url = urlsplit(value.strip())
        if url.scheme != "https" or not (url.hostname or "").endswith(".sharepoint.com") or url.username or url.password or url.port not in (None, 443):
            raise ValueError("Usa una URL https de SharePoint")
        result["sharepointUrl"] = value.strip()
    elif result["source"] == "onedrive":
        email, folder = body.get("userEmail", ""), body.get("folderPath", "/")
        if not isinstance(email, str) or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email.strip()):
            raise ValueError("Correo inválido")
        if not isinstance(folder, str) or not folder.strip().startswith("/"):
            raise ValueError("La carpeta debe empezar con /")
        result.update(userEmail=email.strip().lower(), folderPath=folder.strip())
    else:
        raise ValueError("Origen inválido")
    return result


class Presets:
    def __init__(self, read, update, prefix):
        self.read, self.update = read, update
        self.key = f"{prefix.strip('/')}/upload-presets.json"

    def get(self):
        data = self.read(self.key)
        return data if data is not None else self.update(self.key, lambda current: current if current is not None else seed_presets())

    def save(self, body, email):
        clean = validate_preset(body)
        pid = body.get("id")
        if pid is not None and (not isinstance(pid, str) or not pid):
            raise ValueError("Identificador inválido")
        new_id, stamp = pid or uuid.uuid4().hex, now()
        def change(data):
            rows = deepcopy(data if data is not None else seed_presets())
            old = next((r for r in rows if r["id"] == new_id), None)
            if pid and old is None:
                raise KeyError("Carga no encontrada")
            item = dict(clean, id=new_id, createdBy=old["createdBy"] if old else email, updatedAt=stamp)
            if old and "lastRun" in old:
                item["lastRun"] = old["lastRun"]
            return [item if r["id"] == new_id else r for r in rows] if old else rows + [item]
        rows = self.update(self.key, change)
        return next(r for r in rows if r["id"] == new_id)

    def delete(self, pid):
        def change(data):
            rows = data if data is not None else seed_presets()
            if not any(r["id"] == pid for r in rows):
                raise KeyError("Carga no encontrada")
            return [r for r in rows if r["id"] != pid]
        self.update(self.key, change)
        return {"ok": True}

    def run_result(self, pid, body, email):
        if not isinstance(body, dict):
            raise ValueError("Resultado inválido")
        result = {"at": now(), "by": email}
        for key in ("nuevos", "existentes", "subidos", "errores", "duracionS"):
            value = body.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 or (key != "duracionS" and not isinstance(value, int)):
                raise ValueError(f"Resultado inválido: {key}")
            result[key] = value
        def change(data):
            rows = deepcopy(data if data is not None else seed_presets())
            item = next((r for r in rows if r["id"] == pid), None)
            if item is None:
                raise KeyError("Carga no encontrada")
            item.update(lastRun=result, updatedAt=result["at"])
            return rows
        self.update(self.key, change)
        return result
