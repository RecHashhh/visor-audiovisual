"""
Azure Functions Backend — Visor Audiovisual
Python 3.9+ compatible
"""

import azure.functions as func
import json
import os
import logging
import uuid
import io
import time
import tempfile
import re
from urllib.parse import unquote, quote
from threading import Lock
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any
from PIL import Image, ImageOps

import requests
import base64
from azure.storage.blob import (
    BlobServiceClient,
    generate_blob_sas,
    BlobSasPermissions,
)
from azure.core import MatchConditions
from azure.core.exceptions import ResourceNotFoundError, ResourceExistsError, ResourceModifiedError
import jwt
from jwt import PyJWKClient
import uploader
from favorites_store import Favorites, origin as favorite_origin
from tags_store import Tags, paths_list as tag_paths_list
from azure.core import MatchConditions

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

# ── CONFIG ─────────────────────────────────────────────────────────────────
CONN_STR     = os.environ.get("AZURE_STORAGE_CONNECTION_STRING", "")
ACCOUNT_NAME = os.environ.get("AZURE_STORAGE_ACCOUNT", "ripconaudiovisual")
ACCOUNT_KEY  = os.environ.get("AZURE_STORAGE_KEY", "")
CONTAINER    = os.environ.get("BLOB_CONTAINER", "audiovisual")
CACHE_TTL_SECONDS = int(os.environ.get("CACHE_TTL_SECONDS", "45"))
SHARES_PREFIX = os.environ.get("SHARES_PREFIX", "_shares")
STATUS_UPLOAD_WINDOW_HOURS = int(os.environ.get("STATUS_UPLOAD_WINDOW_HOURS", "48"))
INDEX_PREFIX = os.environ.get("INDEX_PREFIX", "_index")
INDEX_ENABLED = os.environ.get("INDEX_ENABLED", "true").strip().lower() in ("1", "true", "yes", "on")
INDEX_REFRESH_CRON = os.environ.get("INDEX_REFRESH_CRON", "0 0 4 * * *")
CONFIG_PREFIX = os.environ.get("CONFIG_PREFIX", "_config")
# Biblioteca de contenido por sección (marcas, documentos, videos...), separada
# de las carpetas de proyectos: _media/<seccion>/<carpeta>/<archivos>
MEDIA_PREFIX = os.environ.get("MEDIA_PREFIX", "_media")
# Miniaturas precalculadas para formatos que este backend no sabe rasterizar
# (Word, PowerPoint, Excel, CAD…): _thumbs/<ruta del archivo>.jpg. Las genera
# quien sube el material (ver ripcon_av_uploader.ipynb); si no existe, el
# frontend se queda con el ícono de tipo.
THUMBS_PREFIX = os.environ.get("THUMBS_PREFIX", "_thumbs")
# Copias livianas (MP4 H.264) de videos que el navegador no reproduce, como
# ProRes: _proxies/<ruta del archivo>.mp4. Las genera tools/make_video_proxies.py;
# el visor las prefiere para reproducir y la descarga sigue dando el original.
PROXIES_PREFIX = os.environ.get("PROXIES_PREFIX", "_proxies")

# ── Identidad y accesos ────────────────────────────────────────────────────
# AUTH_MODE: "lax" (por defecto) decodifica los claims y verifica tenant + expiración,
#            pero no la firma — no puede bloquear el acceso por problemas de validación,
#            y ya es más estricto que el backend anterior (que aceptaba cualquier token).
#            "strict" además valida firma/audiencia contra Entra ID (JWKS): actívalo en
#            Application Settings (AUTH_MODE=strict) al mismo tiempo que el modo Restringido.
AAD_TENANT_ID = os.environ.get("AAD_TENANT_ID", "12f2a4b5-4935-464d-9dae-e0525d0c593f")
AAD_CLIENT_ID = os.environ.get("AAD_CLIENT_ID", "a4413b75-4069-48e0-b055-55dce319dfbc")
AUTH_MODE = os.environ.get("AUTH_MODE", "lax").strip().lower()
# Súper-administradores permanentes (coma-separados). Siempre admins, aunque la
# config de accesos diga otra cosa — es la vía de recuperación ante un bloqueo.
# agarzon es el admin de inicio; se puede ampliar/override con la env ADMIN_EMAILS.
ADMIN_EMAILS = {e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "agarzon@ripconciv.com").split(",") if e.strip()}

_cache: Dict[str, Dict[str, Any]] = {}
_cache_lock = Lock()
_upload_jobs: Dict[str, Dict[str, Any]] = {}
_upload_jobs_lock = Lock()

# ── HELPERS ────────────────────────────────────────────────────────────────

def cors_headers() -> Dict[str, str]:
    return {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, X-Access-Token, Content-Type",
        "Content-Type": "application/json",
    }

def _resolve_carpeta(project_code: str, project_name: str) -> str:
    """
    Construye el nombre del directorio raíz del proyecto de forma inteligente 
    para evitar duplicados (ej. '16002_opa_opa').
    """
    code = (project_code or "").strip()
    
    # Normalizamos el nombre para compararlo y concatenarlo
    # (minúsculas y cambiando espacios por guiones)
    name_slug = (project_name or "").strip().replace(" ", "-").lower()
    
    # Si no hay código, usamos solo el nombre
    if not code:
        return name_slug
        
    # Magia aquí: Si el código ya termina con el nombre (ej. code="16002_opa", name="opa"),
    # devolvemos el código tal cual para no duplicar.
    if code.lower().endswith(f"_{name_slug}"):
        return code
        
    # Si es un código limpio (ej. code="16002", name="opa"), los unimos
    return f"{code}_{name_slug}"

def ok(data: Any, status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(
        body=json.dumps(data, default=str),
        status_code=status,
        headers=cors_headers(),
    )

def err(msg: str, status: int = 400) -> func.HttpResponse:
    return func.HttpResponse(
        body=json.dumps({"error": msg}),
        status_code=status,
        headers=cors_headers(),
    )

def options_ok() -> func.HttpResponse:
    return func.HttpResponse("", status_code=204, headers=cors_headers())

def binary_headers(content_type: str = "application/octet-stream") -> Dict[str, str]:
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, X-Access-Token, Content-Type",
        "Content-Type": content_type,
        "Cache-Control": "public, max-age=600",
    }

def cache_get(key: str):
    now = datetime.now(timezone.utc).timestamp()
    with _cache_lock:
        entry = _cache.get(key)
        if not entry:
            return None
        if entry["expires_at"] <= now:
            _cache.pop(key, None)
            return None
        return entry["value"]

def cache_set(key: str, value: Any, ttl_seconds: int = CACHE_TTL_SECONDS) -> None:
    if ttl_seconds <= 0:
        return
    expires_at = datetime.now(timezone.utc).timestamp() + ttl_seconds
    with _cache_lock:
        _cache[key] = {"expires_at": expires_at, "value": value}

def is_authenticated(req: func.HttpRequest) -> bool:
    auth = req.headers.get("Authorization", "") or req.headers.get("X-Access-Token", "")
    if auth and not auth.startswith("Bearer ") and auth.count(".") == 2:
        auth = f"Bearer {auth}"
    if not auth.startswith("Bearer "):
        return False
    token_part = auth[7:]
    return len(token_part.split(".")) == 3

def get_blob_service() -> BlobServiceClient:
    if not CONN_STR:
        raise ValueError("AZURE_STORAGE_CONNECTION_STRING no configurado en Application Settings")
    return BlobServiceClient.from_connection_string(CONN_STR)

def ext_of(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""

def type_of(name: str) -> str:
    ext = ext_of(name)
    if ext in ("jpg", "jpeg", "png", "tiff", "tif", "webp"): return "img"
    if ext in ("mp4", "mov", "avi", "mkv"):                   return "vid"
    if ext in ("dng", "cr3", "arw", "raw", "nef"):            return "raw"
    if ext == "insv":                                          return "i360"
    return "file"

def prefix_of(name: str) -> str:
    p = name.split("_")[0].upper() if "_" in name else ""
    return p if p in ("DRN", "FOT", "VID", "E360", "I360") else "FILE"

def is_marker_file(name: str) -> bool:
    n = (name or "").strip().lower()
    return n in (".keep", ".empty", ".placeholder")

def folder_path_of(blob_name: str) -> Optional[str]:
    parts = (blob_name or "").split("/")
    if len(parts) < 3:
        return None
    folder_parts = [part for part in parts[1:-1] if part]
    if not folder_parts:
        return None
    return "/".join(folder_parts)

def normalize_folder_path(path: str) -> str:
    return unquote(path or "").strip().strip("/")

def list_folder_children(project_id: str, folder_path: str) -> Dict[str, list]:
    svc = get_blob_service()
    cc = svc.get_container_client(CONTAINER)
    current = normalize_folder_path(folder_path)
    prefix = f"{project_id}/{current}/" if current else f"{project_id}/"

    folder_map: Dict[str, Dict[str, Any]] = {}
    files: list = []

    for blob in cc.list_blobs(name_starts_with=prefix, include=["metadata"]):
        remainder = blob.name[len(prefix):]
        if not remainder:
            continue

        # Blobs-marcador de directorio (ADLS Gen2/HNS): son la carpeta, no un
        # archivo. Sin esto se veían como "archivos directos" fantasma y, si la
        # carpeta estaba vacía, la subcarpeta ni aparecía.
        if _is_dir_marker(blob):
            if "/" not in remainder:
                folder_map.setdefault(f"{current}/{remainder}" if current else remainder, {
                    "name": remainder,
                    "path": f"{current}/{remainder}" if current else remainder,
                    "count": 0, "types": set(), "lastModified": None,
                })
            continue

        leaf_name = remainder.split("/")[-1]
        if is_marker_file(leaf_name):
            continue

        if "/" not in remainder:
            files.append({
                "name": leaf_name,
                "path": blob.name,
                "size": blob.size,
                "type": type_of(leaf_name),
                "prefix": prefix_of(leaf_name),
                "lastModified": blob.last_modified.isoformat() if blob.last_modified else None,
            })
            continue

        child_name = remainder.split("/", 1)[0]
        child_path = f"{current}/{child_name}" if current else child_name
        if child_path not in folder_map:
            folder_map[child_path] = {
                "name": child_name,
                "path": child_path,
                "count": 0,
                "types": set(),
                "lastModified": None,
            }

        child = folder_map[child_path]
        child["count"] += 1
        pfx = prefix_of(leaf_name)
        if pfx != "FILE":
            child["types"].add(pfx)
        lm = blob.last_modified
        if lm and (child["lastModified"] is None or lm > child["lastModified"]):
            child["lastModified"] = lm

    folders = []
    for folder in sorted(folder_map.values(), key=lambda x: x["path"]):
        folders.append({
            "name": folder["name"],
            "path": folder["path"],
            "count": folder["count"],
            "types": sorted(folder["types"]),
            "lastModified": folder["lastModified"].isoformat() if folder["lastModified"] else None,
        })

    files.sort(key=lambda f: f["name"])
    return {"folders": folders, "files": files}

def make_sas_url(blob_path: str, expiry_minutes: int = 60, download_name: Optional[str] = None) -> str:
    if not ACCOUNT_KEY:
        raise ValueError("AZURE_STORAGE_KEY no configurado en Application Settings")
    expiry = datetime.now(timezone.utc) + timedelta(minutes=expiry_minutes)
    # download_name: el Storage responde con Content-Disposition: attachment y
    # el navegador guarda directo a disco (archivos de varias GB sin memoria).
    extra = {}
    if download_name:
        safe = "".join(c for c in download_name if c not in '"\\\r\n') or "archivo"
        ascii_name = safe.encode("ascii", "ignore").decode() or "archivo"
        extra["content_disposition"] = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(safe)}"
    sas = generate_blob_sas(
        account_name=ACCOUNT_NAME,
        container_name=CONTAINER,
        blob_name=blob_path,
        account_key=ACCOUNT_KEY,
        permission=BlobSasPermissions(read=True),
        expiry=expiry,
        **extra,
    )
    return f"https://{ACCOUNT_NAME}.blob.core.windows.net/{CONTAINER}/{blob_path}?{sas}"

def make_sas_url_write(blob_path: str, expiry_minutes: int = 360) -> str:
    """SAS de escritura para subida directa navegador→blob (Put Blob / Put Block).
    Solo permite escribir/crear ese blob exacto; no leer ni listar."""
    if not ACCOUNT_KEY:
        raise ValueError("AZURE_STORAGE_KEY no configurado en Application Settings")
    expiry = datetime.now(timezone.utc) + timedelta(minutes=expiry_minutes)
    sas = generate_blob_sas(
        account_name=ACCOUNT_NAME,
        container_name=CONTAINER,
        blob_name=blob_path,
        account_key=ACCOUNT_KEY,
        permission=BlobSasPermissions(write=True, create=True),  # write incluye metadata en Put Blob / Put Block List.
        expiry=expiry,
    )
    return f"https://{ACCOUNT_NAME}.blob.core.windows.net/{CONTAINER}/{blob_path}?{sas}"

def derive_project_status(file_count: int, weeks_count: int, last_modified: Optional[datetime]) -> Dict[str, str]:
    if file_count <= 0 or weeks_count <= 0:
        return {"status": "pendiente", "statusReason": "Sin archivos o semanas registradas"}

    if last_modified:
        now_utc = datetime.now(timezone.utc)
        lm_utc = last_modified if last_modified.tzinfo else last_modified.replace(tzinfo=timezone.utc)
        age_hours = (now_utc - lm_utc).total_seconds() / 3600
        if age_hours <= STATUS_UPLOAD_WINDOW_HOURS:
            return {"status": "subiendo", "statusReason": f"Actividad reciente ({age_hours:.1f}h)"}

    return {"status": "completo", "statusReason": "Carga estable"}

def share_blob_name(token: str) -> str:
    return f"{SHARES_PREFIX.strip('/')}/{token}.json"

def save_share(share: Dict[str, Any]) -> None:
    svc = get_blob_service()
    bc = svc.get_blob_client(container=CONTAINER, blob=share_blob_name(share["token"]))
    bc.upload_blob(json.dumps(share, ensure_ascii=False), overwrite=True, content_type="application/json")

def load_share(token: str) -> Optional[Dict[str, Any]]:
    svc = get_blob_service()
    bc = svc.get_blob_client(container=CONTAINER, blob=share_blob_name(token))
    try:
        raw = bc.download_blob().readall()
        return json.loads(raw.decode("utf-8"))
    except ResourceNotFoundError:
        return None

def delete_share(token: str) -> None:
    svc = get_blob_service()
    bc = svc.get_blob_client(container=CONTAINER, blob=share_blob_name(token))
    try:
        bc.delete_blob(delete_snapshots="include")
    except ResourceNotFoundError:
        return

def list_shares() -> list:
    svc = get_blob_service()
    cc = svc.get_container_client(CONTAINER)
    result = []
    prefix = f"{SHARES_PREFIX.strip('/')}/"
    for blob in cc.list_blobs(name_starts_with=prefix):
        try:
            bc = cc.get_blob_client(blob)
            raw = bc.download_blob().readall()
            share = json.loads(raw.decode("utf-8"))
            if isinstance(share, dict) and share.get("token"):
                result.append(share)
        except Exception:
            continue
    return result

def index_projects_blob_name() -> str:
    return f"{INDEX_PREFIX.strip('/')}/projects.json"

def index_weeks_blob_name(project_id: str) -> str:
    return f"{INDEX_PREFIX.strip('/')}/weeks/{project_id}.json"

def index_files_blob_name(project_id: str, week: str) -> str:
    return f"{INDEX_PREFIX.strip('/')}/files/{project_id}/{week}.json"

def project_settings_blob_name(project_id: str) -> str:
    return f"{INDEX_PREFIX.strip('/')}/settings/{project_id}.json"

def should_skip_for_content_index(blob_name: str) -> bool:
    shares_prefix = f"{SHARES_PREFIX.strip('/')}/"
    index_prefix = f"{INDEX_PREFIX.strip('/')}/"
    config_prefix = f"{CONFIG_PREFIX.strip('/')}/"
    media_prefix = f"{MEDIA_PREFIX.strip('/')}/"
    thumbs_prefix = f"{THUMBS_PREFIX.strip('/')}/"
    proxies_prefix = f"{PROXIES_PREFIX.strip('/')}/"
    return (
        blob_name.startswith(shares_prefix)
        or blob_name.startswith(index_prefix)
        or blob_name.startswith(config_prefix)
        or blob_name.startswith(media_prefix)
        or blob_name.startswith(thumbs_prefix)
        or blob_name.startswith(proxies_prefix)
    )

def load_json_blob(blob_name: str) -> Optional[Any]:
    svc = get_blob_service()
    bc = svc.get_blob_client(container=CONTAINER, blob=blob_name)
    try:
        raw = bc.download_blob().readall()
        return json.loads(raw.decode("utf-8"))
    except ResourceNotFoundError:
        return None

def save_json_blob(blob_name: str, payload: Any) -> None:
    svc = get_blob_service()
    bc = svc.get_blob_client(container=CONTAINER, blob=blob_name)
    bc.upload_blob(
        json.dumps(payload, ensure_ascii=False, default=str),
        overwrite=True,
        content_type="application/json"
    )

def load_json_blob_etag(blob_name):
    bc = get_blob_service().get_blob_client(container=CONTAINER, blob=blob_name)
    try:
        download = bc.download_blob()
        return json.loads(download.readall().decode("utf-8")), download.properties.etag
    except ResourceNotFoundError:
        return None, None


def save_json_blob_etag(blob_name, payload, etag):
    bc = get_blob_service().get_blob_client(container=CONTAINER, blob=blob_name)
    # Con IfMissing NO se pasa etag: el SDK 12.19 no lo consume y la petición falla.
    conditions = ({"etag": etag, "match_condition": MatchConditions.IfNotModified} if etag is not None
                  else {"match_condition": MatchConditions.IfMissing})
    bc.upload_blob(json.dumps(payload, ensure_ascii=False, default=str), overwrite=True,
                   content_type="application/json", **conditions)


def clear_index_related_cache() -> None:
    with _cache_lock:
        keys = list(_cache.keys())
        for key in keys:
            if key == "projects" or key.startswith("weeks:") or key.startswith("files:"):
                _cache.pop(key, None)

def update_json_blob(blob_name: str, transform) -> Any:
    """Actualización optimista: no pierde auditorías/nombres entre instancias."""
    bc = get_blob_service().get_blob_client(container=CONTAINER, blob=blob_name)
    for _ in range(8):
        try:
            download = bc.download_blob()
            data = json.loads(download.readall().decode("utf-8"))
            options = {"overwrite": True, "etag": download.properties.etag,
                       "match_condition": MatchConditions.IfNotModified}
        except ResourceNotFoundError:
            data, options = None, {"overwrite": False}
        result = transform(data)
        try:
            bc.upload_blob(json.dumps(result, ensure_ascii=False), content_type="application/json", **options)
            return result
        except (ResourceModifiedError, ResourceExistsError):
            continue
    raise RuntimeError("La configuración cambió simultáneamente; vuelve a intentar")


# ── Cargas guardadas (bloque independiente) ──────────────────────────────────
def _presets_store():
    from presets_store import Presets
    return Presets(load_json_blob, update_json_blob, CONFIG_PREFIX)


def _handle_upload_presets(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    perms, auth_err = require_perms(req, cap="upload")
    if auth_err:
        return auth_err
    try:
        store = _presets_store()
        pid = req.route_params.get("id")
        if req.method == "GET":
            return ok(store.get())
        if req.method == "DELETE":
            return ok(store.delete(pid))
        body = req.get_json()
        return ok(store.run_result(pid, body, perms["email"]) if pid else store.save(body, perms["email"]))
    except KeyError:
        return err("Carga no encontrada", 404)
    except ValueError as exc:
        return err(str(exc), 400)
    except Exception:
        logging.exception("upload_presets")
        return err("No se pudo guardar la configuración", 500)


@app.route(route="upload/presets", methods=["GET", "POST", "OPTIONS"])
def upload_presets(req: func.HttpRequest) -> func.HttpResponse:
    return _handle_upload_presets(req)


@app.route(route="upload/presets/{id}", methods=["DELETE", "OPTIONS"])
def delete_upload_preset(req: func.HttpRequest) -> func.HttpResponse:
    return _handle_upload_presets(req)


@app.route(route="upload/presets/{id}/run-result", methods=["POST", "OPTIONS"])
def upload_preset_result(req: func.HttpRequest) -> func.HttpResponse:
    return _handle_upload_presets(req)


def load_project_names() -> dict:
    cached = cache_get("project-names")
    if cached is not None:
        return cached
    names = load_json_blob(f"{CONFIG_PREFIX.strip('/')}/project-names.json") or {}
    cache_set("project-names", names, ttl_seconds=30)
    return names


def apply_project_names(items: list, names: dict) -> list:
    return [{**p, "name": names.get(p.get("code"), {}).get("name") or p.get("name", "")} for p in items]


def apply_project_reference_name(item: dict, names: dict) -> dict:
    """Favoritos y trabajos pueden guardar el código corto, o la ruta completa."""
    code = str(item.get("projectCode") or "")
    root = str(item.get("path") or "").split("/", 1)[0]
    key = root if root in names else code
    if key not in names:
        matches = [k for k in names if k.startswith(f"{code}_")] if code else []
        key = matches[0] if len(matches) == 1 else key
    if key in names:
        automatic = " ".join(key.split("_")[1:]).upper().replace("-", " ")
        return {**item, "projectName": names[key].get("name") or automatic}
    return item


def validate_project_id(project_id: str) -> None:
    if (not project_id or any(c in project_id for c in "/\\%") or project_id in (".", "..")
            or should_skip_for_content_index(f"{project_id}/")):
        raise ValueError("Código de proyecto inválido")


def validate_project_delete(project_id: str, body: Any):
    validate_project_id(project_id)
    if not isinstance(body, dict):
        raise ValueError("Payload JSON inválido")
    week = body.get("week")
    paths = body.get("paths")
    if week is not None:
        if (not isinstance(week, str) or not re.fullmatch(r"(?:[^/\\%]+/)*\d{4}_S(?:0[1-9]|[1-4]\d|5[0-3])", week)
                or any(s in (".", "..") for s in week.split("/"))):
            raise ValueError("Semana inválida")
    if paths is not None and (not isinstance(paths, list) or not paths):
        raise ValueError("paths debe ser una lista no vacía")
    if week is None and paths is None:
        raise ValueError("Indica una semana o archivos")
    prefix = f"{project_id}/{week}/" if week else f"{project_id}/"
    for path in paths or []:
        if (not isinstance(path, str) or not path.startswith(prefix) or "\\" in path or "%" in path
                or any(s in ("", ".", "..") for s in path.split("/"))):
            raise ValueError("Ruta fuera del proyecto o semana")
    return week, list(dict.fromkeys(paths or [])), prefix


def refresh_project_indexes(project_id: str, affected: list) -> None:
    old_weeks = load_json_blob(index_weeks_blob_name(project_id)) or []
    payload = build_index_payloads(project_id)
    weeks = payload["weeksByProject"].get(project_id, [])
    save_json_blob(index_weeks_blob_name(project_id), weeks)
    folders = {w["week"] for w in old_weeks} | {folder_path_of(p) for p in affected}
    folders |= {w["week"] for w in weeks}
    for folder in folders - {None}:
        save_json_blob(index_files_blob_name(project_id, folder),
                       payload["filesByProjectWeek"].get(f"{project_id}::{folder}", []))
    current = load_json_blob(index_projects_blob_name())
    if isinstance(current, list):
        update_json_blob(index_projects_blob_name(), lambda data: sorted(
            [p for p in (data or []) if p.get("code") != project_id] + payload["projects"],
            key=lambda p: p["code"]))
    else:
        refresh_content_indexes()
    clear_index_related_cache()


@app.route(route="projects/{project_id}/name", methods=["POST", "OPTIONS"])
def project_name(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    project_id = req.route_params.get("project_id", "")
    perms, auth_err = require_perms(req, section="proyectos", item=project_id, cap="renameProject")
    if auth_err:
        return auth_err
    try:
        validate_project_id(project_id)
        body = req.get_json()
        if not isinstance(body, dict) or not isinstance(body.get("name"), str):
            raise ValueError("Nombre inválido")
        name = body["name"].strip()
        if name and not 3 <= len(name) <= 120:
            raise ValueError("El nombre debe tener entre 3 y 120 caracteres")
    except ValueError as exc:
        return err(str(exc), 400)
    try:
        entry = {"name": name, "by": perms["email"], "at": datetime.now(timezone.utc).isoformat()}
        update_json_blob(f"{CONFIG_PREFIX.strip('/')}/project-names.json",
                         lambda data: {**(data or {}), project_id: entry})
        with _cache_lock:
            _cache.pop("project-names", None)
        clear_index_related_cache()
        return ok({"saved": True, "name": name})
    except Exception as exc:
        logging.exception("project_name")
        return err(str(exc), 500)


@app.route(route="projects/{project_id}/delete", methods=["POST", "OPTIONS"])
def project_delete(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    project_id = req.route_params.get("project_id", "")
    perms, auth_err = require_perms(req, section="proyectos", item=project_id, cap="deleteMedia")
    if auth_err:
        return auth_err
    try:
        week, paths, prefix = validate_project_delete(project_id, req.get_json())
    except ValueError as exc:
        return err(str(exc), 400)
    deleted = []
    try:
        cc = get_blob_service().get_container_client(CONTAINER)
        if week:
            blobs = list(cc.list_blobs(name_starts_with=prefix, include=["metadata"]))
            paths = [b.name for b in blobs]
            # HNS: incluye el marcador de la propia semana, después de sus hijos.
            if blob_exists(prefix[:-1]):
                paths.append(prefix[:-1])
        paths = sorted(set(paths), key=lambda p: (p.count("/"), p), reverse=True)
        # Hasta tres blobs por original: nunca supera 2000, incluidas las copias.
        batch, pending = paths[:666], paths[666:]
        try:
            for path in batch:
                for target in (path, thumb_sidecar_name(path), proxy_sidecar_name(path)):
                    try:
                        cc.delete_blob(target)
                        if target == path:
                            deleted.append(path)
                    except ResourceNotFoundError:
                        pass
        finally:
            if deleted:
                now = datetime.now(timezone.utc)
                entry = {"at": now.isoformat(), "by": perms["email"], "project": project_id,
                         "count": len(deleted), "paths": deleted[:50], "week": week}
                try:
                    tags_cleanup_deleted(deleted)
                finally:
                    try:
                        update_json_blob(f"{CONFIG_PREFIX.strip('/')}/audit/borrados-{now:%Y-%m}.json",
                                         lambda data: [*(data or []), entry])
                    finally:
                        try:
                            refresh_project_indexes(project_id, deleted)
                        finally:
                            clear_index_related_cache()
        return ok({"deleted": len(deleted), "remaining": len(pending), "remainingPaths": pending if not week else []})
    except Exception as exc:
        logging.exception("project_delete")
        return err(str(exc), 500)


def normalize_projects_payload(items: Any) -> list:
    if not isinstance(items, list):
        return []
    normalized = []
    for p in items:
        if not isinstance(p, dict):
            continue
        out = dict(p)
        weeks_count = int(out.get("weeks") or 0)
        status = str(out.get("status") or "").strip().lower()
        if "hasContent" not in out:
            out["hasContent"] = not (status == "pendiente" and weeks_count == 0)
        if "statusReason" not in out:
            out["statusReason"] = ""
        normalized.append(out)
    return normalized

def build_index_payloads(project_id: Optional[str] = None) -> Dict[str, Any]:
    svc = get_blob_service()
    cc  = svc.get_container_client(CONTAINER)

    project_map: Dict[str, Dict[str, Any]] = {}
    week_map_by_project: Dict[str, Dict[str, Dict[str, Any]]] = {}
    files_map_by_project_week: Dict[str, list] = {}

    for blob in cc.list_blobs(**({"name_starts_with": f"{project_id}/"} if project_id else {})):
        if should_skip_for_content_index(blob.name):
            continue
        parts = blob.name.split("/")
        if len(parts) < 3 or not parts[-1]:
            continue

        project_id = parts[0]
        folder_path = folder_path_of(blob.name)
        fname = parts[-1]

        if not folder_path:
            continue

        if project_id not in project_map:
            slug = " ".join(project_id.split("_")[1:]).upper().replace("-", " ")
            project_map[project_id] = {
                "code": project_id, "name": slug,
                "weeks": set(), "types": set(),
                "lastModified": None, "fileCount": 0, "photoCount": 0, "videoCount": 0, "hasMarker": False,
                "coverPath": None, "coverIsDrone": False,
            }

        proj = project_map[project_id]
        if is_marker_file(fname):
            proj["hasMarker"] = True
            continue

        proj["weeks"].add(folder_path)
        proj["fileCount"] += 1
        proj["photoCount"] += type_of(fname) == "img"
        proj["videoCount"] += type_of(fname) == "vid"
        pfx = prefix_of(fname)
        if pfx != "FILE":
            proj["types"].add(pfx)
        # Portada del proyecto: primera imagen; las de dron (DRN) tienen prioridad
        if type_of(fname) == "img":
            is_drone = pfx == "DRN"
            if proj["coverPath"] is None or (is_drone and not proj["coverIsDrone"]):
                proj["coverPath"] = blob.name
                proj["coverIsDrone"] = is_drone
        lm = blob.last_modified
        if lm and (proj["lastModified"] is None or lm > proj["lastModified"]):
            proj["lastModified"] = lm

        if project_id not in week_map_by_project:
            week_map_by_project[project_id] = {}
        if folder_path not in week_map_by_project[project_id]:
            week_map_by_project[project_id][folder_path] = {"week": folder_path, "count": 0, "types": set()}
        week_map_by_project[project_id][folder_path]["count"] += 1
        if pfx != "FILE":
            week_map_by_project[project_id][folder_path]["types"].add(pfx)

        file_key = f"{project_id}::{folder_path}"
        if file_key not in files_map_by_project_week:
            files_map_by_project_week[file_key] = []
        files_map_by_project_week[file_key].append({
            "name": fname, "path": blob.name, "size": blob.size,
            "type": type_of(fname), "prefix": prefix_of(fname),
            "lastModified": blob.last_modified.isoformat() if blob.last_modified else None,
        })

    projects = []
    for proj in sorted(project_map.values(), key=lambda x: x["code"]):
        status_info = derive_project_status(
            file_count=proj["fileCount"],
            weeks_count=len(proj["weeks"]),
            last_modified=proj["lastModified"],
        )
        projects.append({
            "code": proj["code"], "name": proj["name"],
            "weeks": len(proj["weeks"]),
            "photoCount": proj["photoCount"], "videoCount": proj["videoCount"],
            "types": "+".join(sorted(proj["types"])),
            "status": status_info["status"],
            "statusReason": status_info["statusReason"],
            "hasContent": proj["fileCount"] > 0,
            "lastModified": proj["lastModified"].isoformat() if proj["lastModified"] else None,
            "coverPath": proj["coverPath"],
        })

    weeks_by_project: Dict[str, list] = {}
    for project_id, week_map in week_map_by_project.items():
        weeks_by_project[project_id] = [
            {"week": k, "count": v["count"], "types": sorted(v["types"])}
            for k, v in sorted(week_map.items())
        ]

    for key in files_map_by_project_week:
        files_map_by_project_week[key].sort(key=lambda f: f["name"])

    return {
        "projects": projects,
        "weeksByProject": weeks_by_project,
        "filesByProjectWeek": files_map_by_project_week,
    }

def refresh_content_indexes() -> Dict[str, int]:
    payloads = build_index_payloads()
    save_json_blob(index_projects_blob_name(), payloads["projects"])

    for project_id, weeks in payloads["weeksByProject"].items():
        save_json_blob(index_weeks_blob_name(project_id), weeks)

    for key, files in payloads["filesByProjectWeek"].items():
        project_id, week = key.split("::", 1)
        save_json_blob(index_files_blob_name(project_id, week), files)

    clear_index_related_cache()

    return {
        "projects": len(payloads["projects"]),
        "weeksIndexes": len(payloads["weeksByProject"]),
        "filesIndexes": len(payloads["filesByProjectWeek"]),
    }

# Extensiones que Pillow puede rasterizar directamente desde el original.
THUMBABLE_IMAGE_EXT = ("jpg", "jpeg", "png", "webp", "tif", "tiff")

def thumb_sidecar_name(blob_path: str) -> str:
    """Ruta de la miniatura precalculada de un archivo no-imagen.
    _media/documentos/Plantillas/informe.docx → _thumbs/_media/documentos/Plantillas/informe.docx.jpg"""
    return f"{THUMBS_PREFIX.strip('/')}/{blob_path.strip('/')}.jpg"

PROXYABLE_VIDEO_EXT = (".mov", ".mp4", ".m4v")

def proxy_sidecar_name(blob_path: str) -> str:
    """Ruta de la copia liviana de un video.
    00000_hospital-manta/2020_S20/VID_001.mov → _proxies/00000_hospital-manta/2020_S20/VID_001.mov.mp4"""
    return f"{PROXIES_PREFIX.strip('/')}/{blob_path.strip('/')}.mp4"

def blob_exists(blob_name: str) -> bool:
    try:
        svc = get_blob_service()
        return svc.get_blob_client(container=CONTAINER, blob=blob_name).exists()
    except Exception:
        return False

def build_thumbnail_bytes(raw_bytes: bytes, max_width: int = 480, quality: int = 72,
                          trim: bool = False):
    """Devuelve (bytes, content_type). Con trim=True recorta el arte al contenido
    (modo logo: elimina el área de respeto) y conserva la transparencia PNG."""
    with Image.open(io.BytesIO(raw_bytes)) as src:
        img = ImageOps.exif_transpose(src)
        has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
        img = img.convert("RGBA") if has_alpha else img.convert("RGB")

        if trim:
            if has_alpha:
                bbox = img.split()[3].getbbox()
            else:
                from PIL import ImageChops
                px = img.load()
                w0, h0 = img.size
                corners = [px[2, 2], px[w0 - 3, 2], px[2, h0 - 3], px[w0 - 3, h0 - 3]]
                bg = max(set(corners), key=corners.count)
                diff = ImageChops.difference(img, Image.new("RGB", img.size, bg)).convert("L")
                bbox = diff.point(lambda p: 255 if p > 12 else 0).getbbox()
            if bbox:
                l, t, r, b = bbox
                m = int(max(r - l, b - t) * 0.16)
                w0, h0 = img.size
                img = img.crop((max(0, l - m), max(0, t - m), min(w0, r + m), min(h0, b + m)))

        w, h = img.size
        if w > max_width:
            new_h = int((h * max_width) / w)
            img = img.resize((max_width, max(1, new_h)), Image.Resampling.LANCZOS)

        out = io.BytesIO()
        if has_alpha:
            img.save(out, format="PNG", optimize=True)
            return out.getvalue(), "image/png"
        img.save(out, format="JPEG", quality=quality, optimize=True, progressive=True)
        return out.getvalue(), "image/jpeg"


# ── AUTENTICACIÓN Y CONTROL DE ACCESOS ────────────────────────────────────
# La identidad sale del token de Entra ID que ya envía el frontend (MSAL).
# Los permisos viven en un blob JSON ({CONFIG_PREFIX}/access.json) que el
# administrador edita desde la página "Accesos".

# La sección de material audiovisual de obra se llama "proyectos" (id = etiqueta,
# coherente). "material" es un alias histórico que se normaliza a "proyectos".
SECTION_ALIASES = {"material": "proyectos"}
ROLES = ("admin", "operador", "viewer")

def canon_section(s: str) -> str:
    return SECTION_ALIASES.get(s, s)


# ── CATÁLOGO DE SECCIONES ──────────────────────────────────────────────────
# Qué secciones existen en el hub lo decide el administrador desde la página
# "Secciones" y se guarda en {CONFIG_PREFIX}/sections.json. Esta lista es el
# valor inicial (primer arranque) y el fallback si el blob falta o está roto.
#
# kind: 'projects' → obras con semanas (lógica propia, sección única y fija)
#       'media'    → biblioteca de carpetas libres en _media/<id>/
#       'links'    → lista de enlaces, sin carpetas
SECTION_KINDS = ("projects", "media", "links")
# La sección de obras no se puede borrar ni cambiar de tipo: sus rutas, su
# índice y sus permisos están cableados aparte del resto.
PROTECTED_SECTION = "proyectos"

DEFAULT_SECTIONS = [
    {"id": "proyectos", "label": "Proyectos", "kind": "projects", "icon": "proyectos",
     "description": "Todo el material audiovisual de cada obra: fotos, dron, video y 360° organizados por proyecto y semana."},
    {"id": "marcas", "label": "Marcas", "kind": "media", "icon": "marcas",
     "description": "Arquetipo, personalidad y variantes descargables de cada marca del grupo RIPCON, filtrables por fondo, color y formato."},
    {"id": "documentos", "label": "Documentos y Plantillas", "kind": "media", "icon": "documentos",
     "description": "Plantillas de marca, papelería, presentaciones y manuales listos para usar."},
    {"id": "videos", "label": "Videos Corporativos", "kind": "media", "icon": "videos",
     "description": "Institucionales y spots de la empresa, independientes de cada obra."},
    {"id": "eventos", "label": "Fotografía de Eventos", "kind": "media", "icon": "eventos",
     "description": "Eventos corporativos, equipo y cultura de empresa."},
    {"id": "redes", "label": "Redes Sociales", "kind": "links", "icon": "redes",
     "description": "Enlaces oficiales a las redes sociales de la empresa: Instagram, LinkedIn, Facebook y más."},
    {"id": "politicas", "label": "Politicas", "kind": "media", "icon": "politicas",
     "description": "Políticas, normativas y reglamentos internos de la empresa."},
]

SECTIONS_CACHE_KEY = "sections:config"
_SECTION_ID_MAX = 32
_SECTION_LABEL_MAX = 48
_SECTION_DESC_MAX = 400

def sections_config_blob_name() -> str:
    return f"{CONFIG_PREFIX.strip('/')}/sections.json"

def _slugify_section_id(raw: Any) -> Optional[str]:
    """id de sección = segmento de URL y carpeta en el blob: solo a-z, 0-9 y guión."""
    text = str(raw or "").strip().lower()
    out = []
    for ch in text:
        if ch.isascii() and (ch.isalnum() or ch == "-"):
            out.append(ch)
        elif ch in " _/":
            out.append("-")
    slug = "-".join(p for p in "".join(out).split("-") if p)
    if not slug or len(slug) > _SECTION_ID_MAX or slug[0].isdigit():
        return None
    return slug

def sanitize_sections(raw: Any) -> list:
    """Normaliza la lista guardada. Descarta entradas inválidas o duplicadas y
    garantiza que 'proyectos' siga existiendo con su tipo original."""
    if not isinstance(raw, list):
        raise ValueError("Se esperaba una lista de secciones")
    if len(raw) > 40:
        raise ValueError("Demasiadas secciones (máximo 40)")

    cleaned: list = []
    seen: set = set()
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        sid = _slugify_section_id(entry.get("id"))
        if not sid or sid in seen:
            continue
        kind = str(entry.get("kind") or "media").strip().lower()
        if kind not in SECTION_KINDS:
            kind = "media"
        # Solo puede haber una sección de obras y es la protegida.
        if kind == "projects" and sid != PROTECTED_SECTION:
            kind = "media"
        if sid == PROTECTED_SECTION:
            kind = "projects"
        label = " ".join(str(entry.get("label") or "").split())[:_SECTION_LABEL_MAX] or sid.capitalize()
        description = " ".join(str(entry.get("description") or "").split())[:_SECTION_DESC_MAX]
        icon = _slugify_section_id(entry.get("icon")) or sid
        seen.add(sid)
        cleaned.append({"id": sid, "label": label, "kind": kind,
                        "icon": icon, "description": description})

    if PROTECTED_SECTION not in seen:
        cleaned.insert(0, dict(DEFAULT_SECTIONS[0]))
    if not cleaned:
        raise ValueError("La configuración no dejó ninguna sección válida")
    return cleaned

def load_sections() -> list:
    cached = cache_get(SECTIONS_CACHE_KEY)
    if cached is not None:
        return cached
    items = None
    try:
        raw = load_json_blob(sections_config_blob_name())
        if isinstance(raw, dict):
            raw = raw.get("sections")
        if isinstance(raw, list):
            items = sanitize_sections(raw)
    except Exception as exc:
        logging.warning("load_sections (se usa el catálogo por defecto): %s", exc)
    if not items:
        items = [dict(s) for s in DEFAULT_SECTIONS]
    cache_set(SECTIONS_CACHE_KEY, items, ttl_seconds=120)
    return items

def known_sections() -> list:
    """ids de todas las secciones activas."""
    return [s["id"] for s in load_sections()]

def library_sections() -> list:
    """ids de las secciones que viven en _media/ (todo lo que no son obras)."""
    return [s["id"] for s in load_sections() if s["kind"] != "projects"]

ACCESS_CACHE_KEY = "access:config"
_ACCESS_NONE = "__no_config__"

def access_config_blob_name() -> str:
    return f"{CONFIG_PREFIX.strip('/')}/access.json"

_jwks_client = None
_jwks_lock = Lock()

def _get_jwks_client() -> PyJWKClient:
    global _jwks_client
    with _jwks_lock:
        if _jwks_client is None:
            url = f"https://login.microsoftonline.com/{AAD_TENANT_ID}/discovery/v2.0/keys"
            _jwks_client = PyJWKClient(url, cache_keys=True, lifespan=3600)
        return _jwks_client

def _decode_claims_unverified(token: str) -> dict:
    """Decodifica los claims SIN verificar firma ni tiempos (nbf/iat/exp/aud).
    Robusto ante desfase de reloj entre Azure y el emisor del token."""
    return jwt.decode(token, options={
        "verify_signature": False, "verify_aud": False, "verify_iss": False,
        "verify_exp": False, "verify_nbf": False, "verify_iat": False,
    })

def _decode_client_principal(req: func.HttpRequest) -> Optional[dict]:
    raw = req.headers.get("x-ms-client-principal", "") or req.headers.get("X-MS-CLIENT-PRINCIPAL", "")
    if not raw:
        return None
    try:
        padded = raw + ("=" * (-len(raw) % 4))
        decoded = base64.b64decode(padded).decode("utf-8")
        return json.loads(decoded)
    except Exception as exc:
        logging.warning("_decode_client_principal: %s", exc)
        return None

def _caller_from_client_principal(req: func.HttpRequest) -> Optional[Dict[str, str]]:
    principal = _decode_client_principal(req)
    if not principal:
        return None

    claims = principal.get("claims") if isinstance(principal, dict) else None
    if not isinstance(claims, list):
        claims = []

    claim_map: Dict[str, list] = {}
    for claim in claims:
        if not isinstance(claim, dict):
            continue
        key = str(claim.get("typ") or claim.get("type") or "").strip()
        value = str(claim.get("val") or claim.get("value") or "").strip()
        if key:
            claim_map.setdefault(key, []).append(value)

    def _first(*keys: str) -> str:
        for key in keys:
            values = claim_map.get(key)
            if values:
                for value in values:
                    if value:
                        return value
        return ""

    email = _first(
        "preferred_username",
        "email",
        "emails",
        "upn",
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier",
        "name",
    ).strip().lower()

    if email and email.startswith("[") and email.endswith("]"):
        try:
            parsed = json.loads(email)
            if isinstance(parsed, list) and parsed:
                email = str(parsed[0]).strip().lower()
        except Exception:
            pass

    if not email:
        user_details = str(principal.get("userDetails") or "").strip().lower()
        if user_details:
            email = user_details

    if not email:
        return None

    name = str(principal.get("userDetails") or _first("name") or "").strip()
    return {"email": email, "name": name}

def get_caller(req: func.HttpRequest) -> Optional[Dict[str, str]]:
    """Extrae la identidad (email + nombre) del token Bearer. None si el token
    falta o no trae identidad de este tenant."""
    client_principal_caller = _caller_from_client_principal(req)
    if client_principal_caller is not None:
        return client_principal_caller

    # SWA con Functions gestionadas SECUESTRA el header Authorization e inyecta
    # su propio token anónimo (aud=...azurefunctions, sin tid/upn). El token real
    # de MSAL viaja en un header propio (X-Access-Token / X-Ripcon-Token) que el
    # proxy de SWA no toca — por eso se prioriza sobre Authorization.
    raw = (
        req.headers.get("X-Access-Token", "")
        or req.headers.get("X-Ripcon-Token", "")
        or req.headers.get("Authorization", "")
    ).strip()
    if raw.startswith("Bearer "):
        raw = raw[7:].strip()
    token = raw
    if token.count(".") != 2:
        return None
    try:
        claims = None
        if AUTH_MODE == "strict":
            # Intenta validar firma/audiencia contra Entra ID; si falla NO bloquea
            # (degrada a lax con aviso), para no dejar a nadie fuera por un desajuste
            # de configuración. Endurecer de verdad = revisar el app registration.
            try:
                signing_key = _get_jwks_client().get_signing_key_from_jwt(token)
                claims = jwt.decode(
                    token, key=signing_key.key, algorithms=["RS256"],
                    audience=[AAD_CLIENT_ID, f"api://{AAD_CLIENT_ID}"],
                    options={"verify_iss": False}, leeway=300,
                )
            except Exception as exc:
                logging.warning("get_caller: validación estricta falló, uso lax: %s", exc)
                claims = _decode_claims_unverified(token)
        else:
            claims = _decode_claims_unverified(token)

        tid = str(claims.get("tid") or "")
        iss = str(claims.get("iss") or "")
        if AAD_TENANT_ID and AAD_TENANT_ID != tid and AAD_TENANT_ID not in iss:
            logging.warning("get_caller: tenant no coincide (tid=%s)", tid)
            return None
        email = (
            claims.get("preferred_username") or claims.get("upn")
            or claims.get("email") or claims.get("unique_name") or ""
        ).strip().lower()
        if not email:
            logging.warning("get_caller: token sin email (claves: %s)", list(claims.keys()))
            return None
        return {"email": email, "name": str(claims.get("name") or "")}
    except Exception as exc:
        logging.warning("get_caller: token rechazado: %s", exc)
        return None

def load_access_config() -> Optional[dict]:
    cached = cache_get(ACCESS_CACHE_KEY)
    if cached is not None:
        return None if cached == _ACCESS_NONE else cached
    cfg = None
    try:
        cfg = load_json_blob(access_config_blob_name())
    except Exception as exc:
        logging.error("load_access_config: %s", exc)
    cache_set(ACCESS_CACHE_KEY, cfg if cfg is not None else _ACCESS_NONE, ttl_seconds=30)
    return cfg

# Permisos por persona = capacidades de gestión (qué puede HACER) + secciones/scopes
# (qué puede VER). Los roles son solo presets rápidos de esas capacidades; el
# administrador puede ajustar cada capacidad manualmente por usuario.
CAPS = ("upload", "manageMedia", "deleteMedia", "share", "refreshIndex", "manageAccess", "renameProject", "tagMedia", "review", "hardware")
ROLE_CAPS = {
    "admin":    {c: True for c in CAPS},
    # El operador sube y organiza, pero borrar es cosa de administración: un
    # borrado en el blob no tiene deshacer desde la app.
    "operador": {"upload": True, "manageMedia": True, "deleteMedia": False, "share": True,
                 "refreshIndex": True, "manageAccess": False,
                 "renameProject": False, "tagMedia": False, "review": False, "hardware": False},
    "viewer":   {c: False for c in CAPS},
}

# Usuario "normal": cualquiera que inicie sesión y NO esté listado en Accesos
# (modo abierto) entra como viewer y ve SOLO estas secciones, sin poder subir
# ni gestionar nada. El admin puede ampliar por persona desde la página Accesos.
DEFAULT_GUEST_SECTIONS = ["marcas"]

DEFAULT_TI_MEMBERS = ["agarzon@ripconciv.com", "dmesias@ripconciv.com", "mlovato@ripconciv.com",
                      "kalopez@ripconciv.com", "bboccanedes@ripconciv.com",
                      "pasanteti01@ripconciv.com", "pasanteti02@ripconciv.com"]


def access_groups(cfg: Optional[dict]) -> dict:
    groups = (cfg or {}).get("groups") or {}
    if not isinstance(groups, dict):
        raise ValueError("groups debe ser un objeto")
    group = groups.get("equipo-ti", {"members": DEFAULT_TI_MEMBERS})
    if not isinstance(group, dict):
        raise ValueError("Equipo TI debe ser un objeto")
    members = group.get("members", [])
    if not isinstance(members, list):
        raise ValueError("Los miembros de Equipo TI deben ser una lista")
    cleaned = set()
    for raw in members:
        email = str(raw).strip().lower()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
            raise ValueError("Correo inválido en Equipo TI")
        cleaned.add(email)
    return {"equipo-ti": {"label": "Equipo TI", "members": sorted(cleaned)}}

def _caps_from(role: str, overrides: Any) -> dict:
    caps = dict(ROLE_CAPS.get(role, ROLE_CAPS["viewer"]))
    if isinstance(overrides, dict):
        for c in CAPS:
            if c in overrides:
                caps[c] = bool(overrides[c])
    return caps

def _perms(email, name, role, caps, sections, scopes, restricted, bootstrap, allowed=True) -> dict:
    return {
        "email": email, "name": name, "allowed": allowed, "role": role,
        "caps": caps,
        "isAdmin": bool(caps.get("manageAccess")),
        "isManager": bool(caps.get("upload") or caps.get("manageMedia")),
        "sections": sections, "scopes": scopes,
        "restricted": restricted, "bootstrap": bootstrap,
    }

def _perms_full(email: str, name: str, role: str, restricted: bool, bootstrap: bool) -> dict:
    return _perms(email, name, role, dict(ROLE_CAPS.get(role, ROLE_CAPS["admin"])),
                  "*", {}, restricted, bootstrap)

def _normalize_scopes(entry: dict) -> dict:
    """Mapa {seccion: [items]} con solo listas no vacías; ausencia = sin restricción.
    Compat: la config vieja usaba 'projects' → scope de 'proyectos'."""
    raw = entry.get("scopes")
    raw = dict(raw) if isinstance(raw, dict) else {}
    old = entry.get("projects")
    if old is not None and old != "*" and isinstance(old, list) and "proyectos" not in raw and "material" not in raw:
        raw["proyectos"] = old
    cleaned: Dict[str, list] = {}
    valid = known_sections()
    for sec, val in raw.items():
        sec = canon_section(sec)
        if sec not in valid or val == "*":
            continue
        if isinstance(val, list):
            vals = [str(x).strip() for x in val if str(x).strip()]
            if vals:
                cleaned[sec] = vals
    return cleaned

def effective_perms(caller: Optional[Dict[str, str]]) -> dict:
    cfg = load_access_config() if caller else None
    perms = _individual_perms(caller, cfg)
    perms["groups"] = []
    try:
        ti_members = access_groups(cfg)["equipo-ti"]["members"]
    except ValueError as exc:
        # Un grupo mal guardado no debe tumbar la autenticación de todo el hub.
        logging.error("Equipo TI inválido en access.json: %s", exc)
        ti_members = DEFAULT_TI_MEMBERS
    if caller and caller["email"].strip().lower() in ti_members:
        caps = {**ROLE_CAPS["operador"], "deleteMedia": True, "renameProject": True,
                "tagMedia": True, "review": True, "hardware": True}
        perms = {**perms, "allowed": True, "sections": "*", "scopes": {}, "isManager": True,
                 "caps": {c: bool(caps.get(c) or perms.get("caps", {}).get(c)) for c in CAPS},
                 "groups": ["equipo-ti"]}
        perms["isAdmin"] = perms["caps"]["manageAccess"]
        perms["role"] = perms["role"] or "operador"
    return perms


def _individual_perms(caller: Optional[Dict[str, str]], cfg: Optional[dict]) -> dict:
    if caller is None:
        return {"email": "", "name": "", "allowed": False, "role": None, "isAdmin": False,
                "isManager": False, "sections": [], "scopes": {}, "restricted": False, "bootstrap": False}

    email, name = caller["email"], caller.get("name", "")
    env_admin = email in ADMIN_EMAILS

    if cfg is None:
        # Sin configuración: modo abierto. Sin ADMIN_EMAILS, el primer usuario
        # autenticado es admin (bootstrap) y puede crear la configuración.
        bootstrap = not ADMIN_EMAILS
        role = "admin" if (env_admin or bootstrap) else "operador"
        return _perms_full(email, name, role, False, bootstrap)

    restricted = bool(cfg.get("restricted"))
    entry = None
    for u in cfg.get("users", []):
        if isinstance(u, dict) and str(u.get("email", "")).strip().lower() == email:
            entry = u
            break

    if env_admin:
        return _perms_full(email, name, "admin", restricted, False)

    if entry and entry.get("enabled", True):
        role = entry.get("role") if entry.get("role") in ROLES else "viewer"
        caps = _caps_from(role, entry.get("caps"))
        name = name or str(entry.get("name") or "")
        # Quien gestiona accesos ve todo (lo necesita para administrar).
        if caps.get("manageAccess"):
            return _perms(email, name, role, caps, "*", {}, restricted, False)
        sections = entry.get("sections", [])
        if sections != "*":
            sections = [canon_section(s) for s in sections if canon_section(s) in known_sections()] if isinstance(sections, list) else []
        return _perms(email, name, role, caps, sections, _normalize_scopes(entry), restricted, False)

    if restricted:
        return _perms(email, name, None, dict(ROLE_CAPS["viewer"]), [], {}, True, False, allowed=False)

    # Config existe pero abierta: los no listados entran como usuario normal
    # (viewer) y ven solo las secciones por defecto, sin poder subir ni gestionar.
    return _perms(email, name, "viewer", dict(ROLE_CAPS["viewer"]),
                  list(DEFAULT_GUEST_SECTIONS), {}, False, False)

# La visibilidad la gobiernan SIEMPRE `sections`/`scopes`, sin importar si el
# usuario puede subir/gestionar (isManager). Solo el admin con manageAccess ve
# todo, porque effective_perms le fija sections="*" explícitamente.
def perms_allow_section(perms: dict, section: str) -> bool:
    secs = perms.get("sections")
    return secs == "*" or (isinstance(secs, list) and section in secs)

def perms_allow_item(perms: dict, section: str, item: str) -> bool:
    if not perms_allow_section(perms, section):
        return False
    scope = (perms.get("scopes") or {}).get(section)
    if not scope:            # ausente o vacío = acceso a toda la sección
        return True
    return item in scope

def require_perms(req: func.HttpRequest, section: Optional[str] = None,
                  item: Optional[str] = None, cap: Optional[str] = None):
    """Devuelve (perms, None) si el caller pasa los requisitos, o
    (None, HttpResponse) con el error listo para retornar.
    `cap` exige una capacidad de gestión (upload / manageMedia / share /
    refreshIndex / manageAccess). `section`/`item` controlan la vista."""
    caller = get_caller(req)
    perms = effective_perms(caller)
    section = canon_section(section) if section else section
    if not perms["allowed"]:
        return None, err("No autorizado", 401 if caller is None else 403)
    if cap and not perms.get("caps", {}).get(cap):
        msg = "Requiere permisos de administrador" if cap == "manageAccess" else "Sin permiso para esta acción"
        return None, err(msg, 403)
    if section and not perms_allow_section(perms, section):
        return None, err("Sin acceso a esta sección", 403)
    if section and item and not perms_allow_item(perms, section, item):
        return None, err("Sin acceso a este elemento", 403)
    return perms, None

def require_blob_access(req: func.HttpRequest, blob_path: str):
    """Gate por ruta de blob: los paths de _media se controlan por sección + carpeta;
    el resto son proyectos (proyectos + código de proyecto)."""
    if (blob_path or "").strip('/').startswith(CONFIG_PREFIX.strip('/') + '/hardware/'):
        perms, error = require_perms(req, cap="hardware")
        if error is not None:
            return perms, error
        views_prefix = f"{CONFIG_PREFIX.strip('/')}/hardware/views/"
        if blob_path.strip('/').startswith(views_prefix):
            email = (get_caller(req) or {}).get("email")
            own_path = f"{views_prefix}{_safe_user_key(email)}.json" if email else None
            if blob_path.strip('/') != own_path:
                return None, err("Las vistas personales pertenecen a otro usuario", 403)
        return perms, None
    seg = [s for s in (blob_path or "").split("/") if s]
    if seg and seg[0] == MEDIA_PREFIX.strip("/"):
        if len(seg) < 3:
            return None, err("Ruta de media inválida", 400)
        return require_perms(req, section=seg[1], item=seg[2])
    return require_perms(req, section="proyectos", item=seg[0] if seg else "")

def _filter_projects_by_perms(items: list, perms: dict) -> list:
    items = apply_project_names(items, load_project_names())
    if not perms_allow_section(perms, "proyectos"):
        return []
    scope = (perms.get("scopes") or {}).get("proyectos")
    if not scope:
        return items
    allowed = set(scope)
    return [p for p in items if p.get("code") in allowed]

def _filter_media_folders_by_perms(folders: list, perms: dict, section: str) -> list:
    if not perms_allow_section(perms, section):
        return []
    scope = (perms.get("scopes") or {}).get(section)
    if not scope:
        return folders
    allowed = set(scope)
    return [f for f in folders if f.get("name") in allowed]

def sanitize_access_config(payload: Any, saver_email: str) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("Configuración inválida")
    users_in = payload.get("users", [])
    if not isinstance(users_in, list):
        raise ValueError("users debe ser una lista")

    seen = set()
    users = []
    for u in users_in:
        if not isinstance(u, dict):
            continue
        email = str(u.get("email", "")).strip().lower()
        if not email or "@" not in email or email in seen:
            continue
        seen.add(email)
        role = u.get("role") if u.get("role") in ROLES else "viewer"
        # Capacidades: parten del preset del rol y se sobrescriben con lo que el
        # admin marcó manualmente. Guardamos solo las capacidades conocidas.
        caps_in = u.get("caps") if isinstance(u.get("caps"), dict) else {}
        caps = _caps_from(role, caps_in)
        valid_sections = known_sections()
        sections = u.get("sections", [])
        if sections != "*":
            sections = [canon_section(s) for s in sections if canon_section(s) in valid_sections] if isinstance(sections, list) else []
        scopes_in = u.get("scopes") if isinstance(u.get("scopes"), dict) else {}
        scopes: Dict[str, list] = {}
        for sec, val in scopes_in.items():
            sec = canon_section(sec)
            if sec not in valid_sections:
                continue
            if isinstance(val, list):
                vals = [str(x).strip() for x in val if str(x).strip()]
                if vals:
                    scopes[sec] = vals
        users.append({
            "email": email,
            "name": str(u.get("name") or "").strip(),
            "role": role,
            "enabled": bool(u.get("enabled", True)),
            "caps": caps,
            "sections": sections,
            "scopes": scopes,
        })

    # "Puede gestionar accesos" es la capacidad crítica: debe quedar al menos uno.
    active_admins = [u for u in users if u["caps"].get("manageAccess") and u["enabled"]]
    if not active_admins and not ADMIN_EMAILS:
        raise ValueError("Debe quedar al menos una persona que pueda gestionar accesos")
    if saver_email not in ADMIN_EMAILS:
        saver = next((u for u in users if u["email"] == saver_email), None)
        if not saver or not saver["caps"].get("manageAccess") or not saver["enabled"]:
            raise ValueError("Tu propio usuario debe conservar el permiso de gestionar accesos")

    return {
        "version": 2,
        "groups": access_groups(payload),
        "restricted": bool(payload.get("restricted")),
        "users": users,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "updatedBy": saver_email,
    }


# ── UPLOAD JOB HELPERS ────────────────────────────────────────────────────

def _create_job(project_code: str, project_name: str, mode: str = "urls") -> str:
    job_id = uuid.uuid4().hex
    with _upload_jobs_lock:
        _upload_jobs[job_id] = {
            "id": job_id,
            "mode": mode,
            "projectCode": project_code,
            "projectName": project_name,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "status": "queued",
            "files": [],
            "summary": None,
        }
    return job_id

def _set_job_status(job_id: str, status: str, summary: Any = None) -> None:
    with _upload_jobs_lock:
        job = _upload_jobs.get(job_id)
        if job:
            job["status"] = status
            if summary is not None:
                job["summary"] = summary

def _progress_cb_for_job(job_id: str):
    def _cb(idx: int, event: str, payload: dict):
        with _upload_jobs_lock:
            job = _upload_jobs.get(job_id)
            if not job:
                return
            if idx >= 0 and idx < len(job["files"]):
                f = job["files"][idx]
                if event == "downloading":
                    f["phase"] = "downloading"
                    f["downloaded"] = int(payload.get("downloaded", 0) or 0)
                    f["downloadTotal"] = int(payload.get("total", 0) or 0)
                elif event == "downloaded":
                    f["phase"] = "downloaded"
                    f["downloaded"] = int(payload.get("size", 0) or 0)
                elif event == "uploading":
                    f["phase"] = "uploading"
                elif event == "uploaded":
                    f["phase"] = "uploaded"
                    f["uploaded"] = int(payload.get("size", 0) or 0)
                    f["blob"] = payload.get("blob")
                elif event == "error":
                    f["phase"] = "error"
                    f["error"] = payload.get("error")
            else:
                if event == "finished":
                    job["status"] = "finished"
                    job["summary"] = payload.get("summary")
    return _cb


# ══════════════════════════════════════════════════════════════════════════════
# GET /api/thumb
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="thumb", methods=["GET", "OPTIONS"])
def thumb(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return func.HttpResponse("", status_code=204, headers=binary_headers("application/json"))

    blob_path = (req.params.get("blobPath") or "").strip()
    ext = ext_of(blob_path)
    if not blob_path:
        return err("blobPath es requerido")

    _, auth_err = require_blob_access(req, blob_path)
    if auth_err:
        return auth_err
    # Formatos que no son imagen (Word, PowerPoint, CAD…): solo hay miniatura si
    # alguien la precalculó en _thumbs/. 404 y no 400 para que el frontend caiga
    # al ícono de tipo sin ruido en consola.
    source_path = blob_path
    if ext not in THUMBABLE_IMAGE_EXT:
        source_path = thumb_sidecar_name(blob_path)
        if not blob_exists(source_path):
            return err("Sin miniatura precalculada para este archivo", 404)

    try:
        max_width = int(req.params.get("w", "480"))
    except Exception:
        max_width = 480
    try:
        quality = int(req.params.get("q", "72"))
    except Exception:
        quality = 72
    trim = (req.params.get("mode") or "").strip().lower() == "logo"

    max_width = max(160, min(max_width, 1280))
    quality = max(40, min(quality, 90))

    cache_key = f"thumb:{source_path}:{max_width}:{quality}:{'logo' if trim else 'std'}"
    cached = cache_get(cache_key)
    if cached is not None:
        return func.HttpResponse(body=cached[0], status_code=200, headers=binary_headers(cached[1]))

    try:
        svc = get_blob_service()
        bc = svc.get_blob_client(container=CONTAINER, blob=source_path)
        raw = bc.download_blob().readall()
        thumb_bytes, content_type = build_thumbnail_bytes(raw, max_width=max_width, quality=quality, trim=trim)
        cache_set(cache_key, (thumb_bytes, content_type), ttl_seconds=300)
        return func.HttpResponse(body=thumb_bytes, status_code=200, headers=binary_headers(content_type))
    except Exception as exc:
        logging.error("thumb: %s", exc)
        return err(str(exc), 500)


# ── Etiquetas de clasificación de Obra ─────────────────────────────────────
def tags_store():
    return Tags(load_json_blob, update_json_blob, CONFIG_PREFIX)


def tags_invalidate():
    with _cache_lock:
        _cache.pop('tags-snapshot', None)


def tags_cleanup_deleted(paths):
    try:
        tags_store().cleanup(paths=paths)
    finally:
        tags_invalidate()


@app.route(route="tags/{action?}/{detail?}", methods=["GET", "POST", "OPTIONS"])
def tags_endpoint(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == 'OPTIONS':
        return options_ok()
    action, detail = req.route_params.get('action', ''), req.route_params.get('detail', '')
    # Las etiquetas son una herramienta interna del Equipo TI: leer también exige tagMedia.
    perms, auth_err = require_perms(req, section='proyectos', cap='tagMedia')
    if auth_err:
        return auth_err
    store = tags_store()
    allowed = lambda code: perms_allow_item(perms, 'proyectos', code)
    try:
        if req.method == 'GET' and not action:
            snapshot = cache_get('tags-snapshot')
            if snapshot is None:
                snapshot = (store.catalog(), store.visible(lambda code: True))
                cache_set('tags-snapshot', snapshot, ttl_seconds=30)
            catalog, assignments = snapshot
            stats = {}
            for path in sorted(assignments):
                if not allowed(path.split('/')[0]):
                    continue
                kind = type_of(path.rsplit('/', 1)[-1])
                for id in assignments[path]:
                    st = stats.setdefault(id, {'count': 0, 'photoCount': 0, 'videoCount': 0, 'cover': None})
                    st['count'] += 1
                    st['photoCount'] += kind == 'img'
                    st['videoCount'] += kind == 'vid'
                    if kind == 'img' and not st['cover']:
                        st['cover'] = path
            empty = {'count': 0, 'photoCount': 0, 'videoCount': 0, 'cover': None}
            return ok({'catalog': [{**t, **stats.get(t['id'], empty)} for t in catalog]})
        if req.method == 'GET' and detail == 'files':
            if not any(t['id'] == action for t in store.catalog()):
                return err('La etiqueta no existe', 404)
            return ok(store.files(action, allowed))
        if req.method == 'POST' and action in ('lookup', 'apply') and not detail:
            body = req.get_json()
            if not isinstance(body, dict):
                raise ValueError('Payload JSON inválido')
            paths = tag_paths_list(body.get('paths'), 2000 if action == 'apply' else 3000)
            checked_projects = set()
            for path in paths:
                validate_project_id(path.split('/')[0])
                code = path.split('/')[0]
                if code in checked_projects:
                    continue
                _, denied = require_blob_access(req, path)
                if denied:
                    return denied
                checked_projects.add(code)
            if action == 'apply':
                try:
                    data = store.apply(paths, body.get('add', []), body.get('remove', []),
                                       perms['email'], datetime.now(timezone.utc).isoformat())
                finally:
                    tags_invalidate()
                return ok({p: data.get(p, {}).get('tags', []) for p in paths})
            data = store.assignments()
            valid = {t['id'] for t in store.catalog()}
            return ok({p: [t for t in data.get(p, {}).get('tags', []) if t in valid] for p in paths})
        if req.method == 'POST' and action == 'catalog' and not detail:
            try:
                catalog = store.edit_catalog(req.get_json())
            finally:
                tags_invalidate()
            return ok({'catalog': catalog})
        return err('Ruta de etiquetas no disponible', 404)
    except ValueError as exc:
        return err(str(exc), 400)
    except Exception as exc:
        logging.exception('tags_endpoint')
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# Revisión de proyectos
# ══════════════════════════════════════════════════════════════════════════════
def load_review_base() -> list:
    with open(os.path.join(os.path.dirname(__file__), "hub-projects-review.json"), encoding="utf-8") as source:
        return json.load(source)


def review_blob_name() -> str:
    return f"{CONFIG_PREFIX.strip('/')}/review.json"


def review_projects(base: list, indexed: list, data: dict, names: dict) -> list:
    index = {p["code"]: p for p in indexed}
    projects = {p["code"]: p for p in base}
    for code in data.get("extra", []):
        projects.setdefault(code, {"code": code, "name": code})
    result = []
    base_codes = {p["code"] for p in base}
    for code, project in projects.items():
        source = index.get(code, project)
        state = data.get("projects", {}).get(code, {})
        result.append({"code": code, "name": source.get("name", project["name"]),
                       "photoCount": source.get("photoCount", 0), "videoCount": source.get("videoCount", 0),
                       "weeks": source.get("weeks", 0), "lastModified": source.get("lastModified"),
                       "missing": code not in index, "extra": code not in base_codes,
                       "assignee": "", "status": "pendiente", "note": "", "updatedAt": None,
                       "updatedBy": None, "reviewedAt": None, "reviewedBy": None, **state})
    return apply_project_names(result, names)


def validate_review_patch(body: Any, members: list) -> dict:
    if not isinstance(body, dict) or not body or set(body) - {"assignee", "status", "note"}:
        raise ValueError("Indica responsable, estado o nota")
    patch = dict(body)
    if "assignee" in patch:
        if not isinstance(patch["assignee"], str):
            raise ValueError("Responsable inválido")
        patch["assignee"] = patch["assignee"].strip().lower()
        if patch["assignee"] and patch["assignee"] not in members:
            raise ValueError("El responsable debe pertenecer al Equipo TI")
    if "status" in patch and patch["status"] not in ("pendiente", "en-revision", "revisado"):
        raise ValueError("Estado inválido")
    if "note" in patch and (not isinstance(patch["note"], str) or len(patch["note"]) > 500):
        raise ValueError("La nota admite hasta 500 caracteres")
    return patch


def update_review_state(data: dict, code: str, patch: dict, email: str, now: str) -> dict:
    data = data or {}
    states = dict(data.get("projects", {}))
    previous = states.get(code, {})
    entry = {"assignee": "", "status": "pendiente", "note": "", "reviewedAt": None,
             "reviewedBy": None, **previous, **patch, "updatedAt": now, "updatedBy": email}
    if "status" in patch and patch["status"] != previous.get("status", "pendiente"):
        entry["reviewedAt"] = now if patch["status"] == "revisado" else None
        entry["reviewedBy"] = email if patch["status"] == "revisado" else None
    states[code] = entry
    return {**data, "projects": states}


def review_round_robin(data: dict, codes: list, assignees: list, only_unassigned: bool,
                       email: str, now: str) -> dict:
    position = 0
    for code in dict.fromkeys(codes):
        if only_unassigned and (data or {}).get("projects", {}).get(code, {}).get("assignee"):
            continue
        data = update_review_state(data, code, {"assignee": assignees[position % len(assignees)]}, email, now)
        position += 1
    return data or {}


def review_codes(value: Any) -> list:
    if not isinstance(value, list) or any(not isinstance(code, str) for code in value):
        raise ValueError("Los códigos deben ser una lista")
    for code in value:
        validate_project_id(code)
    return list(dict.fromkeys(value))


@app.route(route="review", methods=["GET", "OPTIONS"])
def get_review(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    perms, auth_err = require_perms(req, cap="review")
    if auth_err:
        return auth_err
    try:
        indexed = load_json_blob(index_projects_blob_name())
        if not isinstance(indexed, list):
            return err("El índice de proyectos no está disponible", 503)
        names = load_project_names()
        return ok({"projects": review_projects(load_review_base(), indexed,
                                              load_json_blob(review_blob_name()) or {}, names),
                   "assignees": access_groups(load_access_config())["equipo-ti"]["members"],
                   "availableProjects": apply_project_names([
                       {"code": p["code"], "name": p.get("name", p["code"]),
                        "photoCount": p.get("photoCount", 0), "videoCount": p.get("videoCount", 0),
                        "weeks": p.get("weeks", 0), "lastModified": p.get("lastModified")} for p in indexed], names)})
    except Exception as exc:
        logging.exception("get_review")
        return err(str(exc), 500)


@app.route(route="review/{code}", methods=["POST", "OPTIONS"])
def post_review(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    perms, auth_err = require_perms(req, cap="review")
    if auth_err:
        return auth_err
    try:
        code = req.route_params.get("code", "")
        body = req.get_json()
        if not isinstance(body, dict):
            raise ValueError("Solicitud inválida")
        base = {p["code"] for p in load_review_base()}
        members = access_groups(load_access_config())["equipo-ti"]["members"]
        now = datetime.now(timezone.utc).isoformat()
        email = perms["email"]
        if code == "assign":
            codes = review_codes(body.get("codes"))
            people = body.get("assignees")
            if not isinstance(people, list) or not people:
                raise ValueError("Elige al menos un responsable")
            people = list(dict.fromkeys(validate_review_patch({"assignee": p}, members)["assignee"] for p in people))
            if not all(people):
                raise ValueError("Elige responsables del Equipo TI")
            only = body.get("onlyUnassigned", False)
            if not isinstance(only, bool):
                raise ValueError("onlyUnassigned debe ser booleano")

            def transform(data):
                data = data or {}
                if set(codes) - base - set(data.get("extra", [])):
                    raise ValueError("Proyecto fuera de la lista de revisión")
                return review_round_robin(data, codes, people, only, email, now)
        elif code == "extra":
            add, remove = review_codes(body.get("add", [])), review_codes(body.get("remove", []))
            indexed = load_json_blob(index_projects_blob_name())
            if not isinstance(indexed, list):
                return err("El índice de proyectos no está disponible", 503)
            if (set(add) | set(remove)) - {p["code"] for p in indexed}:
                raise ValueError("El proyecto debe existir en el índice")
            if set(remove) & base:
                raise ValueError("No se puede quitar un proyecto de la lista base")

            def transform(data):
                data = data or {}
                extra = [c for c in data.get("extra", []) if c not in remove and c not in base]
                return {**data, "extra": list(dict.fromkeys(extra + [c for c in add if c not in base]))}
        else:
            validate_project_id(code)
            patch = validate_review_patch(body, members)

            def transform(data):
                data = data or {}
                if code not in base and code not in data.get("extra", []):
                    raise ValueError("Proyecto fuera de la lista de revisión")
                return update_review_state(data, code, patch, email, now)
        saved = update_json_blob(review_blob_name(), transform)
        return ok({"saved": True, "projects": saved.get("projects", {}), "extra": saved.get("extra", [])})
    except ValueError as exc:
        return err(str(exc), 400)
    except Exception as exc:
        logging.exception("post_review")
        return err(str(exc), 500)


# GET /api/projects
@app.route(route="projects", methods=["GET", "OPTIONS"])
def get_projects(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    perms, auth_err = require_perms(req, section="proyectos")
    if auth_err:
        return auth_err

    # El caché guarda la lista completa; el filtrado por permisos es por caller.
    cached = cache_get("projects")
    if cached is not None:
        return ok(_filter_projects_by_perms(normalize_projects_payload(cached), perms))

    if INDEX_ENABLED:
        try:
            indexed = load_json_blob(index_projects_blob_name())
            if isinstance(indexed, list):
                normalized = normalize_projects_payload(indexed)
                cache_set("projects", normalized)
                return ok(_filter_projects_by_perms(normalized, perms))
        except Exception as exc:
            logging.warning("get_projects index fallback: %s", exc)

    try:
        svc = get_blob_service()
        cc  = svc.get_container_client(CONTAINER)
        project_map: Dict[str, Dict] = {}

        for blob in cc.list_blobs():
            if should_skip_for_content_index(blob.name):
                continue
            parts = blob.name.split("/")
            if len(parts) < 2:
                continue
            proj_folder = parts[0]

            if proj_folder not in project_map:
                slug = " ".join(proj_folder.split("_")[1:]).upper().replace("-", " ")
                project_map[proj_folder] = {
                    "code": proj_folder, "name": slug,
                    "weeks": set(), "types": set(),
                    "lastModified": None, "fileCount": 0, "photoCount": 0, "videoCount": 0, "hasMarker": False,
                    "coverPath": None, "coverIsDrone": False,
                }

            p = project_map[proj_folder]

            if len(parts) == 2 and is_marker_file(parts[1]):
                p["hasMarker"] = True
                continue

            if len(parts) < 3 or not parts[-1]:
                continue

            week_folder = folder_path_of(blob.name)
            file_name = parts[-1]
            if not week_folder:
                continue
            if is_marker_file(file_name):
                p["hasMarker"] = True
                continue

            p["weeks"].add(week_folder)
            p["fileCount"] += 1
            p["photoCount"] += type_of(file_name) == "img"
            p["videoCount"] += type_of(file_name) == "vid"
            pfx = prefix_of(file_name)
            if pfx != "FILE":
                p["types"].add(pfx)
            if type_of(file_name) == "img":
                is_drone = pfx == "DRN"
                if p["coverPath"] is None or (is_drone and not p["coverIsDrone"]):
                    p["coverPath"] = blob.name
                    p["coverIsDrone"] = is_drone
            lm = blob.last_modified
            if lm and (p["lastModified"] is None or lm > p["lastModified"]):
                p["lastModified"] = lm

        result = []
        for proj in sorted(project_map.values(), key=lambda x: x["code"]):
            status_info = derive_project_status(
                file_count=proj["fileCount"],
                weeks_count=len(proj["weeks"]),
                last_modified=proj["lastModified"],
            )
            result.append({
                "code":         proj["code"],
                "name":         proj["name"],
                "weeks":        len(proj["weeks"]),
                "photoCount":   proj["photoCount"], "videoCount": proj["videoCount"],
                "types":        "+".join(sorted(proj["types"])),
                "status":       status_info["status"],
                "statusReason": status_info["statusReason"],
                "hasContent":   proj["fileCount"] > 0,
                "lastModified": proj["lastModified"].isoformat() if proj["lastModified"] else None,
                "coverPath":    proj["coverPath"],
            })
        normalized = normalize_projects_payload(result)
        cache_set("projects", normalized)
        return ok(_filter_projects_by_perms(normalized, perms))

    except Exception as exc:
        logging.error("get_projects: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# GET/POST /api/projects/{project_id}/settings
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="projects/{project_id}/settings", methods=["GET", "POST", "OPTIONS"])
def project_settings(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    _, auth_err = require_perms(req, cap="upload")
    if auth_err:
        return auth_err

    project_id = req.route_params.get("project_id", "").strip()
    if not project_id:
        return err("project_id es requerido", 400)

    if req.method == "GET":
        try:
            settings = load_json_blob(project_settings_blob_name(project_id)) or {}
            return ok(settings)
        except Exception as exc:
            logging.error("get_project_settings: %s", exc)
            return err(str(exc), 500)

    if req.method == "POST":
        try:
            payload = req.get_json()
        except ValueError:
            return err("Payload JSON inválido", 400)

        if not isinstance(payload, dict):
            return err("Payload debe ser un objeto JSON", 400)

        settings = {
            "prefijo": payload.get("prefijo", "FOT"),
            "maxWorkers": int(payload.get("maxWorkers", 4)) if payload.get("maxWorkers") is not None else 4,
            "refreshIndex": bool(payload.get("refreshIndex", True)),
            "savedAt": datetime.now(timezone.utc).isoformat(),
        }

        try:
            save_json_blob(project_settings_blob_name(project_id), settings)
            return ok({"saved": True, "projectId": project_id, "settings": settings})
        except Exception as exc:
            logging.error("save_project_settings: %s", exc)
            return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# GET /api/projects/{project_id}/weeks
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="projects/{project_id}/weeks", methods=["GET", "OPTIONS"])
def get_weeks(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()

    project_id = req.route_params.get("project_id", "")
    _, auth_err = require_perms(req, section="proyectos", item=project_id)
    if auth_err:
        return auth_err
    cache_key = f"weeks:{project_id}"
    cached = cache_get(cache_key)
    if cached is not None:
        return ok(cached)

    if INDEX_ENABLED:
        try:
            indexed = load_json_blob(index_weeks_blob_name(project_id))
            if isinstance(indexed, list):
                cache_set(cache_key, indexed)
                return ok(indexed)
        except Exception as exc:
            logging.warning("get_weeks index fallback (%s): %s", project_id, exc)

    try:
        svc = get_blob_service()
        cc  = svc.get_container_client(CONTAINER)
        week_map: Dict[str, Dict] = {}

        for blob in cc.list_blobs(name_starts_with=f"{project_id}/"):
            parts = blob.name.split("/")
            if len(parts) < 3 or not parts[-1]:
                continue
            week = folder_path_of(blob.name)
            fname = parts[-1]
            if not week:
                continue
            if is_marker_file(fname):
                continue
            if week not in week_map:
                week_map[week] = {"week": week, "count": 0, "types": set()}
            week_map[week]["count"] += 1
            pfx = prefix_of(fname)
            if pfx != "FILE":
                week_map[week]["types"].add(pfx)

        weeks = [
            {"week": k, "count": v["count"], "types": sorted(v["types"])}
            for k, v in sorted(week_map.items())
        ]
        cache_set(cache_key, weeks)
        return ok(weeks)

    except Exception as exc:
        logging.error("get_weeks: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# GET /api/projects/{project_id}/weeks/{week}/files
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="projects/{project_id}/weeks/{week}/files", methods=["GET", "OPTIONS"])
def get_files(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()

    project_id = req.route_params.get("project_id", "")
    week       = normalize_folder_path(req.route_params.get("week", ""))
    _, auth_err = require_perms(req, section="proyectos", item=project_id)
    if auth_err:
        return auth_err
    cache_key = f"files:{project_id}:{week}"
    cached = cache_get(cache_key)
    if cached is not None:
        return ok(cached)

    if INDEX_ENABLED:
        try:
            indexed = load_json_blob(index_files_blob_name(project_id, week))
            if isinstance(indexed, list):
                cache_set(cache_key, indexed)
                return ok(indexed)
        except Exception as exc:
            logging.warning("get_files index fallback (%s/%s): %s", project_id, week, exc)

    try:
        files = list_folder_children(project_id, week)["files"]
        cache_set(cache_key, files)
        return ok(files)

    except Exception as exc:
        logging.error("get_files: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# GET /api/projects/{project_id}/browse
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="projects/{project_id}/browse", methods=["GET", "OPTIONS"])
def browse_folder(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()

    project_id = req.route_params.get("project_id", "")
    path = normalize_folder_path(req.params.get("path", ""))
    _, auth_err = require_perms(req, section="proyectos", item=project_id)
    if auth_err:
        return auth_err
    cache_key = f"browse:{project_id}:{path}"
    cached = cache_get(cache_key)
    if cached is not None:
        return ok(cached)

    try:
        payload = list_folder_children(project_id, path)
        result = {"path": path, **payload}
        cache_set(cache_key, result)
        return ok(result)

    except Exception as exc:
        logging.error("browse_folder: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# POST /api/sas/generate
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="sas/generate", methods=["POST", "OPTIONS"])
def sas_generate(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()

    try:
        body           = req.get_json()
        blob_path      = body.get("blobPath", "").strip()
        expiry_minutes = min(int(body.get("expiryMinutes", 60)), 1440)
        if not blob_path:
            return err("blobPath es requerido")
        _, auth_err = require_blob_access(req, blob_path)
        if auth_err:
            return auth_err
        # preferProxy: para reproducir, entrega la copia liviana si existe. El
        # permiso se valida contra el original, nunca contra la ruta _proxies/.
        served_path = blob_path
        if body.get("preferProxy") and blob_path.lower().endswith(PROXYABLE_VIDEO_EXT):
            proxy = proxy_sidecar_name(blob_path)
            if blob_exists(proxy):
                served_path = proxy
        download_name = None
        if body.get("download") and served_path == blob_path:
            download_name = str(body.get("fileName") or blob_path.rsplit("/", 1)[-1])[:200]
        sas_url = make_sas_url(served_path, expiry_minutes, download_name)
        return ok({"sasUrl": sas_url, "expiresInMinutes": expiry_minutes,
                   "proxy": served_path != blob_path})
    except Exception as exc:
        logging.error("sas_generate: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# POST /api/share/create
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="share/create", methods=["POST", "OPTIONS"])
def share_create(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    _, auth_err = require_perms(req, cap="share")
    if auth_err:
        return auth_err

    try:
        body        = req.get_json()
        project_id  = body.get("projectId", "").strip()
        week        = body.get("week", "").strip()
        expiry_days = min(int(body.get("expiryDays", 7)), 90)
        if not project_id:
            return err("projectId es requerido")

        private = f"{CONFIG_PREFIX.strip('/')}/hardware/"
        prefix = f"{project_id}/{week}/" if week else f"{project_id}/"
        if prefix.startswith(private) or private.startswith(prefix):
            return err("Hardware solo está disponible con su permiso; no admite enlaces externos", 403)

        token      = uuid.uuid4().hex
        expires_at = datetime.now(timezone.utc) + timedelta(days=expiry_days)
        origin     = req.headers.get("Origin", "")

        share_data = {
            "token": token, "projectId": project_id, "week": week,
            "expiresAt": expires_at.isoformat(), "active": True,
        }
        save_share(share_data)
        return ok({
            "token":    token,
            "shareUrl": f"{origin}/share/{token}",
            "expiresAt": expires_at.isoformat(),
        })
    except Exception as exc:
        logging.error("share_create: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# GET /api/share/list
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="share/list", methods=["GET", "OPTIONS"])
def share_list(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    _, auth_err = require_perms(req, cap="share")
    if auth_err:
        return auth_err

    try:
        now = datetime.now(timezone.utc)
        shares = list_shares()
        result = [{**s, "expired": datetime.fromisoformat(s["expiresAt"]) < now} for s in shares]
        result.sort(key=lambda x: x.get("expiresAt", ""), reverse=True)
        return ok(result)
    except Exception as exc:
        logging.error("share_list: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# GET /api/share/{share_token}   DELETE /api/share/{share_token}
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="share/{share_token}", methods=["GET", "DELETE", "OPTIONS"])
def share_resolve(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()

    share_token = req.route_params.get("share_token", "")

    if req.method == "DELETE":
        _, auth_err = require_perms(req, cap="share")
        if auth_err:
            return auth_err
        try:
            delete_share(share_token)
            return ok({"deleted": True})
        except Exception as exc:
            logging.error("share_delete: %s", exc)
            return err(str(exc), 500)

    share = load_share(share_token)
    if not share:
        return err("Enlace no encontrado", 404)
    if not share.get("active", True):
        return err("Enlace revocado", 410)
    expires_at = datetime.fromisoformat(share["expiresAt"])
    if datetime.now(timezone.utc) > expires_at:
        return err("Enlace expirado", 410)

    remaining = max(int((expires_at - datetime.now(timezone.utc)).total_seconds() / 60), 5)

    def with_play_url(files: list) -> list:
        """Añade playUrl (la copia liviana) a los videos que la tienen. Un solo
        listado de _proxies/ por proyecto, no una consulta por archivo."""
        videos = [f for f in files if f["path"].lower().endswith(PROXYABLE_VIDEO_EXT)]
        if not videos:
            return files
        cc = get_blob_service().get_container_client(CONTAINER)
        roots = {f["path"].split("/")[0] for f in videos}
        proxies = set()
        for root in roots:
            proxies.update(b.name for b in cc.list_blobs(name_starts_with=f"{PROXIES_PREFIX.strip('/')}/{root}/"))
        for f in videos:
            proxy = proxy_sidecar_name(f["path"])
            if proxy in proxies:
                try:
                    f["playUrl"] = make_sas_url(proxy, remaining)
                except Exception:
                    pass
        return files

    # Colección de favoritos: el share lleva una lista explícita de rutas.
    if share.get("type") == "collection" or isinstance(share.get("files"), list):
        try:
            files = []
            for p in (share.get("files") or []):
                if not isinstance(p, str):
                    continue
                if p.startswith(f"{CONFIG_PREFIX.strip('/')}/hardware/"):
                    continue
                fname = p.split("/")[-1]
                if not fname or is_marker_file(fname):
                    continue
                try:
                    sas_url = make_sas_url(p, remaining)
                except Exception:
                    sas_url = ""
                files.append({"name": fname, "path": p, "type": type_of(fname), "sasUrl": sas_url})
            return ok({**share, "files": with_play_url(files)})
        except Exception as exc:
            logging.error("share_resolve collection: %s", exc)
            return err(str(exc), 500)

    try:
        svc = get_blob_service()
        cc  = svc.get_container_client(CONTAINER)
        project_id = share["projectId"]
        week       = share.get("week", "")
        prefix     = f"{project_id}/{week}/" if week else f"{project_id}/"
        files      = []

        for blob in cc.list_blobs(name_starts_with=prefix):
            if blob.name.startswith(f"{CONFIG_PREFIX.strip('/')}/hardware/"):
                continue
            fname = blob.name.split("/")[-1]
            if not fname or is_marker_file(fname):
                continue
            try:
                sas_url = make_sas_url(blob.name, remaining)
            except Exception:
                sas_url = ""
            files.append({"name": fname, "path": blob.name, "type": type_of(fname), "sasUrl": sas_url})

        files.sort(key=lambda f: f["name"])
        return ok({**share, "files": with_play_url(files)})

    except Exception as exc:
        logging.error("share_resolve: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# GET /api/health
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="health", methods=["GET", "OPTIONS"])
def health(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    return ok({
        "status":    "ok",
        "storage":   bool(CONN_STR),
        "hasKey":    bool(ACCOUNT_KEY),
        "container": CONTAINER,
        "account":   ACCOUNT_NAME,
        "indexEnabled": INDEX_ENABLED,
        "indexPrefix": INDEX_PREFIX,
        "indexRefreshCron": INDEX_REFRESH_CRON,
    })


# ══════════════════════════════════════════════════════════════════════════════
# GET /api/me — identidad y permisos efectivos del usuario autenticado
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="me", methods=["GET", "OPTIONS"])
def get_me(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    caller = get_caller(req)
    if caller is None:
        return err("No autorizado", 401)
    return ok(effective_perms(caller))


# ══════════════════════════════════════════════════════════════════════════════
# GET /api/debug/auth — depuración temporal de autenticación
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="debug/auth", methods=["GET", "OPTIONS"])
def debug_auth(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()

    auth = req.headers.get("Authorization", "")
    x_access_token = req.headers.get("X-Access-Token", "")
    x_client_principal = req.headers.get("x-ms-client-principal", "") or req.headers.get("X-MS-CLIENT-PRINCIPAL", "")
    x_client_principal_id = req.headers.get("x-ms-client-principal-id", "") or req.headers.get("X-MS-CLIENT-PRINCIPAL-ID", "")
    x_ms_headers = {k: v for k, v in req.headers.items() if k.lower().startswith("x-ms-")}
    caller = get_caller(req)

    token = auth or x_access_token
    token_kind = "none"
    claims = None
    if token:
        if not token.startswith("Bearer ") and token.count(".") == 2:
            token = f"Bearer {token}"
        if token.startswith("Bearer "):
            token_kind = "bearer"
            try:
                claims = _decode_claims_unverified(token[7:].strip())
            except Exception as exc:
                claims = {"error": str(exc)}

    return ok({
        "authHeaderPresent": bool(auth),
        "xAccessTokenPresent": bool(x_access_token),
        "xClientPrincipalPresent": bool(x_client_principal),
        "xClientPrincipalIdPresent": bool(x_client_principal_id),
        "xMsHeaders": x_ms_headers,
        "tokenKind": token_kind,
        "caller": caller,
        "claims": {
            "tid": claims.get("tid") if isinstance(claims, dict) else None,
            "aud": claims.get("aud") if isinstance(claims, dict) else None,
            "scp": claims.get("scp") if isinstance(claims, dict) else None,
            "upn": claims.get("upn") if isinstance(claims, dict) else None,
            "preferred_username": claims.get("preferred_username") if isinstance(claims, dict) else None,
            "unique_name": claims.get("unique_name") if isinstance(claims, dict) else None,
            "oid": claims.get("oid") if isinstance(claims, dict) else None,
            "sub": claims.get("sub") if isinstance(claims, dict) else None,
            "name": claims.get("name") if isinstance(claims, dict) else None,
            "claimKeys": sorted(claims.keys()) if isinstance(claims, dict) else [],
            "error": claims.get("error") if isinstance(claims, dict) and "error" in claims else None,
        },
    })


# ══════════════════════════════════════════════════════════════════════════════
# GET/POST /api/access — configuración de accesos (solo administradores)
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="access", methods=["GET", "POST", "OPTIONS"])
def access_config_endpoint(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()

    perms, auth_err = require_perms(req, cap="manageAccess")
    if auth_err:
        return auth_err

    if req.method == "GET":
        cfg = load_access_config()
        return ok({
            "config": {**(cfg or {"restricted": False, "users": []}), "groups": access_groups(cfg)},
            "exists": cfg is not None,
            "bootstrap": perms.get("bootstrap", False),
            "envAdmins": sorted(ADMIN_EMAILS),
            "knownSections": known_sections(),
            "sections": load_sections(),
            "capabilities": list(CAPS),
        })

    try:
        payload = req.get_json()
    except ValueError:
        return err("Payload JSON inválido", 400)

    try:
        cfg = sanitize_access_config(payload, perms["email"])
    except ValueError as exc:
        return err(str(exc), 400)

    try:
        save_json_blob(access_config_blob_name(), cfg)
        with _cache_lock:
            _cache.pop(ACCESS_CACHE_KEY, None)
        return ok({"saved": True, "config": cfg})
    except Exception as exc:
        logging.error("save_access_config: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# GET/POST /api/sections — catálogo de secciones del hub
#
# GET  lo lee cualquier usuario autenticado (el menú se arma con esto).
# POST exige manageAccess: reemplaza la lista completa, en el orden recibido.
#
# Borrar una sección la saca del menú pero NO toca los archivos de _media/<id>/:
# si se vuelve a crear con el mismo id, el contenido reaparece tal cual.
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="sections", methods=["GET", "POST", "OPTIONS"])
def sections_endpoint(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()

    if req.method == "GET":
        _, auth_err = require_perms(req)
        if auth_err:
            return auth_err
        return ok({"sections": load_sections(), "kinds": list(SECTION_KINDS),
                   "protected": PROTECTED_SECTION})

    _, auth_err = require_perms(req, cap="manageAccess")
    if auth_err:
        return auth_err

    try:
        payload = req.get_json()
    except ValueError:
        return err("Payload JSON inválido", 400)

    raw = payload.get("sections") if isinstance(payload, dict) else payload
    try:
        items = sanitize_sections(raw)
    except ValueError as exc:
        return err(str(exc), 400)

    try:
        save_json_blob(sections_config_blob_name(), {"sections": items})
        with _cache_lock:
            _cache.pop(SECTIONS_CACHE_KEY, None)
        return ok({"saved": True, "sections": items})
    except Exception as exc:
        logging.error("save_sections: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# BIBLIOTECA DE MEDIA — carpetas ANIDADAS a n niveles
#
# Estructura: _media/<seccion>/<a>/<b>/<c>/archivo.ext
# Las rutas de carpeta viajan por query/body (no por route params) para no pelear
# con el encoding de "/" y los espacios dentro de las plantillas de ruta.
#
#   GET  /api/media/{section}?path=a/b   → subcarpetas + archivos de ESE nivel
#   GET  /api/media/{section}?tree=1     → todas las rutas de carpeta (plano)
#   POST /api/media/{section}            → crea carpeta {name, parentPath}
#   POST /api/media/{section}/plan       → SAS de escritura {folderPath, files}
#
# Permisos: la sección la controla `sections`; el scope por ítem se evalúa contra
# la carpeta RAÍZ (primer segmento), no cada subcarpeta — así la página Accesos
# sigue siendo manejable aunque haya muchos niveles.
# ══════════════════════════════════════════════════════════════════════════════
# Qué secciones viven en _media/ lo decide el catálogo editable (load_sections),
# no una tupla fija: al crear una sección nueva en el panel ya queda operativa.
_FOLDER_FORBIDDEN = set('/\\#?%*:|"<>')
_MEDIA_META_FILES = ("marca.json", "meta.json")
_MAX_FOLDER_DEPTH = 10

def _media_root(section: str) -> str:
    return f"{MEDIA_PREFIX.strip('/')}/{section}"

def _sanitize_folder_name(raw: str) -> Optional[str]:
    name = " ".join((raw or "").split())
    if not name or len(name) > 60:
        return None
    if name in (".", "..") or name.startswith((".", "_")) or any(c in _FOLDER_FORBIDDEN for c in name):
        return None
    return name

def _sanitize_folder_path(raw: Any) -> Optional[str]:
    """'a/b/c' validado segmento a segmento. '' (la raíz) es válido.
    Devuelve None si algún segmento es inválido (incluye '..' → sin path traversal)."""
    text = unquote(str(raw or "")).strip().strip("/")
    if not text:
        return ""
    segments = [s for s in text.split("/") if s.strip()]
    if not segments or len(segments) > _MAX_FOLDER_DEPTH:
        return None
    clean = []
    for seg in segments:
        c = _sanitize_folder_name(seg)
        if not c:
            return None
        clean.append(c)
    return "/".join(clean)

def _root_of(path: str) -> str:
    """Carpeta raíz de una ruta anidada: 'Grupo Ripcon/RIPCONCIV' → 'Grupo Ripcon'."""
    return path.split("/", 1)[0] if path else ""

def _is_dir_marker(blob) -> bool:
    """True si el blob es un marcador de directorio de ADLS Gen2 (HNS): la carpeta
    misma, no un archivo. Requiere listar con include=["metadata"]."""
    md = getattr(blob, "metadata", None) or {}
    return str(md.get("hdi_isfolder", "")).lower() == "true"

@app.route(route="media/{section}", methods=["GET", "POST", "OPTIONS"])
def media_section(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    section = (req.route_params.get("section") or "").strip().lower()
    if section not in library_sections():
        return err("Sección de media desconocida", 400)
    if req.method == "POST":
        return _media_create_folder(req, section)
    return _media_list(req, section)


def _media_create_folder(req: func.HttpRequest, section: str) -> func.HttpResponse:
    try:
        body = req.get_json()
    except ValueError:
        return err("Payload JSON inválido", 400)

    parent = _sanitize_folder_path(body.get("parentPath", ""))
    if parent is None:
        return err("Ruta de carpeta inválida", 400)
    name = _sanitize_folder_name(body.get("name", ""))
    if not name:
        return err('Nombre inválido: usa hasta 60 caracteres sin / \\ # ? % * : | " < >', 400)
    if parent and len(parent.split("/")) >= _MAX_FOLDER_DEPTH:
        return err(f"Máximo {_MAX_FOLDER_DEPTH} niveles de carpetas", 400)

    # En la raíz basta el permiso de sección; dentro, el scope mira la carpeta raíz.
    _, auth_err = require_perms(req, section=section,
                                item=_root_of(parent) if parent else None, cap="manageMedia")
    if auth_err:
        return auth_err

    rel = f"{parent}/{name}" if parent else name
    try:
        svc = get_blob_service()
        cc = svc.get_container_client(CONTAINER)
        prefix = f"{_media_root(section)}/{rel}/"
        for _ in cc.list_blobs(name_starts_with=prefix):
            return err("Ya existe una carpeta con ese nombre", 409)
        bc = svc.get_blob_client(container=CONTAINER, blob=f"{prefix}.keep")
        bc.upload_blob(b"", overwrite=True)
        return ok({"created": True, "name": name, "path": rel})
    except Exception as exc:
        logging.error("media_create_folder: %s", exc)
        return err(str(exc), 500)


def _media_list(req: func.HttpRequest, section: str) -> func.HttpResponse:
    path = _sanitize_folder_path(req.params.get("path", ""))
    if path is None:
        return err("Ruta de carpeta inválida", 400)
    want_tree = str(req.params.get("tree", "")).strip().lower() in ("1", "true", "yes")

    perms, auth_err = require_perms(req, section=section, item=_root_of(path) or None)
    if auth_err:
        return auth_err

    try:
        svc = get_blob_service()
        cc = svc.get_container_client(CONTAINER)
        root = _media_root(section)
        prefix = f"{root}/{path}/" if path else f"{root}/"

        def bump(entry: dict, leaf: str, blob) -> None:
            if leaf and not is_marker_file(leaf) and leaf not in _MEDIA_META_FILES:
                entry["fileCount"] += 1
                lm = blob.last_modified
                if lm and (entry["lastModified"] is None or lm > entry["lastModified"]):
                    entry["lastModified"] = lm

        def iso(entry: dict) -> dict:
            return {**entry, "lastModified": entry["lastModified"].isoformat() if entry["lastModified"] else None}

        # ── Árbol plano: todas las rutas de carpeta bajo `path` (para selectores) ──
        if want_tree:
            nodes: Dict[str, Dict[str, Any]] = {}
            for blob in cc.list_blobs(name_starts_with=prefix, include=["metadata"]):
                if _is_dir_marker(blob):
                    continue
                segments = blob.name[len(prefix):].split("/")
                leaf = segments[-1]
                for depth in range(1, len(segments)):
                    rel = "/".join(segments[:depth])
                    full = f"{path}/{rel}" if path else rel
                    node = nodes.setdefault(full, {"path": full, "name": segments[depth - 1],
                                                   "depth": depth - 1, "fileCount": 0, "lastModified": None})
                    bump(node, leaf, blob)
            out = [iso(n) for n in sorted(nodes.values(), key=lambda x: x["path"].lower())]
            out = [f for f in out if perms_allow_item(perms, section, _root_of(f["path"]))]
            return ok({"section": section, "path": path, "folders": out})

        # ── Un nivel: subcarpetas + archivos directos + metadata de la carpeta ──
        folders: Dict[str, Dict[str, Any]] = {}
        files: list = []
        meta = None
        found_any = False

        for blob in cc.list_blobs(name_starts_with=prefix, include=["metadata"]):
            found_any = True
            remainder = blob.name[len(prefix):]
            if not remainder:
                continue
            # Blobs-marcador de directorio (ADLS Gen2 / HNS): son la carpeta misma,
            # no un archivo. Sin esto aparecían como "archivos" fantasma de 0 bytes.
            if _is_dir_marker(blob):
                if "/" not in remainder:
                    node = folders.setdefault(remainder, {"name": remainder,
                        "path": f"{path}/{remainder}" if path else remainder,
                        "fileCount": 0, "lastModified": None})  # asegura que la carpeta exista aunque esté vacía
                continue
            if "/" in remainder:
                sub = remainder.split("/", 1)[0]
                node = folders.setdefault(sub, {"name": sub, "path": f"{path}/{sub}" if path else sub,
                                                "fileCount": 0, "lastModified": None})
                bump(node, remainder.split("/")[-1], blob)
                continue

            leaf = remainder
            if is_marker_file(leaf):
                continue
            if leaf in _MEDIA_META_FILES:
                try:
                    raw = cc.get_blob_client(blob).download_blob().readall()
                    if len(raw) <= 32_768:
                        parsed = json.loads(raw.decode("utf-8"))
                        if isinstance(parsed, dict):
                            meta = parsed
                except Exception as exc:
                    logging.warning("media meta inválido (%s): %s", blob.name, exc)
                continue
            files.append({
                "name": leaf, "path": blob.name, "size": blob.size, "type": type_of(leaf),
                "lastModified": blob.last_modified.isoformat() if blob.last_modified else None,
            })

        if path and not found_any:
            return err("Carpeta no encontrada", 404)

        folder_list = [iso(f) for f in sorted(folders.values(), key=lambda x: x["name"].lower())]
        # El scope por ítem solo aplica a las carpetas raíz de la sección.
        if not path:
            folder_list = _filter_media_folders_by_perms(folder_list, perms, section)
        files.sort(key=lambda f: f["name"].lower())
        return ok({"section": section, "path": path, "folders": folder_list, "files": files, "meta": meta})
    except Exception as exc:
        logging.error("media_list: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# POST /api/media/{section}/plan   body: { folderPath, files:[{name,size}] }
# Devuelve SAS de escritura por archivo para subir DIRECTO navegador→blob (sin
# pasar por la Function), evitando los límites de tamaño del multipart.
# folderPath admite anidamiento: "Grupo Ripcon/RIPCONCIV".
# ══════════════════════════════════════════════════════════════════════════════
# ══════════════════════════════════════════════════════════════════════════════
# POST /api/media/{section}/delete — borrar archivos o una carpeta completa
#
#   { "paths": ["_media/documentos/Plantillas/informe.docx", ...] }  → archivos
#   { "folderPath": "Plantillas/2024" }                              → carpeta recursiva
#
# Solo con la capacidad deleteMedia (por defecto, únicamente el rol admin).
# El material de obra NO se puede borrar por aquí: la ruta exige una sección de
# biblioteca y "proyectos" es de tipo 'projects', así que nunca entra — más la
# comprobación explícita de que toda ruta cuelgue de _media/<seccion>/.
# ══════════════════════════════════════════════════════════════════════════════
_MAX_DELETE_BATCH = 500

@app.route(route="media/{section}/delete", methods=["POST", "OPTIONS"])
def media_delete(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()

    section = (req.route_params.get("section") or "").strip().lower()
    if canon_section(section) == PROTECTED_SECTION:
        return err("El material de obra no se puede borrar desde el hub", 403)
    if section not in library_sections():
        return err("Sección de media desconocida", 400)

    # Autenticar antes de mirar el cuerpo: si no, un anónimo podría sondear qué
    # rutas existen por la forma del error. El scope por carpeta se revisa
    # después, cuando ya sabemos sobre qué se está pidiendo actuar.
    _, auth_err = require_perms(req, section=section, cap="deleteMedia")
    if auth_err:
        return auth_err

    try:
        body = req.get_json()
    except ValueError:
        return err("Payload JSON inválido", 400)

    root = _media_root(section)
    folder_raw = body.get("folderPath")
    paths_raw = body.get("paths")

    # ── Carpeta completa ──────────────────────────────────────────────────────
    if folder_raw is not None:
        folder = _sanitize_folder_path(folder_raw)
        if not folder:
            return err("Ruta de carpeta inválida", 400)
        _, auth_err = require_perms(req, section=section, item=_root_of(folder), cap="deleteMedia")
        if auth_err:
            return auth_err
        prefix = f"{root}/{folder}/"
        # En cuentas con espacio de nombres jerárquico (HNS/ADLS Gen2) cada carpeta
        # es además un blob-marcador de directorio SIN barra final. list con la
        # barra trae los hijos pero no ese marcador, así que hay que borrarlo aparte
        # o la carpeta queda como directorio vacío y sigue apareciendo.
        marker = f"{root}/{folder}"
        try:
            svc = get_blob_service()
            cc = svc.get_container_client(CONTAINER)
            blobs = list(cc.list_blobs(name_starts_with=prefix, include=["metadata"]))
            # La carpeta puede existir solo como marcador (creada y vaciada antes):
            # no dar 404 si el marcador está aunque no haya hijos.
            if not blobs and not blob_exists(marker):
                return err("La carpeta no existe o ya está vacía", 404)
            # Cuenta para el usuario: archivos reales, sin marcadores ni .keep.
            file_count = sum(
                1 for b in blobs
                if not _is_dir_marker(b) and not is_marker_file(b.name.split("/")[-1])
            )
            names = [b.name for b in blobs]
            names.append(marker)
            _delete_blobs(cc, names)
            logging.info("media_delete carpeta %s (%d archivos)", prefix, file_count)
            return ok({"deleted": file_count, "folderPath": folder})
        except Exception as exc:
            logging.error("media_delete carpeta: %s", exc)
            return err(str(exc), 500)

    # ── Archivos sueltos ──────────────────────────────────────────────────────
    if not isinstance(paths_raw, list) or not paths_raw:
        return err("Indica 'paths' (lista de archivos) o 'folderPath'", 400)
    if len(paths_raw) > _MAX_DELETE_BATCH:
        return err(f"Máximo {_MAX_DELETE_BATCH} archivos por operación", 400)

    targets: list = []
    for raw in paths_raw:
        path = unquote(str(raw or "")).strip().strip("/")
        # Toda ruta tiene que colgar de la sección pedida: corta el path traversal
        # y evita que un id de sección sea prefijo de otro (marcas / marcas-2020).
        if not path or ".." in path.split("/") or not path.startswith(f"{root}/"):
            return err(f"Ruta fuera de la sección: {raw}", 400)
        rel = path[len(root) + 1:]
        if "/" not in rel:
            return err("No se pueden borrar archivos sueltos en la raíz de la sección", 400)
        targets.append(path)

    # El scope por carpeta se evalúa contra la raíz de cada archivo.
    for path in targets:
        _, auth_err = require_perms(req, section=section,
                                    item=_root_of(path[len(root) + 1:]), cap="deleteMedia")
        if auth_err:
            return auth_err

    try:
        svc = get_blob_service()
        cc = svc.get_container_client(CONTAINER)
        deleted = _delete_blobs(cc, targets)
        logging.info("media_delete %d archivo(s) en %s", deleted, section)
        return ok({"deleted": deleted, "requested": len(targets)})
    except Exception as exc:
        logging.error("media_delete archivos: %s", exc)
        return err(str(exc), 500)


def _delete_blobs(cc, names: list) -> int:
    """Borra blobs uno a uno y arrastra su miniatura de _thumbs/ y, si es
    video, su copia liviana de _proxies/.
    Un 404 no es error: la meta es que el blob no exista al terminar.

    De más profundo a menos: en cuentas HNS un marcador de directorio no se puede
    borrar mientras tenga contenido, así que los hijos (más segmentos de ruta) van
    antes que la carpeta que los contiene."""
    deleted = 0
    for name in sorted(set(names), key=lambda n: n.count("/"), reverse=True):
        targets = [name, thumb_sidecar_name(name)]
        if name.lower().endswith(PROXYABLE_VIDEO_EXT):
            targets.append(proxy_sidecar_name(name))
        for target in targets:
            try:
                cc.delete_blob(target)
                if target == name:
                    deleted += 1
            except ResourceNotFoundError:
                pass
    return deleted


@app.route(route="media/{section}/plan", methods=["POST", "OPTIONS"])
def media_upload_plan(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()

    section = (req.route_params.get("section") or "").strip().lower()
    if section not in library_sections():
        return err("Sección de media desconocida", 400)

    try:
        body = req.get_json()
    except Exception:
        return err("Cuerpo JSON inválido", 400)

    folder_path = _sanitize_folder_path(body.get("folderPath", ""))
    if folder_path is None:
        return err("Ruta de carpeta inválida", 400)
    if not folder_path:
        return err("folderPath requerido: no se sube a la raíz de la sección", 400)

    _, auth_err = require_perms(req, section=section, item=_root_of(folder_path), cap="manageMedia")
    if auth_err:
        return auth_err

    files_in = body.get("files") or []
    if not isinstance(files_in, list) or not files_in:
        return err("files: lista de archivos requerida", 400)
    if len(files_in) > 500:
        return err("Máximo 500 archivos por tanda", 400)

    import mimetypes
    prefix = f"{_media_root(section)}/{folder_path}/"
    planned = []
    for f in files_in:
        if not isinstance(f, dict):
            continue
        name = os.path.basename(str(f.get("name") or "").strip())
        if not name or name.startswith("."):
            planned.append({"name": name or "(sin nombre)", "status": "omitido",
                            "reason": "Nombre inválido", "blobPath": None, "sasUrl": None})
            continue
        blob_path = f"{prefix}{name}"
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        planned.append({
            "name": name, "status": "nuevo", "blobPath": blob_path,
            "contentType": ctype,
            "sasUrl": make_sas_url_write(blob_path, expiry_minutes=360),
        })
    return ok({"section": section, "folderPath": folder_path,
               "total": len(planned), "files": planned})


def _sanitize_media_meta(raw: Any, section: str) -> dict:
    """Ficha opcional de una carpeta (meta.json). Descripción y colores en toda
    sección; el arquetipo solo en Marcas."""
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, Any] = {}
    name = str(raw.get("name") or "").strip()[:80]
    if name:
        out["name"] = name
    tagline = str(raw.get("tagline") or "").strip()[:160]
    if tagline:
        out["tagline"] = tagline
    desc = str(raw.get("description") or "").strip()[:2000]
    if desc:
        out["description"] = desc
    colors = raw.get("colors")
    if isinstance(colors, list):
        clean = []
        for c in colors[:16]:
            if not isinstance(c, dict):
                continue
            hexv = str(c.get("hex") or "").strip()[:9]
            if not hexv:
                continue
            clean.append({
                "hex": hexv,
                "name": str(c.get("name") or "").strip()[:40],
                "role": str(c.get("role") or "").strip()[:60],
            })
        if clean:
            out["colors"] = clean
    if section == "marcas":
        arch = raw.get("archetype")
        if isinstance(arch, dict):
            a = {}
            for k, limit in (("name", 80), ("summary", 200), ("description", 2000)):
                v = str(arch.get(k) or "").strip()[:limit]
                if v:
                    a[k] = v
            if a:
                out["archetype"] = a
    return out


# ══════════════════════════════════════════════════════════════════════════════
# POST /api/media/{section}/meta   body: { folderPath, meta }
# Guarda/actualiza la ficha (meta.json) de una carpeta: nombre, descripción,
# colores y —solo en Marcas— arquetipo.
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="media/{section}/meta", methods=["POST", "OPTIONS"])
def media_folder_meta(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    section = (req.route_params.get("section") or "").strip().lower()
    if section not in library_sections():
        return err("Sección de media desconocida", 400)

    try:
        body = req.get_json()
    except Exception:
        return err("Cuerpo JSON inválido", 400)

    folder_path = _sanitize_folder_path(body.get("folderPath", ""))
    if folder_path is None:
        return err("Ruta de carpeta inválida", 400)
    if not folder_path:
        return err("folderPath requerido", 400)

    _, auth_err = require_perms(req, section=section, item=_root_of(folder_path), cap="manageMedia")
    if auth_err:
        return auth_err

    meta = _sanitize_media_meta(body.get("meta"), section)
    try:
        svc = get_blob_service()
        blob_name = f"{_media_root(section)}/{folder_path}/meta.json"
        bc = svc.get_blob_client(container=CONTAINER, blob=blob_name)
        bc.upload_blob(json.dumps(meta, ensure_ascii=False).encode("utf-8"), overwrite=True,
                       content_type="application/json")
        return ok({"saved": True, "meta": meta})
    except Exception as exc:
        logging.error("media_folder_meta: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# ENLACES por sección (p. ej. Redes Sociales): lista de links, no carpetas.
# GET  /api/media/{section}/links  → { links: [...] }
# POST /api/media/{section}/links  (manageMedia) → guarda la lista
# ══════════════════════════════════════════════════════════════════════════════
def _links_blob_name(section: str) -> str:
    return f"{CONFIG_PREFIX.strip('/')}/{section}_links.json"

def _detect_network(url: str) -> str:
    u = (url or "").lower()
    if "instagram.com" in u: return "instagram"
    if "facebook.com" in u or "fb.com" in u or "fb.me" in u: return "facebook"
    if "linkedin.com" in u: return "linkedin"
    if "youtube.com" in u or "youtu.be" in u: return "youtube"
    if "tiktok.com" in u: return "tiktok"
    if "twitter.com" in u or "x.com" in u: return "x"
    if "wa.me" in u or "whatsapp.com" in u: return "whatsapp"
    if "t.me" in u or "telegram" in u: return "telegram"
    return "website"

def _sanitize_link(raw: Any) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    url = str(raw.get("url") or "").strip()
    if not (url.startswith("http://") or url.startswith("https://")) or len(url) > 2000:
        return None
    net = str(raw.get("network") or "").strip().lower()
    if net not in ("instagram", "facebook", "linkedin", "youtube", "tiktok", "x", "whatsapp", "telegram", "website"):
        net = _detect_network(url)
    out = {
        "id": (str(raw.get("id") or "").strip() or uuid.uuid4().hex[:10])[:32],
        "url": url,
        "title": str(raw.get("title") or "").strip()[:120],
        "network": net,
    }
    # Campos opcionales de "mini-perfil" (los escribe el usuario, no son en vivo).
    desc = str(raw.get("description") or "").strip()[:200]
    if desc:
        out["description"] = desc
    stat = str(raw.get("stat") or "").strip()[:60]
    if stat:
        out["stat"] = stat
    # Imagen propia opcional: data URL ya comprimida en el navegador (~<1MB).
    img = raw.get("image")
    if isinstance(img, str) and img.startswith("data:image/") and len(img) <= 3_000_000:
        out["image"] = img
    return out

@app.route(route="media/{section}/links", methods=["GET", "POST", "OPTIONS"])
def media_links(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    section = (req.route_params.get("section") or "").strip().lower()
    if section not in library_sections():
        return err("Sección de media desconocida", 400)

    if req.method == "POST":
        _, auth_err = require_perms(req, section=section, cap="manageMedia")
        if auth_err:
            return auth_err
        try:
            body = req.get_json()
        except Exception:
            return err("Cuerpo JSON inválido", 400)
        raw = body.get("links")
        if not isinstance(raw, list):
            return err("links debe ser una lista", 400)
        if len(raw) > 200:
            return err("Máximo 200 enlaces", 400)
        links = [x for x in (_sanitize_link(r) for r in raw) if x]
        try:
            save_json_blob(_links_blob_name(section), {"links": links})
            return ok({"saved": True, "links": links})
        except Exception as exc:
            logging.error("media_links save: %s", exc)
            return err(str(exc), 500)

    perms, auth_err = require_perms(req, section=section)
    if auth_err:
        return auth_err
    try:
        data = load_json_blob(_links_blob_name(section))
        links = data.get("links") if isinstance(data, dict) else None
        return ok({"section": section, "links": links if isinstance(links, list) else []})
    except Exception as exc:
        logging.error("media_links load: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# FAVORITOS por usuario (sección Proyectos): colecciones con nombre + compartir.
# Cada usuario tiene su propio archivo; solo él ve/gestiona sus favoritos.
# ══════════════════════════════════════════════════════════════════════════════
def _safe_user_key(email: str) -> str:
    e = (email or "anon").strip().lower()
    key = "".join(c if (c.isalnum() or c in "._-") else "_" for c in e)
    return key or "anon"

def _favorites_blob_name(email: str) -> str:
    return f"{CONFIG_PREFIX.strip('/')}/favorites/{_safe_user_key(email)}.json"

def _favorites_store():
    return Favorites(load_json_blob_etag, save_json_blob_etag, CONFIG_PREFIX, _favorites_blob_name)


def _fav_error(exc):
    status = 403 if isinstance(exc, PermissionError) else 404 if isinstance(exc, LookupError) else 400 if isinstance(exc, ValueError) else 409 if getattr(exc, "status_code", None) in (409, 412) else 500
    return err(str(exc), status)


def _load_favorites(email: str) -> dict:
    data = load_json_blob(_favorites_blob_name(email))
    cols = data.get("collections") if isinstance(data, dict) else None
    if cols:
        names = load_project_names()
        cols = [{**c, "items": [apply_project_reference_name(it, names) for it in c.get("items", [])]} for c in cols]
    return {"collections": cols if isinstance(cols, list) else []}

def _save_favorites(email: str, data: dict) -> None:
    save_json_blob(_favorites_blob_name(email), data)

def _fav_all_paths(fav: dict) -> list:
    seen, out = set(), []
    for c in fav.get("collections", []):
        for it in c.get("items", []):
            p = it.get("path") if isinstance(it, dict) else None
            if p and p not in seen:
                seen.add(p); out.append(p)
    return out

def _fav_caller_email(req) -> str:
    caller = get_caller(req)
    return ((caller or {}).get("email") or "anon").strip().lower() or "anon"

def _sanitize_fav_item(raw: Any) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    path = str(raw.get("path") or "").strip()
    if not path:
        return None
    return {
        "path": path,
        "name": str(raw.get("name") or path.split("/")[-1])[:200],
        "projectCode": favorite_origin(path)[0],
        "projectName": str(raw.get("projectName") or "")[:160],
        "week": favorite_origin(path)[1],
        "folder": favorite_origin(path)[1],
    }


@app.route(route="favorites", methods=["GET", "OPTIONS"])
def favorites_get(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    _, auth_err = require_perms(req, section="proyectos")
    if auth_err:
        return auth_err
    try:
        fav = _favorites_store().get(_fav_caller_email(req))
        names = load_project_names()
        for col in fav["collections"]:
            col["items"] = [apply_project_reference_name(it, names) for it in col.get("items", [])]
        return ok({"collections": fav["collections"], "paths": _fav_all_paths(fav)})
    except Exception as exc:
        logging.error("favorites_get: %s", exc)
        return _fav_error(exc)


@app.route(route="favorites/collection", methods=["POST", "OPTIONS"])
def favorites_collection_create(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    _, auth_err = require_perms(req, section="proyectos")
    if auth_err:
        return auth_err
    try:
        body = req.get_json()
        name = str(body.get("name") or "").strip()[:120]
        if not name:
            return err("El nombre de la colección es requerido")
        email = _fav_caller_email(req)
        col = {"id": uuid.uuid4().hex[:10], "name": name,
               "items": [], "createdAt": datetime.now(timezone.utc).isoformat()}
        _favorites_store().create(email, col)
        return ok({"collection": col})
    except Exception as exc:
        logging.error("favorites_collection_create: %s", exc)
        return _fav_error(exc)


@app.route(route="favorites/collection/{cid}", methods=["POST", "DELETE", "OPTIONS"])
def favorites_collection_edit(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    _, auth_err = require_perms(req, section="proyectos")
    if auth_err:
        return auth_err
    cid = req.route_params.get("cid", "")
    try:
        email = _fav_caller_email(req)
        store = _favorites_store()
        if req.method == "DELETE":
            store.mutate(email, cid, lambda c: c.update(deleted=True), owner=True, metadata=True)
            return ok({"deleted": True})
        name = str(req.get_json().get("name") or "").strip()[:120]
        if not name:
            return err("El nombre es requerido")
        col = store.mutate(email, cid, lambda c: c.update(name=name), owner=True, metadata=True)
        return ok({"collection": col})
    except Exception as exc:
        logging.error("favorites_collection_edit: %s", exc)
        return _fav_error(exc)


@app.route(route="favorites/item", methods=["POST", "OPTIONS"])
def favorites_item(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    try:
        body = req.get_json()
    except Exception:
        return err("Cuerpo JSON inválido", 400)
    action = str(body.get("action") or "add").strip()
    path = str(body.get("path") or "").strip()
    cid = str(body.get("collectionId") or "").strip()
    if not path:
        return err("path es requerido")

    _, auth_err = require_perms(req, section="proyectos")
    if auth_err:
        return auth_err
    if path.startswith((CONFIG_PREFIX.strip('/') + '/', MEDIA_PREFIX.strip('/') + '/')):
        return err("Solo hay favoritos en Obra", 403)

    # Solo puedes marcar/gestionar favoritos de archivos que tienes permiso de ver.
    _, auth_err = require_blob_access(req, path)
    if auth_err:
        return auth_err

    try:
        email = _fav_caller_email(req)
        if action not in ("add", "remove") or (action == "add" and not cid):
            return err("Acción o colección inválida")
        item = _sanitize_fav_item(body)
        return ok(_favorites_store().item(email, cid, item, remove=action == "remove"))
    except Exception as exc:
        logging.error("favorites_item: %s", exc)
        return _fav_error(exc)


@app.route(route="favorites/collection/{cid}/members", methods=["POST", "OPTIONS"])
def favorites_collection_members(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    _, auth_err = require_perms(req, section="proyectos")
    if auth_err:
        return auth_err
    try:
        return ok(_favorites_store().set_members(_fav_caller_email(req), req.route_params.get("cid", ""), req.get_json().get("members")))
    except Exception as exc:
        return _fav_error(exc)


@app.route(route="favorites/collection/{cid}/leave", methods=["POST", "OPTIONS"])
def favorites_collection_leave(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    _, auth_err = require_perms(req, section="proyectos")
    if auth_err:
        return auth_err
    try:
        return ok(_favorites_store().leave(_fav_caller_email(req), req.route_params.get("cid", "")))
    except Exception as exc:
        return _fav_error(exc)


@app.route(route="favorites/collection/{cid}/share", methods=["POST", "OPTIONS"])
def favorites_collection_share(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    _, auth_err = require_perms(req, section="proyectos", cap="share")
    if auth_err:
        return auth_err
    cid = req.route_params.get("cid", "")
    try:
        body = req.get_json() if req.get_body() else {}
    except Exception:
        body = {}
    try:
        email = _fav_caller_email(req)
        fav = _favorites_store().get(email)
        col = next((c for c in fav["collections"] if c.get("id") == cid), None)
        if not col:
            return err("Colección no encontrada", 404)
        if col.get("shared") and col.get("role") != "owner":
            return err("Solo el dueño puede generar el enlace público", 403)
        paths = [it.get("path") for it in col.get("items", []) if it.get("path")]
        if not paths:
            return err("La colección está vacía")

        expiry_days = min(int(body.get("expiryDays", 30) or 30), 90)
        token = uuid.uuid4().hex
        expires_at = datetime.now(timezone.utc) + timedelta(days=expiry_days)
        origin = req.headers.get("Origin", "")
        share_data = {
            "token": token, "type": "collection", "title": col.get("name", "Favoritos"),
            "files": paths[:2000], "expiresAt": expires_at.isoformat(), "active": True,
        }
        save_share(share_data)
        _favorites_store().mutate(email, cid, lambda c: c.update(shareToken=token), owner=True)
        return ok({"token": token, "shareUrl": f"{origin}/share/{token}", "expiresAt": expires_at.isoformat()})
    except Exception as exc:
        logging.error("favorites_collection_share: %s", exc)
        return _fav_error(exc)


# ══════════════════════════════════════════════════════════════════════════════
# POST /api/index/refresh (manual)
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="index/refresh", methods=["POST", "OPTIONS"])
def index_refresh(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    _, auth_err = require_perms(req, cap="refreshIndex")
    if auth_err:
        return auth_err

    try:
        stats = refresh_content_indexes()
        return ok({"ok": True, "stats": stats, "prefix": INDEX_PREFIX})
    except Exception as exc:
        logging.error("index_refresh: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# TIMER job: refresh indexes
# ══════════════════════════════════════════════════════════════════════════════
@app.timer_trigger(schedule=INDEX_REFRESH_CRON, arg_name="timer", run_on_startup=False, use_monitor=True)
def index_refresh_timer(timer: func.TimerRequest) -> None:
    if not INDEX_ENABLED:
        logging.info("index_refresh_timer: skipped (INDEX_ENABLED=false)")
        return
    try:
        stats = refresh_content_indexes()
        logging.info(
            "index_refresh_timer: ok projects=%s weeksIndexes=%s filesIndexes=%s",
            stats.get("projects"), stats.get("weeksIndexes"), stats.get("filesIndexes")
        )
    except Exception as exc:
        logging.error("index_refresh_timer: %s", exc)


# ══════════════════════════════════════════════════════════════════════════════
# POST /api/upload
# Body: { projectCode, projectName, urls: [...], prefijo?, maxWorkers?, refreshIndex? }
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="upload", methods=["POST", "OPTIONS"])
def upload(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    _, auth_err = require_perms(req, cap="upload")
    if auth_err:
        return auth_err

    try:
        body = req.get_json()
    except Exception:
        return err("Cuerpo JSON inválido", 400)

    project_code  = (body.get("projectCode") or "").strip()
    project_name  = (body.get("projectName") or "").strip()
    urls          = body.get("urls") or []
    prefijo       = body.get("prefijo")
    max_workers   = int(body.get("maxWorkers") or 4)
    refresh_index = bool(body.get("refreshIndex") or False)

    if not project_code or not project_name:
        return err("projectCode y projectName son requeridos", 400)
    if not isinstance(urls, list) or not urls:
        return err("urls: lista de URLs requerida", 400)

    try:
        job_id = _create_job(project_code, project_name, mode="urls")
        svc = get_blob_service()

        with _upload_jobs_lock:
            for i, u in enumerate(urls):
                name = uploader._guess_filename_from_url(u)
                _upload_jobs[job_id]["files"].append({
                    "index": i, "url": u, "name": name,
                    "phase": "queued",
                    "downloaded": 0, "downloadTotal": 0, "uploaded": 0, "error": None,
                })

        progress_cb = _progress_cb_for_job(job_id)

        def _run():
            try:
                _set_job_status(job_id, "running")
                res = uploader.upload_urls_with_progress(
                    svc, project_code, project_name, urls,
                    progress_cb, prefijo=prefijo, max_workers=max_workers,
                )
                _set_job_status(job_id, "finished", res)
                if refresh_index:
                    try:
                        refresh_content_indexes()
                    except Exception as e:
                        logging.error("background index refresh: %s", e)
            except Exception as exc:
                logging.error("upload job: %s", exc)
                _set_job_status(job_id, "error", {"error": str(exc)})

        import threading
        threading.Thread(target=_run, daemon=True).start()

        return ok({"ok": True, "jobId": job_id})
    except Exception as exc:
        logging.error("upload: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# POST /api/upload/check
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="upload/check", methods=["POST", "OPTIONS"])
def upload_check(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    _, auth_err = require_perms(req, cap="upload")
    if auth_err:
        return auth_err

    try:
        body = req.get_json()
    except Exception:
        return err("Cuerpo JSON inválido", 400)

    project_code = (body.get("projectCode") or "").strip()
    project_name = (body.get("projectName") or "").strip()
    urls = body.get("urls") or []

    if not project_code or not project_name:
        return err("projectCode y projectName son requeridos", 400)
    if not isinstance(urls, list) or not urls:
        return err("urls: lista de URLs requerida", 400)

    try:
        slug    = uploader._slugify_name(project_name)
        week    = uploader._week_iso_for_date()
        carpeta = f"{project_code}_{slug}"

        svc = get_blob_service()
        cc  = svc.get_container_client(CONTAINER)

        existing = set()
        existing_norm = {}
        prefix = f"{carpeta}/{week}/"
        for blob in cc.list_blobs(name_starts_with=prefix):
            fname = blob.name[len(prefix):]
            existing.add(fname)
            n = "".join(ch for ch in fname.lower() if ch.isalnum())
            if n:
                existing_norm[n] = fname

        results = []
        for url in urls:
            name = uploader._guess_filename_from_url(url)
            exists = name in existing
            similar = False
            similar_to = None
            if not exists:
                n = "".join(ch for ch in name.lower() if ch.isalnum())
                if n and n in existing_norm:
                    similar = True
                    similar_to = existing_norm[n]

            blob_path = (
                f"{carpeta}/{week}/{name}" if exists
                else (f"{carpeta}/{week}/{similar_to}" if similar else None)
            )
            results.append({
                "url": url, "name": name,
                "exists": exists, "similar": similar,
                "similarTo": similar_to, "blobPath": blob_path,
            })

        return ok({"ok": True, "week": week, "carpeta": carpeta, "results": results})
    except Exception as exc:
        logging.error("upload_check: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# GET /api/upload/status/{job_id}
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="upload/status/{job_id}", methods=["GET", "OPTIONS"])
def upload_status(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    _, auth_err = require_perms(req, cap="upload")
    if auth_err:
        return auth_err

    job_id = req.route_params.get("job_id")
    with _upload_jobs_lock:
        job = _upload_jobs.get(job_id)
        if not job:
            return err("jobId no encontrado", 404)
        result = {k: job[k] for k in job}
    return ok(apply_project_reference_name(result, load_project_names()))


# ══════════════════════════════════════════════════════════════════════════════
# POST /api/upload/sharepoint
# Body: { projectCode, projectName, sharepointUrl, prefijo?, maxWorkers?,
#         refreshIndex?, recursive? }
#
# Alternativa con site_id + folder_path explícitos:
# Body: { projectCode, projectName, siteId, folderPath, prefijo?, ... }
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="upload/sharepoint", methods=["POST", "OPTIONS"])
def upload_sharepoint(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    _, auth_err = require_perms(req, cap="upload")
    if auth_err:
        return auth_err

    try:
        body = req.get_json()
    except Exception:
        return err("Cuerpo JSON inválido", 400)

    project_code   = (body.get("projectCode") or "").strip()
    project_name   = (body.get("projectName") or "").strip()
    sp_url         = (body.get("sharepointUrl") or "").strip()
    site_id        = (body.get("siteId") or "").strip()
    folder_path    = (body.get("folderPath") or "/").strip()
    prefijo        = (body.get("prefijo") or "FOT").strip()
    max_workers    = int(body.get("maxWorkers") or 4)
    refresh_index  = bool(body.get("refreshIndex") or False)
    recursive      = bool(body.get("recursive") if body.get("recursive") is not None else True)

    if not project_code or not project_name:
        return err("projectCode y projectName son requeridos", 400)
    if not sp_url and not site_id:
        return err("Proporciona sharepointUrl o siteId + folderPath", 400)

    try:
        job_id = _create_job(project_code, project_name, mode="sharepoint")

        def _run():
            try:
                _set_job_status(job_id, "running")

                # Resolver URL si no viene siteId explícito
                resolved_site_id = site_id
                resolved_folder  = folder_path

                if sp_url and not site_id:
                    config = uploader.resolver_sharepoint_desde_url(sp_url)
                    resolved_site_id = config.get("site_id") or ""
                    resolved_folder  = config.get("folder_path") or "/"
                    with _upload_jobs_lock:
                        job = _upload_jobs.get(job_id)
                        if job:
                            job["resolvedSiteId"]   = resolved_site_id
                            job["resolvedFolderPath"] = resolved_folder

                if not resolved_site_id:
                    _set_job_status(job_id, "error", {"error": "No se pudo obtener site_id de SharePoint"})
                    return

                # Listar archivos Graph
                token   = uploader._get_graph_token()
                archivos = uploader.list_sharepoint_files(token, resolved_site_id, resolved_folder, recursive)

                with _upload_jobs_lock:
                    job = _upload_jobs.get(job_id)
                    if job:
                        job["totalFiles"] = len(archivos)

                svc    = get_blob_service()
                slug   = uploader._slugify_name(project_name)
                resumen = uploader.procesar_archivos(
                    archivos, svc, project_code, slug,
                    prefijo_jpg=prefijo, max_workers=max_workers,
                )

                _set_job_status(job_id, "finished", resumen)

                if refresh_index:
                    try:
                        refresh_content_indexes()
                    except Exception as e:
                        logging.error("background index refresh (sp): %s", e)

            except Exception as exc:
                logging.error("upload_sharepoint job: %s", exc)
                _set_job_status(job_id, "error", {"error": str(exc)})

        import threading
        threading.Thread(target=_run, daemon=True).start()

        return ok({"ok": True, "jobId": job_id})

    except Exception as exc:
        logging.error("upload_sharepoint: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# POST /api/upload/onedrive
# Body: { projectCode, projectName, userEmail, folderPath, prefijo?,
#         maxWorkers?, refreshIndex?, recursive? }
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="upload/onedrive", methods=["POST", "OPTIONS"])
def upload_onedrive(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    _, auth_err = require_perms(req, cap="upload")
    if auth_err:
        return auth_err

    try:
        body = req.get_json()
    except Exception:
        return err("Cuerpo JSON inválido", 400)

    project_code  = (body.get("projectCode") or "").strip()
    project_name  = (body.get("projectName") or "").strip()
    user_email    = (body.get("userEmail") or "").strip()
    folder_path   = (body.get("folderPath") or "/").strip()
    prefijo       = (body.get("prefijo") or "FOT").strip()
    max_workers   = int(body.get("maxWorkers") or 4)
    refresh_index = bool(body.get("refreshIndex") or False)
    recursive     = bool(body.get("recursive") if body.get("recursive") is not None else True)

    if not project_code or not project_name:
        return err("projectCode y projectName son requeridos", 400)
    if not user_email:
        return err("userEmail es requerido", 400)

    try:
        job_id = _create_job(project_code, project_name, mode="onedrive")

        def _run():
            try:
                _set_job_status(job_id, "running")

                token    = uploader._get_graph_token()
                archivos = uploader.list_onedrive_files(token, user_email, folder_path, recursive)

                with _upload_jobs_lock:
                    job = _upload_jobs.get(job_id)
                    if job:
                        job["totalFiles"] = len(archivos)

                svc  = get_blob_service()
                slug = uploader._slugify_name(project_name)
                resumen = uploader.procesar_archivos(
                    archivos, svc, project_code, slug,
                    prefijo_jpg=prefijo, max_workers=max_workers,
                )

                _set_job_status(job_id, "finished", resumen)

                if refresh_index:
                    try:
                        refresh_content_indexes()
                    except Exception as e:
                        logging.error("background index refresh (od): %s", e)

            except Exception as exc:
                logging.error("upload_onedrive job: %s", exc)
                _set_job_status(job_id, "error", {"error": str(exc)})

        import threading
        threading.Thread(target=_run, daemon=True).start()

        return ok({"ok": True, "jobId": job_id})

    except Exception as exc:
        logging.error("upload_onedrive: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# POST /api/upload/local/plan — planifica subida directa desde el navegador
#
# El navegador manda la lista de archivos elegidos (con sus rutas relativas si
# se eligió una carpeta) y el servidor devuelve, por archivo: la ruta destino
# (con renombrado PREFIJO_FECHA_SEQ o nombres originales), si ya existe, y un
# SAS de escritura. Los bytes NUNCA pasan por la Function: van directo del
# navegador al blob, así los archivos de varias GB no dependen del timeout.
#
# Body: { projectCode, projectName, prefijo?, keepNames?, files: [
#          {name, size, lastModified(ms), relativePath?} ] }
# ══════════════════════════════════════════════════════════════════════════════
_LOCAL_PLAN_MAX_FILES = 3000

def _sanitize_rel_segment(seg: str) -> str:
    seg = "".join(c for c in seg.strip() if c not in '\\#?%*:|"<>').strip(". ")
    return seg

@app.route(route="upload/local/plan", methods=["POST", "OPTIONS"])
def upload_local_plan(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    _, auth_err = require_perms(req, cap="upload")
    if auth_err:
        return auth_err

    try:
        body = req.get_json()
    except Exception:
        return err("Cuerpo JSON inválido", 400)

    project_code = (body.get("projectCode") or "").strip()
    project_name = (body.get("projectName") or "").strip()
    prefijo      = (body.get("prefijo") or "FOT").strip().upper()
    # Obra siempre organiza por semana; keepNames se ignora.
    files_in     = body.get("files") or []
    # Subcarpeta opcional dentro del proyecto (p. ej. "rio-guayllabamba"): las
    # rutas quedan proyecto/subcarpeta/semana/archivo.
    subfolder    = _sanitize_folder_path(body.get("subfolder", ""))

    if not project_code or not project_name:
        return err("projectCode y projectName son requeridos", 400)
    if subfolder is None:
        return err("Subcarpeta inválida", 400)
    if not isinstance(files_in, list) or not files_in:
        return err("files: lista de archivos requerida", 400)
    if len(files_in) > _LOCAL_PLAN_MAX_FILES:
        return err(f"Máximo {_LOCAL_PLAN_MAX_FILES} archivos por tanda", 400)

    try:
        carpeta = uploader._resolve_carpeta(project_code, project_name)
        base = f"{carpeta}/{subfolder}" if subfolder else carpeta
        svc = get_blob_service()
        indice = uploader.construir_indice_origen(svc, prefix=f"{base}/")
        def fecha_local(entry):
            texto = " | ".join(filter(None, [str(entry.get("relativePath") or ""), str(entry.get("name") or "")]))
            fecha = uploader.extraer_fecha_desde_texto(texto) or uploader.extraer_semana_desde_texto(texto)
            if fecha:
                return fecha
            try:
                modified = float(entry.get("lastModified") or 0) / 1000
                if modified > 0:
                    return datetime.fromtimestamp(modified, tz=timezone.utc)
            except (ValueError, TypeError, OverflowError, OSError):
                pass
            return datetime.now(timezone.utc)

        entries = [{"idx": i, "name": os.path.basename(str(f.get("name") or "").strip()),
                    "size": int(f.get("size") or 0), "relativePath": str(f.get("relativePath") or "").strip(),
                    "fecha": fecha_local(f)}
                   for i, f in enumerate(files_in) if isinstance(f, dict)]
        entries.sort(key=lambda e: (e["fecha"], e["relativePath"], e["name"]))
        planned = uploader.planificar_obra(entries, base, prefijo, indice)
        for entry in planned:
            entry.pop("fecha", None)
            entry["contentType"] = uploader.content_type_para(entry["finalName"])
            entry["sasUrl"] = (make_sas_url_write(entry["blobPath"], expiry_minutes=360)
                               if entry["status"] == "nuevo" else None)

        nuevos = sum(1 for p in planned if p["status"] == "nuevo")
        return ok({
            "carpeta": carpeta,
            "keepNames": False,
            "total": len(planned),
            "nuevos": nuevos,
            "existentes": sum(1 for p in planned if p["status"] == "existe"),
            "omitidos": sum(1 for p in planned if p["status"] == "omitido"),
            "files": planned,
        })
    except Exception as exc:
        logging.error("upload_local_plan: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# POST /api/upload/resolve-sharepoint
# Resuelve una URL de SharePoint a site_id + folder_path sin iniciar la subida
# Body: { url }
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="upload/resolve-sharepoint", methods=["POST", "OPTIONS"])
def upload_resolve_sharepoint(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    _, auth_err = require_perms(req, cap="upload")
    if auth_err:
        return auth_err

    try:
        body = req.get_json()
    except Exception:
        return err("Cuerpo JSON inválido", 400)

    url = (body.get("url") or "").strip()
    if not url:
        return err("url es requerido", 400)

    try:
        config = uploader.resolver_sharepoint_desde_url(url)
        return ok(config)
    except Exception as exc:
        logging.error("upload_resolve_sharepoint: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# MIGRACIÓN REMOTA POR LOTES — SharePoint / OneDrive con conteo y progreso
#
# El listado (metadata, recursivo con paginación) es rápido y da el TOTAL de
# archivos. La transferencia real (descargar de Graph + subir a blob) se hace
# en tandas que el navegador dispara una a una, con un presupuesto de tiempo
# por llamada, para no chocar con el timeout de la Function en carpetas enormes.
#
# POST /api/upload/remote/plan  → { carpeta, total, nuevos, existentes, files:[...] }
# POST /api/upload/remote/batch → procesa una tanda; { processed, results, done }
#
# Presupuesto por tanda: DEBE ser menor que el timeout del gateway HTTP de
# Azure (Functions/SWA cortan el request a ~230s pase lo que pase). Con 420s la
# tanda se pasaba y Azure mataba la conexion -> 500. 150s deja margen de sobra;
# la tanda devuelve lo procesado y el frontend continua con lo que falta.
_REMOTE_BATCH_BUDGET_S = int(os.environ.get("REMOTE_BATCH_BUDGET_S", "150"))

@app.route(route="upload/remote/plan", methods=["POST", "OPTIONS"])
def upload_remote_plan(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    _, auth_err = require_perms(req, cap="upload")
    if auth_err:
        return auth_err

    try:
        body = req.get_json()
    except Exception:
        return err("Cuerpo JSON inválido", 400)

    source        = (body.get("source") or "sharepoint").strip().lower()
    project_code  = (body.get("projectCode") or "").strip()
    project_name  = (body.get("projectName") or "").strip()
    prefijo       = (body.get("prefijo") or "FOT").strip().upper()
    recursive     = bool(body.get("recursive") if body.get("recursive") is not None else True)
    subfolder     = _sanitize_folder_path(body.get("subfolder", ""))

    if not project_code or not project_name:
        return err("projectCode y projectName son requeridos", 400)
    if subfolder is None:
        return err("Subcarpeta inválida", 400)

    try:
        token = uploader._get_graph_token()
        if source == "onedrive":
            user_email = (body.get("userEmail") or "").strip()
            folder     = (body.get("folderPath") or "/").strip()
            if not user_email:
                return err("userEmail es requerido para OneDrive", 400)
            archivos = uploader.list_onedrive_files(token, user_email, folder, recursive)
        else:
            sp_url   = (body.get("sharepointUrl") or "").strip()
            site_id  = (body.get("siteId") or "").strip()
            folder   = (body.get("folderPath") or "/").strip()
            if sp_url and not site_id:
                cfg = uploader.resolver_sharepoint_desde_url(sp_url)
                site_id = cfg.get("site_id") or ""
                folder  = cfg.get("folder_path") or "/"
            if not site_id:
                return err("No se pudo resolver el sitio de SharePoint", 400)
            archivos = uploader.list_sharepoint_files(token, site_id, folder, recursive)

        carpeta = uploader._resolve_carpeta(project_code, project_name)
        base = f"{carpeta}/{subfolder}" if subfolder else carpeta
        indice = uploader.construir_indice_origen(get_blob_service(), prefix=f"{base}/")
        trabajos = uploader._preparar_trabajos(archivos, base, prefijo, indice)

        files = []
        nuevos = existentes = total_bytes = 0
        for t in trabajos:
            exists = t["status"] == "existe"
            if exists:
                existentes += 1
            elif t["status"] == "nuevo":
                nuevos += 1
                total_bytes += int(t.get("size_bytes") or 0)
            files.append({
                "orig": t["nombre_orig"], "name": t["nombre_nuevo"],
                "blobPath": t["blob_path"], "dlUrl": t["dl_url"],
                "driveId": t.get("drive_id"), "itemId": t.get("item_id"),
                "size": int(t.get("size_bytes") or 0),
                "status": t["status"], "metadata": t["metadata"], "reason": t.get("reason"),
            })

        return ok({
            "source": source, "carpeta": carpeta,
            "omitidos": sum(f["status"] == "omitido" for f in files),
            "total": len(files), "nuevos": nuevos, "existentes": existentes,
            "totalBytesNuevos": total_bytes, "files": files,
        })
    except Exception as exc:
        logging.error("upload_remote_plan: %s", exc)
        return err(str(exc), 500)


def _remote_copy_one(svc, token: str, drive_id: str, item_id: str, blob_path: str,
                     dl_url: Optional[str] = None, refresh: bool = False, metadata: Optional[dict] = None):
    """Lanza la COPIA servidor-a-servidor: ordena a Azure jalar los bytes directo
    desde SharePoint. Reusa la URL que ya trajo el Analizar (dl_url) para NO
    llamar a Graph por archivo (evita ráfagas → throttling). Solo pide una fresca
    si no hay o si es un reintento (la anterior pudo caducar). Devuelve al instante."""
    try:
        url = None if refresh else dl_url
        if not url:
            url = uploader.graph_item_download_url(token, drive_id, item_id)
        if not url:
            return "error", "No se pudo obtener la URL de descarga"
        bc = svc.get_blob_client(container=CONTAINER, blob=blob_path)
        if metadata:
            from azure.core import MatchConditions
            from azure.core.exceptions import HttpResponseError
            try:
                bc.start_copy_from_url(url, metadata=metadata, match_condition=MatchConditions.IfMissing)
            except HttpResponseError as exc:
                if exc.status_code not in (409, 412):
                    raise
                props = bc.get_blob_properties()
                if props.metadata != metadata:
                    return "error", "Destino ocupado por otro origen; vuelve a analizar los archivos"
                estado = props.copy.status if props.copy else None
                if estado in ("failed", "aborted"):
                    bc.start_copy_from_url(url, metadata=metadata, etag=props.etag, match_condition=MatchConditions.IfNotModified)
                else:
                    return ("copiando" if estado == "pending" else "existe"), None
        else:
            bc.start_copy_from_url(url)
        return "copiando", None
    except Exception as exc:
        return "error", str(exc)


def _copy_status_counts(prefix: str, expected: set):
    """Cuenta cuántos de los blobPaths esperados ya se copiaron, están en curso o
    fallaron (un listado por carpeta padre), y devuelve `notDone`: los que aún
    falta reintentar (no aparecen, o copia fallida). Los 'pending' NO van en
    notDone (Azure los está copiando)."""
    svc = get_blob_service()
    cc = svc.get_container_client(CONTAINER)
    present = {}
    errors = []
    folders = {p.rsplit("/", 1)[0] + "/" for p in expected if p.startswith(prefix)}
    blobs = (b for folder in sorted(folders) for b in cc.list_blobs(name_starts_with=folder, include=["copy", "metadata"]))
    for b in blobs:
        if b.name not in expected or _is_dir_marker(b):
            continue
        try:
            present[b.name] = b.copy.status if b.copy else None
            if present[b.name] in ("failed", "aborted"):
                errors.append({"blobPath": b.name, "error": getattr(b.copy, "status_description", None) or "La copia falló"})
        except Exception:
            present[b.name] = None
    done = pending = failed = 0
    not_done = []
    for p in expected:
        if p not in present:
            not_done.append(p)                     # aún no aparece (erró al lanzar / no lanzado)
        else:
            status = present[p]
            if status == "pending":
                pending += 1
            elif status in ("failed", "aborted"):
                failed += 1
                not_done.append(p)
            else:                                  # 'success' o sin info = ya está
                done += 1
    return {"total": len(expected), "done": done, "pending": pending,
            "failed": failed, "missing": len(not_done) - failed,
            "notDone": not_done, "pendingPaths": [p for p, s in present.items() if s == "pending"], "errors": errors}


def _remote_transfer_one(svc, token: str, dl_url: str, blob_path: str, name: str, metadata: Optional[dict] = None):
    """Descarga de Graph a tempfile y sube al blob. Devuelve (status, error)."""
    tmp_path = None
    try:
        suffix = os.path.splitext(name)[1] or ".bin"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = tmp.name
        try:
            uploader._graph_download_to_path(token, dl_url, tmp_path, chunk_size=uploader.GRAPH_DOWNLOAD_CHUNK)
        except requests.exceptions.HTTPError as e:
            if "401" in str(e) and dl_url.startswith(uploader.GRAPH_BASE):
                token2 = uploader._get_graph_token(force_refresh=True)
                uploader._graph_download_to_path(token2, dl_url, tmp_path, chunk_size=uploader.GRAPH_DOWNLOAD_CHUNK)
            else:
                raise
        try:
            uploader._subir_a_blob_desde_path(
                svc, tmp_path, blob_path,
                content_type=uploader.content_type_para(name),
                metadata=metadata or uploader.metadata_origen(name, os.path.getsize(tmp_path)),
            )
        except ResourceExistsError:
            return "error", "Destino ocupado durante la subida; vuelve a analizar los archivos"
        return "ok", None
    except Exception as exc:
        return "error", str(exc)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


@app.route(route="upload/remote/batch", methods=["POST", "OPTIONS"])
def upload_remote_batch(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    _, auth_err = require_perms(req, cap="upload")
    if auth_err:
        return auth_err

    try:
        body = req.get_json()
    except Exception:
        return err("Cuerpo JSON inválido", 400)

    project_code = (body.get("projectCode") or "").strip()
    project_name = (body.get("projectName") or "").strip()
    items        = body.get("items") or []
    budget       = min(int(body.get("budgetSeconds") or _REMOTE_BATCH_BUDGET_S), _REMOTE_BATCH_BUDGET_S)

    if not project_code or not project_name:
        return err("projectCode y projectName son requeridos", 400)
    if not isinstance(items, list) or not items:
        return err("items: lista requerida", 400)
    if len(items) > 1000:
        return err("Máximo 1000 ítems por tanda", 400)

    # Los blobPath deben quedar dentro de la carpeta del proyecto (evita que el
    # cliente escriba rutas arbitrarias).
    carpeta = uploader._resolve_carpeta(project_code, project_name)
    prefix_ok = f"{carpeta}/"

    try:
        svc = get_blob_service()
        token = uploader._get_graph_token()
        results, processed = _issue_copies(svc, token, items, prefix_ok, budget, refresh=bool(body.get('refresh')), require_origin=True)
        clear_index_related_cache()
        return ok({
            "processed": processed, "total": len(items),
            "done": processed >= len(items), "results": results,
        })
    except Exception as exc:
        logging.error("upload_remote_batch: %s", exc)
        return err(str(exc), 500)


_REMOTE_BLOCK_BYTES = 100 * 1024 * 1024


def _remote_block_copy(bc, token, item, budget=120):
    """Reanuda bloques sin descargar bytes a la Function; publica solo al final."""
    from azure.storage.blob import ContentSettings, StandardBlobTier
    from azure.core.exceptions import HttpResponseError
    started = time.monotonic()
    size, metadata = item["size"], item["metadata"]
    ids = [base64.b64encode(f"{i:06d}".encode()).decode() for i in range((size + _REMOTE_BLOCK_BYTES - 1) // _REMOTE_BLOCK_BYTES)]
    lengths = [min(_REMOTE_BLOCK_BYTES, size - i * _REMOTE_BLOCK_BYTES) for i in range(len(ids))]
    def committed():
        try:
            props = bc.get_blob_properties(retry_total=0, connection_timeout=5, read_timeout=10)
        except ResourceNotFoundError:
            return False
        if props.metadata != metadata or props.size != size or (props.copy and props.copy.status not in (None, "success")):
            raise ValueError("Destino ocupado por otro origen o copia incompleta; vuelve a analizar")
        return True
    if committed():
        return {"done": True, "stagedBytes": size, "totalBytes": size, "status": "existe"}
    staged = set()
    result = {"done": False, "stagedBytes": 0, "totalBytes": size}
    try:
        try:
            _, blocks = bc.get_block_list("uncommitted", retry_total=0, connection_timeout=5, read_timeout=10)
        except ResourceNotFoundError:
            blocks = []
        expected = dict(zip(ids, lengths))
        staged = {b.id for b in blocks if b.id in expected and b.size == expected[b.id]}
        result["stagedBytes"] = sum(n for bid, n in zip(ids, lengths) if bid in staged)
        url = uploader.graph_item_download_url(token, item["driveId"], item["itemId"])
        if not url:
            raise RuntimeError("No se pudo obtener la URL de descarga")
        for i, bid in enumerate(ids):
            if bid in staged:
                continue
            # Un bloque de 100 MiB puede tardar ~1 min si SharePoint entrega lento:
            # no se empieza uno que no alcance a terminar dentro del presupuesto.
            left = budget - (time.monotonic() - started)
            if left < 40 and result["stagedBytes"] > 0:
                return result
            bc.stage_block_from_url(bid, url, source_offset=i * _REMOTE_BLOCK_BYTES, source_length=lengths[i],
                                    timeout=90, retry_total=0, connection_timeout=5, read_timeout=95)
            result["stagedBytes"] += lengths[i]
        if time.monotonic() - started >= budget - 2:
            return result
        try:
            bc.commit_block_list(ids, metadata=metadata,
                                 content_settings=ContentSettings(content_type=uploader.content_type_para(unquote(metadata["srcname"]))),
                                 standard_blob_tier=StandardBlobTier.COOL, match_condition=MatchConditions.IfMissing,
                                 retry_total=0, connection_timeout=5, read_timeout=15, timeout=15)
        except HttpResponseError as exc:
            if exc.status_code not in (409, 412) or not committed():
                raise
        result.update(done=True, status="ok")
    except ValueError:
        raise
    except Exception as exc:
        result["error"] = str(exc)
    return result


@app.route(route="upload/remote/block-copy", methods=["POST", "OPTIONS"])
def upload_remote_block_copy(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    _, auth_err = require_perms(req, cap="upload")
    if auth_err:
        return auth_err
    try:
        body = req.get_json()
        code, name = body.get("projectCode"), body.get("projectName")
        subfolder = _sanitize_folder_path(body.get("subfolder", ""))
        if not all(isinstance(v, str) and v.strip() and "/" not in v and "\\" not in v and v.strip() not in (".", "..") for v in (code, name)) or subfolder is None:
            raise ValueError("Proyecto o subcarpeta inválidos")
        item = dict(body["item"])
        size = item.get("size")
        if isinstance(size, bool) or not isinstance(size, int) or size < 1024 ** 3 or size > _REMOTE_BLOCK_BYTES * 50000:
            raise ValueError("Tamaño de video inválido")
        metadata = item["metadata"]
        if not isinstance(metadata["srcname"], str) or not metadata["srcname"] or not isinstance(metadata["srcsize"], str) or metadata["srcsize"] != str(size):
            raise ValueError("Metadata de origen inválida")
        item["metadata"] = uploader.metadata_origen(unquote(metadata["srcname"]), size)
        if not item["metadata"]["srcname"]:
            raise ValueError("Nombre de origen inválido")
        folder = uploader._resolve_carpeta(code.strip(), name.strip())
        prefix = f"{folder}/{subfolder}/" if subfolder else f"{folder}/"
        path = item.get("blobPath")
        if not isinstance(path, str) or not path.startswith(prefix) or _sanitize_folder_path(path) != path or not all(isinstance(item.get(k), str) and item[k] for k in ("driveId", "itemId")):
            raise ValueError("Ruta u origen no válidos")
    except (ValueError, KeyError, TypeError, AttributeError):
        return err("Proyecto, archivo o metadata de origen inválidos; vuelve a analizar", 400)
    try:
        bc = get_blob_service().get_blob_client(container=CONTAINER, blob=path)
        result = _remote_block_copy(bc, uploader._get_graph_token(), item)
        if result["done"]:
            clear_index_related_cache()
        return ok(result)
    except ValueError as exc:
        return err(str(exc), 409)
    except Exception as exc:
        logging.exception("upload_remote_block_copy")
        return err(str(exc), 500)


def _issue_copies(svc, token, items, prefix_ok, budget, refresh=False, require_origin=False):
    """Lanza las copias de una tanda (rápido: solo emite órdenes). Devuelve
    (results, processed). El estado real se consulta luego con copy-status.
    `refresh`: pide URL fresca a Graph (para reintentos, si la anterior caducó)."""
    results = []
    processed = 0
    started = time.monotonic()
    for it in items:
        if time.monotonic() - started > budget:
            break
        blob_path = str((it or {}).get("blobPath") or "")
        drive_id  = str((it or {}).get("driveId") or "")
        item_id   = str((it or {}).get("itemId") or "")
        dl_url    = (it or {}).get("dlUrl")
        metadata = (it or {}).get("metadata")
        if require_origin:
            try:
                metadata = uploader.metadata_origen(unquote(metadata["srcname"]), int(metadata["srcsize"]))
                if not metadata["srcname"] or int(metadata["srcsize"]) < 0:
                    raise ValueError("Origen inválido")
            except (KeyError, TypeError, ValueError):
                results.append({"blobPath": blob_path, "status": "error", "error": "Falta metadata de origen válida; vuelve a analizar"})
                processed += 1
                continue
        if not blob_path.startswith(prefix_ok) or not drive_id or not item_id:
            results.append({"blobPath": blob_path, "status": "error", "error": "Ruta u origen no válidos"})
            processed += 1
            continue
        status, error = _remote_copy_one(svc, token, drive_id, item_id, blob_path, dl_url=dl_url, refresh=refresh, metadata=metadata)
        results.append({"blobPath": blob_path, "status": status, "error": error})
        processed += 1
    return results, processed


@app.route(route="upload/remote/copy-status", methods=["POST", "OPTIONS"])
def upload_remote_copy_status(req: func.HttpRequest) -> func.HttpResponse:
    """Estado de las copias en curso. Body de proyecto: {projectCode, projectName,
    subfolder?, blobPaths} · Body de media: {section, destPath, blobPaths}."""
    if req.method == "OPTIONS":
        return options_ok()
    try:
        body = req.get_json()
    except Exception:
        return err("Cuerpo JSON inválido", 400)

    blob_paths = body.get("blobPaths") or []
    if not isinstance(blob_paths, list) or not blob_paths:
        return err("blobPaths requerido", 400)

    section = (body.get("section") or "").strip().lower()
    if section:
        if section not in library_sections():
            return err("Sección de media desconocida", 400)
        dest = _sanitize_folder_path(body.get("destPath", ""))
        if not dest:
            return err("destPath requerido", 400)
        _, auth_err = require_perms(req, section=section, item=_root_of(dest), cap="manageMedia")
        if auth_err:
            return auth_err
        prefix = f"{_media_root(section)}/{dest}/"
    else:
        project_code = (body.get("projectCode") or "").strip()
        project_name = (body.get("projectName") or "").strip()
        if not project_code or not project_name:
            return err("projectCode y projectName son requeridos", 400)
        _, auth_err = require_perms(req, cap="upload")
        if auth_err:
            return auth_err
        subfolder = _sanitize_folder_path(body.get("subfolder", "")) or ""
        carpeta = uploader._resolve_carpeta(project_code, project_name)
        base = f"{carpeta}/{subfolder}" if subfolder else carpeta
        prefix = f"{base}/"

    try:
        expected = {str(p) for p in blob_paths if str(p).startswith(prefix)}
        return ok(_copy_status_counts(prefix, expected))
    except Exception as exc:
        logging.error("upload_remote_copy_status: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# ANÁLISIS REANUDABLE (carpetas enormes sin chocar con el timeout/throttling)
# POST /api/upload/remote/list     → lista una tanda; { files, cursor, done }
# POST /api/upload/remote/prepare  → arma el plan (blobPath + nuevo/existe) sin Graph
# ══════════════════════════════════════════════════════════════════════════════
@app.route(route="upload/remote/list", methods=["POST", "OPTIONS"])
def upload_remote_list(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    caller = get_caller(req)
    perms = effective_perms(caller)
    if not perms["allowed"]:
        return err("No autorizado", 401 if caller is None else 403)
    if not (perms.get("caps", {}).get("upload") or perms.get("caps", {}).get("manageMedia")):
        return err("Sin permiso para subir", 403)
    try:
        body = req.get_json()
    except Exception:
        return err("Cuerpo JSON inválido", 400)

    budget = min(int(body.get("budgetSeconds") or 120), 180)
    try:
        token = uploader._get_graph_token()
        cursor = body.get("cursor") or {}
        pending = cursor.get("pending")
        if not (isinstance(pending, list) and pending):
            # Primera llamada: resolver el origen y sembrar la raíz.
            _, base_drive, src_folder = _remote_media_source(body, token)
            pending = [[uploader.children_url(base_drive, src_folder), ""]]
        files, remaining = uploader.list_drive_tree_budgeted(token, pending, budget, recursive=False if body.get("firstLevel") else body.get("recursive", True), include_folders=bool(body.get("firstLevel")))
        return ok({
            "files": files, "found": len(files),
            "cursor": {"pending": remaining}, "done": len(remaining) == 0,
        })
    except ValueError as ve:
        return err(str(ve), 400)
    except Exception as exc:
        logging.error("upload_remote_list: %s", exc)
        return err(str(exc), 500)


def _prepare_remote_project_jobs(items, base, prefijo, indice):
    """Reserva el nombre de videos grandes aunque otros archivos terminen antes.

    La reserva vive en configuración: el video sin commit sigue siendo nuevo.
    """
    from copy import deepcopy
    key = f"{CONFIG_PREFIX.rstrip('/')}/remote-block-copies/{quote(base, safe='')}.json"
    jobs = []
    def plan(current):
        reservations = deepcopy(current or [])
        index = deepcopy(indice)
        index["reservas"] = {}
        for row in reservations:
            path, meta = row["blobPath"], row["metadata"]
            origin = uploader.clave_origen(unquote(meta["srcname"]), int(meta["srcsize"]))
            if path in index["rutas"] or origin in index["origenes"]:
                continue
            index["reservas"][origin] = path
            index["rutas"][path] = int(meta["srcsize"])
            index["con_origen"].add(path)
            match = re.match(r"^([A-Z0-9]+_\d{8})_(\d{3,})\.", path.rsplit("/", 1)[-1])
            if match:
                index["maximos"][match[1]] = max(index["maximos"].get(match[1], 0), int(match[2]))
        jobs[:] = uploader._preparar_trabajos(items, base, prefijo, index)
        occupied = {row["blobPath"] for row in reservations}
        for job in jobs:
            if job["status"] == "nuevo" and job.get("size_bytes", 0) >= 1024 ** 3 and job["blob_path"] not in occupied:
                reservations.append({"blobPath": job["blob_path"], "metadata": job["metadata"]})
                occupied.add(job["blob_path"])
        return reservations
    if any(item.get("size", 0) >= 1024 ** 3 for item in items):
        update_json_blob(key, plan)
    else:
        plan(load_json_blob(key))
    return jobs


@app.route(route="upload/remote/prepare", methods=["POST", "OPTIONS"])
def upload_remote_prepare(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    try:
        body = req.get_json()
    except Exception:
        return err("Cuerpo JSON inválido", 400)

    files_in = body.get("files") or []
    if not isinstance(files_in, list):
        return err("files requerido", 400)
    if len(files_in) > 20000:
        return err('Demasiados archivos (máx 20000 por análisis). Activa «Dividir por subcarpetas»; si ya está activo, divide esta subcarpeta en el origen.', 400)
    destination = (body.get("destination") or "project").strip().lower()

    try:
        if destination == "media":
            section = (body.get("section") or "").strip().lower()
            if section not in library_sections():
                return err("Sección de media desconocida", 400)
            dest = _sanitize_folder_path(body.get("destPath", ""))
            if not dest:
                return err("destPath requerido", 400)
            _, auth_err = require_perms(req, section=section, item=_root_of(dest), cap="manageMedia")
            if auth_err:
                return auth_err
            base_prefix = f"{_media_root(section)}/{dest}"
            blob_index = uploader.construir_blob_index(get_blob_service(), prefix=f"{base_prefix}/")
            files = []
            nuevos = existentes = total_bytes = 0
            for f in files_in:
                name = os.path.basename(str(f.get("name") or "").strip())
                if not name or name.startswith("."):
                    continue
                rel = _sanitize_folder_path(f.get("relDir", "")) or ""
                blob_path = f"{base_prefix}/{rel}/{name}" if rel else f"{base_prefix}/{name}"
                exists = blob_path in blob_index
                if exists:
                    existentes += 1
                else:
                    nuevos += 1
                    total_bytes += int(f.get("size") or 0)
                files.append({
                    "orig": name, "name": name, "blobPath": blob_path,
                    "driveId": f.get("driveId"), "itemId": f.get("itemId"),
                    "dlUrl": f.get("downloadUrl"),
                    "size": int(f.get("size") or 0), "status": "existe" if exists else "nuevo",
                })
            return ok({"total": len(files), "nuevos": nuevos, "existentes": existentes,
                       "totalBytesNuevos": total_bytes, "files": files})

        # ── destino proyecto: renombra por prefijo/fecha (reusa _preparar_trabajos) ──
        project_code = (body.get("projectCode") or "").strip()
        project_name = (body.get("projectName") or "").strip()
        prefijo = (body.get("prefijo") or "FOT").strip().upper()
        subfolder = _sanitize_folder_path(body.get("subfolder", ""))
        if not project_code or not project_name:
            return err("projectCode y projectName son requeridos", 400)
        if subfolder is None:
            return err("Subcarpeta inválida", 400)
        _, auth_err = require_perms(req, cap="upload")
        if auth_err:
            return auth_err
        carpeta = uploader._resolve_carpeta(project_code, project_name)
        base = f"{carpeta}/{subfolder}" if subfolder else carpeta
        items = [{
            "name": f.get("name", ""), "size": int(f.get("size") or 0),
            "id": f.get("itemId"), "parentReference": {"driveId": f.get("driveId")},
            "lastModifiedDateTime": f.get("lastModified"),
            "relativePath": f.get("relDir", ""),
        } for f in files_in]
        indice = uploader.construir_indice_origen(get_blob_service(), prefix=f"{base}/")
        trabajos = _prepare_remote_project_jobs(items, base, prefijo, indice)
        dl_by_item = {f.get("itemId"): f.get("downloadUrl") for f in files_in}
        files = []
        nuevos = existentes = total_bytes = 0
        for t in trabajos:
            exists = t["status"] == "existe"
            if exists:
                existentes += 1
            elif t["status"] == "nuevo":
                nuevos += 1
                total_bytes += int(t.get("size_bytes") or 0)
            files.append({
                "orig": t["nombre_orig"], "name": t["nombre_nuevo"], "blobPath": t["blob_path"],
                "driveId": t.get("drive_id"), "itemId": t.get("item_id"),
                "dlUrl": dl_by_item.get(t.get("item_id")),
                "size": int(t.get("size_bytes") or 0), "status": t["status"],
                "metadata": t["metadata"], "reason": t.get("reason"),
            })
        return ok({"total": len(files), "nuevos": nuevos, "existentes": existentes,
                   "omitidos": sum(f["status"] == "omitido" for f in files),
                   "totalBytesNuevos": total_bytes, "files": files})
    except Exception as exc:
        logging.error("upload_remote_prepare: %s", exc)
        return err(str(exc), 500)


# ══════════════════════════════════════════════════════════════════════════════
# BIBLIOTECA (media) desde SharePoint / OneDrive — conserva nombres y estructura
# POST /api/upload/remote/media/plan  → lista + calcula rutas destino
# POST /api/upload/remote/media/batch → transfiere una tanda (omite existentes)
# ══════════════════════════════════════════════════════════════════════════════
def _remote_media_source(body: dict, token: str):
    """Resuelve (base_drive_url, source_folder) según el origen. Lanza ValueError."""
    source = (body.get("source") or "sharepoint").strip().lower()
    if source == "onedrive":
        user_email = (body.get("userEmail") or "").strip()
        if not user_email:
            raise ValueError("userEmail es requerido para OneDrive")
        return "onedrive", uploader.graph_drive_base("onedrive", user_email=user_email), (body.get("sourceFolder") or "/").strip()
    sp_url  = (body.get("sharepointUrl") or "").strip()
    site_id = (body.get("siteId") or "").strip()
    folder  = (body.get("sourceFolder") or "/").strip()
    if sp_url and not site_id:
        cfg = uploader.resolver_sharepoint_desde_url(sp_url)
        site_id = cfg.get("site_id") or ""
        folder  = cfg.get("folder_path") or "/"
    if not site_id:
        raise ValueError("No se pudo resolver el sitio de SharePoint")
    return "sharepoint", uploader.graph_drive_base("sharepoint", site_id=site_id), folder


@app.route(route="upload/remote/media/plan", methods=["POST", "OPTIONS"])
def upload_remote_media_plan(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    try:
        body = req.get_json()
    except Exception:
        return err("Cuerpo JSON inválido", 400)

    section = (body.get("section") or "").strip().lower()
    if section not in library_sections():
        return err("Sección de media desconocida", 400)
    dest = _sanitize_folder_path(body.get("destPath", ""))
    if dest is None:
        return err("Ruta de carpeta destino inválida", 400)
    if not dest:
        return err("destPath requerido: elige la carpeta destino", 400)
    recursive = bool(body.get("recursive") if body.get("recursive") is not None else True)

    _, auth_err = require_perms(req, section=section, item=_root_of(dest), cap="manageMedia")
    if auth_err:
        return auth_err

    try:
        token = uploader._get_graph_token()
        source, base_drive, src_folder = _remote_media_source(body, token)
        tree = uploader.list_drive_tree(token, base_drive, src_folder, recursive)

        base_prefix = f"{_media_root(section)}/{dest}"
        blob_index = uploader.construir_blob_index(get_blob_service(), prefix=f"{base_prefix}/")

        files = []
        nuevos = existentes = total_bytes = 0
        for rel, item in tree:
            name = os.path.basename(str(item.get("name") or "").strip())
            if not name or name.startswith("."):
                continue
            rel_clean = _sanitize_folder_path(rel)  # conserva subcarpetas; None si inválida
            rel_clean = rel_clean or ""
            blob_path = f"{base_prefix}/{rel_clean}/{name}" if rel_clean else f"{base_prefix}/{name}"

            drive_id = item.get("parentReference", {}).get("driveId")
            item_id = item.get("id")
            dl_url = (f"{uploader.GRAPH_BASE}/drives/{drive_id}/items/{item_id}/content"
                      if drive_id and item_id else item.get("@microsoft.graph.downloadUrl"))
            if not dl_url:
                continue

            exists = blob_path in blob_index
            if exists:
                existentes += 1
            else:
                nuevos += 1
                total_bytes += int(item.get("size") or 0)
            files.append({
                "orig": name, "name": name, "relDir": rel_clean,
                "blobPath": blob_path, "dlUrl": dl_url,
                "driveId": drive_id, "itemId": item_id,
                "size": int(item.get("size") or 0),
                "status": "existe" if exists else "nuevo",
            })

        return ok({
            "source": source, "section": section, "destPath": dest,
            "total": len(files), "nuevos": nuevos, "existentes": existentes,
            "totalBytesNuevos": total_bytes, "files": files,
        })
    except ValueError as ve:
        return err(str(ve), 400)
    except Exception as exc:
        logging.error("upload_remote_media_plan: %s", exc)
        return err(str(exc), 500)


@app.route(route="upload/remote/media/batch", methods=["POST", "OPTIONS"])
def upload_remote_media_batch(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_ok()
    try:
        body = req.get_json()
    except Exception:
        return err("Cuerpo JSON inválido", 400)

    section = (body.get("section") or "").strip().lower()
    if section not in library_sections():
        return err("Sección de media desconocida", 400)
    dest = _sanitize_folder_path(body.get("destPath", ""))
    if not dest:
        return err("destPath requerido", 400)
    items  = body.get("items") or []
    budget = min(int(body.get("budgetSeconds") or _REMOTE_BATCH_BUDGET_S), _REMOTE_BATCH_BUDGET_S)
    if not isinstance(items, list) or not items:
        return err("items: lista requerida", 400)
    if len(items) > 1000:
        return err("Máximo 1000 ítems por tanda", 400)

    _, auth_err = require_perms(req, section=section, item=_root_of(dest), cap="manageMedia")
    if auth_err:
        return auth_err

    prefix_ok = f"{_media_root(section)}/{dest}/"
    try:
        svc = get_blob_service()
        token = uploader._get_graph_token()
        results, processed = _issue_copies(svc, token, items, prefix_ok, budget, refresh=bool(body.get('refresh')))
        return ok({
            "processed": processed, "total": len(items),
            "done": processed >= len(items), "results": results,
        })
    except Exception as exc:
        logging.error("upload_remote_media_batch: %s", exc)
        return err(str(exc), 500)


# Hardware: fotos de solo lectura; los cambios de inventario se hacen en RIP_TIC.
_hardware_lock = Lock()
_hardware_cached = None
_hardware_cached_at = 0
_hardware_body = None  # ((id de la foto, vieja), bytes): la foto pesa MB; se serializa una vez


def _hardware_response(snapshot, stale):
    global _hardware_body
    key = (id(snapshot), stale)
    if _hardware_body is None or _hardware_body[0] != key:
        body = json.dumps({**snapshot, "stale": stale}, ensure_ascii=False, separators=(",", ":"), default=str)
        _hardware_body = (key, body.encode("utf-8"))
    return func.HttpResponse(body=_hardware_body[1], status_code=200,
                             headers={**cors_headers(), "Content-Type": "application/json; charset=utf-8"})
HARDWARE_REFRESH_CRON = os.environ.get("HARDWARE_REFRESH_CRON", "0 0 6 * * *")


def _hardware_blob(name):
    return get_blob_service().get_blob_client(container=CONTAINER, blob=f"{CONFIG_PREFIX.strip('/')}/hardware/{name}", retry_total=0, connection_timeout=5, read_timeout=10)


def _hardware_read_payroll():
    try:
        stream = _hardware_blob("nomina.xlsx").download_blob(timeout=10)
        return stream.readall(), stream.properties.last_modified.isoformat()
    except ResourceNotFoundError:
        return None


def _hardware_refresh():
    global _hardware_cached, _hardware_cached_at
    from hardware_service import refresh
    if not _hardware_lock.acquire(blocking=False):
        raise RuntimeError("Ya hay una actualización de Hardware en curso")
    try:
        areas = [a.strip() for a in os.environ.get("HARDWARE_TARGET_AREAS", "").split(",") if a.strip()]
        snapshot = refresh(_hardware_read_payroll, os.environ.get("MESA_URL", ""), os.environ.get("HARDWARE_SNAPSHOT_TOKEN", ""), uploader._get_graph_token, areas or None)
        # Si la Mesa no respondió, no se pisa una foto buena con una vacía.
        if (snapshot.get("sources", {}).get("mesa") or {}).get("error") and not snapshot.get("items"):
            previous = load_json_blob(f"{CONFIG_PREFIX.strip('/')}/hardware/snapshot.json")
            if previous and previous.get("items"):
                raise RuntimeError("La Mesa no respondió; se mantiene la foto anterior")
        if (snapshot.get("sources", {}).get("graph") or {}).get("error"):
            previous = load_json_blob(f"{CONFIG_PREFIX.strip('/')}/hardware/snapshot.json")
            if previous and (previous.get("licenses") or {}).get("bySku"):
                raise RuntimeError("Microsoft 365 no respondió; se mantiene el inventario anterior. Intenta actualizar de nuevo.")
        _hardware_blob("snapshot.json").upload_blob(json.dumps(snapshot, ensure_ascii=False, default=str), overwrite=True, content_type="application/json", timeout=10)
        history = {"generatedAt": snapshot["generatedAt"], "kpis": snapshot["kpis"]}
        _hardware_blob(f"history/{datetime.now(timezone.utc):%Y-%m-%d}.json").upload_blob(json.dumps(history, ensure_ascii=False), overwrite=True, content_type="application/json", timeout=10)
        _hardware_cached, _hardware_cached_at = snapshot, time.monotonic()
        return snapshot
    finally:
        _hardware_lock.release()


@app.route(route="hardware", methods=["GET", "OPTIONS"])
def hardware_get(req: func.HttpRequest) -> func.HttpResponse:
    global _hardware_cached, _hardware_cached_at
    if req.method == "OPTIONS":
        return ok({})
    _, error = require_perms(req, cap="hardware")
    if error is not None:
        return error
    reload_snapshot = _hardware_cached is None or time.monotonic() - _hardware_cached_at >= 300
    if reload_snapshot:
        _hardware_cached = load_json_blob(f"{CONFIG_PREFIX.strip('/')}/hardware/snapshot.json")
        _hardware_cached_at = time.monotonic()
    # Static Web Apps no ejecuta temporizadores. La foto vieja (> 20 h) se entrega al instante marcada
    # «stale» y la página la renueva en segundo plano (POST hardware/refresh): abrir no espera a la Mesa ni a M365.
    try:
        generated = datetime.fromisoformat(str((_hardware_cached or {}).get("generatedAt")))
        stale = datetime.now(timezone.utc) - generated > timedelta(hours=20)
    except ValueError:
        stale = _hardware_cached is not None
    needs_accounts = reload_snapshot and _hardware_cached is not None and not isinstance(
        (_hardware_cached.get("licenses") or {}).get("accounts"), list)
    if _hardware_cached is None:
        return err("Aún no hay foto de Hardware. Pulsa Actualizar ahora.", 404)
    return _hardware_response(_hardware_cached, bool(stale or needs_accounts))


def _hardware_preferences(req, resource):
    if req.method == "OPTIONS":
        return options_ok()
    _, error = require_perms(req, cap="hardware")
    if error is not None:
        return error
    from hardware_preferences import (
        DEFAULT_EXCLUDED_POSITIONS, DEFAULT_GROUP_COMPANIES, LICENSE_PRICES, validate_settings, validate_views,
    )
    if resource == "settings":
        name = "settings.json"
        default = validate_settings({"excludedPositions": DEFAULT_EXCLUDED_POSITIONS.copy(),
                                     "licensePrices": LICENSE_PRICES.copy(),
                                     "groupCompanies": DEFAULT_GROUP_COMPANIES})
        validate = validate_settings
    else:
        caller = get_caller(req) or {}
        email = caller.get("email")
        if not email:
            return err("No se pudo identificar al usuario", 401)
        name = f"views/{_safe_user_key(email)}.json"
        default = {"views": []}
        validate = validate_views
    path = f"{CONFIG_PREFIX.strip('/')}/hardware/{name}"
    try:
        if req.method == "GET":
            data = load_json_blob(path)
            return ok(default if data is None else validate(data))
        payload = req.get_json()
        data = validate(payload)
        def merge(previous):
            if resource != "settings":
                return data
            # Reaplicar el parche en cada reintento ETag conserva otras preferencias.
            return validate({**(previous or default), **payload})
        return ok(update_json_blob(path, merge))
    except ValueError as exc:
        return err(str(exc), 400)
    except RuntimeError as exc:
        return err(str(exc), 409)
    except Exception:
        logging.exception("hardware_%s", resource)
        return err("No se pudieron cargar o guardar las preferencias", 500)


@app.route(route="hardware/settings", methods=["GET", "POST", "OPTIONS"])
def hardware_settings(req: func.HttpRequest) -> func.HttpResponse:
    return _hardware_preferences(req, "settings")


@app.route(route="hardware/views", methods=["GET", "POST", "OPTIONS"])
def hardware_views(req: func.HttpRequest) -> func.HttpResponse:
    return _hardware_preferences(req, "views")


@app.route(route="hardware/refresh", methods=["POST", "OPTIONS"])
def hardware_refresh(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return ok({})
    _, error = require_perms(req, cap="hardware")
    if error is not None:
        return error
    try:
        return ok(_hardware_refresh())
    except RuntimeError as exc:
        return err(str(exc), 409)
    except Exception:
        logging.exception("hardware_refresh")
        return err("No se pudo guardar la foto de Hardware", 500)


@app.route(route="hardware/nomina", methods=["POST", "OPTIONS"])
def hardware_nomina(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return ok({})
    _, error = require_perms(req, cap="hardware")
    if error is not None:
        return error
    from hardware_snapshot import parse_payroll
    try:
        raw = req.get_body()
        if len(raw) > 14 * 1024 * 1024:
            return err("Máximo 10 MB", 413)
        if 'application/json' in req.headers.get('Content-Type', '').lower():
            raw = base64.b64decode(req.get_json().get('base64', ''), validate=True)
        if len(raw) > 10 * 1024 * 1024:
            return err("Máximo 10 MB", 413)
        parse_payroll(raw)
    except Exception:
        return err("Excel inválido: revisa la hoja Ecuador y los encabezados de nómina", 400)
    try:
        _hardware_blob("nomina.xlsx").upload_blob(raw, overwrite=True, content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        return ok(_hardware_refresh())
    except RuntimeError as exc:
        return err("Nómina guardada. " + str(exc), 409)
    except Exception:
        logging.exception("hardware_nomina")
        return err("No se pudo guardar o recalcular la nómina", 500)


@app.timer_trigger(schedule=HARDWARE_REFRESH_CRON, arg_name="timer", run_on_startup=False, use_monitor=True)
def hardware_daily(timer: func.TimerRequest):
    try:
        _hardware_refresh()
    except Exception:
        logging.exception("hardware_daily")
