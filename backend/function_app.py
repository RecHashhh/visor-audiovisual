"""
Azure Functions Backend — Visor Audiovisual
Todas las funciones en un solo archivo (v2 programming model)

Endpoints:
  GET  /api/projects
  GET  /api/projects/{id}/weeks
  GET  /api/projects/{id}/weeks/{week}/files
  POST /api/sas/generate
  POST /api/share/create
  GET  /api/share/list
  GET  /api/share/{token}
  DELETE /api/share/{token}
"""

import azure.functions as func
import json
import os
import logging
import uuid
import hashlib
import hmac
from datetime import datetime, timezone, timedelta
from azure.storage.blob import (
    BlobServiceClient,
    generate_blob_sas,
    generate_container_sas,
    BlobSasPermissions,
    ContainerSasPermissions,
)
import jwt
import requests

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

# ── CONFIG ────────────────────────────────────────────────────────────
CONN_STR        = os.environ["AZURE_STORAGE_CONNECTION_STRING"]
ACCOUNT_NAME    = os.environ.get("AZURE_STORAGE_ACCOUNT", "ripconaudiovisual")
ACCOUNT_KEY     = os.environ.get("AZURE_STORAGE_KEY", "")          # Necesario para SAS
CONTAINER       = os.environ.get("CONTAINE_NAME", "audiovisual")
TENANT_ID       = os.environ.get("TENANT_ID", "")
CLIENT_ID       = os.environ.get("CLIENT_ID", "")
SHARE_SECRET    = os.environ.get("SHARE_SECRET", "cambiar-este-secreto-en-produccion")

# In-memory share store (Azure Table Storage en producción)
# Para producción real usa Azure Table Storage (incluido en la cuenta de storage)
_shares: dict[str, dict] = {}

# ── HELPERS ──────────────────────────────────────────────────────────

def cors_headers():
    return {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Content-Type": "application/json",
    }

def ok(data, status=200):
    return func.HttpResponse(
        body=json.dumps(data, default=str),
        status_code=status,
        headers=cors_headers(),
    )

def err(msg, status=400):
    return func.HttpResponse(
        body=json.dumps({"error": msg}),
        status_code=status,
        headers=cors_headers(),
    )

def options_response():
    return func.HttpResponse("", status_code=204, headers=cors_headers())

def get_blob_service():
    return BlobServiceClient.from_connection_string(CONN_STR)

def verify_token(req: func.HttpRequest) -> dict | None:
    """Validate Azure AD JWT token from Authorization header."""
    auth = req.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth[7:]
    try:
        # Fetch JWKS from Microsoft
        jwks_uri = f"https://login.microsoftonline.com/{TENANT_ID}/discovery/v2.0/keys"
        jwks = requests.get(jwks_uri, timeout=5).json()
        public_keys = {}
        for key_data in jwks.get("keys", []):
            kid = key_data["kid"]
            public_keys[kid] = jwt.algorithms.RSAAlgorithm.from_jwk(json.dumps(key_data))

        header = jwt.get_unverified_header(token)
        key = public_keys.get(header.get("kid"))
        if not key:
            return None

        payload = jwt.decode(
            token, key,
            algorithms=["RS256"],
            audience=CLIENT_ID,
            options={"verify_exp": True},
        )
        return payload
    except Exception as e:
        logging.warning(f"Token validation failed: {e}")
        return None

def ext_of(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""

def type_of(name: str) -> str:
    ext = ext_of(name)
    if ext in ("jpg", "jpeg", "png", "tiff", "tif", "webp"): return "img"
    if ext in ("mp4", "mov", "avi", "mkv"):                   return "vid"
    if ext in ("dng", "cr3", "arw", "raw", "nef"):            return "raw"
    if ext in ("insv",):                                       return "i360"
    return "file"

def prefix_of(name: str) -> str:
    return name.split("_")[0].upper() if "_" in name else "???"

def make_sas(blob_path: str, expiry_minutes: int = 60) -> str:
    expiry = datetime.now(timezone.utc) + timedelta(minutes=expiry_minutes)
    sas = generate_blob_sas(
        account_name=ACCOUNT_NAME,
        container_name=CONTAINER,
        blob_name=blob_path,
        account_key=ACCOUNT_KEY,
        permission=BlobSasPermissions(read=True),
        expiry=expiry,
    )
    return f"https://{ACCOUNT_NAME}.blob.core.windows.net/{CONTAINER}/{blob_path}?{sas}"

# ── PROJECTS ─────────────────────────────────────────────────────────

@app.route(route="projects", methods=["GET", "OPTIONS"])
def get_projects(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_response()

    # Auth check (soft — returns empty list if not authenticated, not 401)
    user = verify_token(req)
    if not user and CLIENT_ID:
        return err("Unauthorized", 401)

    try:
        svc = get_blob_service()
        container_client = svc.get_container_client(CONTAINER)

        # List virtual "folders" (project codes) by walking prefixes
        project_map: dict[str, dict] = {}
        blobs = container_client.list_blobs()

        for blob in blobs:
            # Path: PRY001_torre-norte/2026_S01/FOT_20260407_001.jpg
            parts = blob.name.split("/")
            if len(parts) < 3:
                continue
            proj_folder = parts[0]   # e.g. "33006_promart-batan"
            week_folder  = parts[1]
            file_name    = parts[2]

            code = proj_folder.split("_")[0]
            name_slug = "_".join(proj_folder.split("_")[1:]).replace("-", " ").upper()

            if proj_folder not in project_map:
                project_map[proj_folder] = {
                    "code": proj_folder,
                    "name": name_slug,
                    "weeks": set(),
                    "types": set(),
                    "lastModified": None,
                    "status": "completo",
                }

            project_map[proj_folder]["weeks"].add(week_folder)
            project_map[proj_folder]["types"].add(prefix_of(file_name))

            lm = blob.last_modified
            cur = project_map[proj_folder]["lastModified"]
            if lm and (cur is None or lm > cur):
                project_map[proj_folder]["lastModified"] = lm

        projects = []
        for p in sorted(project_map.values(), key=lambda x: x["code"]):
            projects.append({
                "code":         p["code"],
                "name":         p["name"],
                "weeks":        len(p["weeks"]),
                "types":        "+".join(sorted(p["types"])),
                "status":       p["status"],
                "lastModified": p["lastModified"].isoformat() if p["lastModified"] else None,
            })

        return ok(projects)
    except Exception as e:
        logging.error(f"get_projects error: {e}")
        return err(str(e), 500)


@app.route(route="projects/{project_id}/weeks", methods=["GET", "OPTIONS"])
def get_weeks(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_response()

    user = verify_token(req)
    if not user and CLIENT_ID:
        return err("Unauthorized", 401)

    project_id = req.route_params.get("project_id", "")

    try:
        svc = get_blob_service()
        cc = svc.get_container_client(CONTAINER)

        week_map: dict[str, dict] = {}
        prefix = f"{project_id}/"

        for blob in cc.list_blobs(name_starts_with=prefix):
            parts = blob.name.split("/")
            if len(parts) < 3:
                continue
            week = parts[1]
            fname = parts[2]

            if week not in week_map:
                week_map[week] = {"week": week, "count": 0, "types": set()}
            week_map[week]["count"] += 1
            week_map[week]["types"].add(prefix_of(fname))

        weeks = [
            {"week": k, "count": v["count"], "types": sorted(v["types"])}
            for k, v in sorted(week_map.items())
        ]
        return ok(weeks)
    except Exception as e:
        logging.error(f"get_weeks error: {e}")
        return err(str(e), 500)


@app.route(route="projects/{project_id}/weeks/{week}/files", methods=["GET", "OPTIONS"])
def get_files(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_response()

    user = verify_token(req)
    if not user and CLIENT_ID:
        return err("Unauthorized", 401)

    project_id = req.route_params.get("project_id", "")
    week       = req.route_params.get("week", "")

    try:
        svc = get_blob_service()
        cc  = svc.get_container_client(CONTAINER)

        prefix = f"{project_id}/{week}/"
        files = []
        for blob in cc.list_blobs(name_starts_with=prefix):
            fname = blob.name.split("/")[-1]
            if not fname:
                continue
            files.append({
                "name":         fname,
                "path":         blob.name,
                "size":         blob.size,
                "type":         type_of(fname),
                "prefix":       prefix_of(fname),
                "lastModified": blob.last_modified.isoformat() if blob.last_modified else None,
            })

        files.sort(key=lambda f: f["name"])
        return ok(files)
    except Exception as e:
        logging.error(f"get_files error: {e}")
        return err(str(e), 500)


# ── SAS TOKEN ────────────────────────────────────────────────────────

@app.route(route="sas/generate", methods=["POST", "OPTIONS"])
def sas_generate(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_response()

    user = verify_token(req)
    if not user and CLIENT_ID:
        return err("Unauthorized", 401)

    try:
        body = req.get_json()
        blob_path     = body.get("blobPath", "")
        expiry_minutes = int(body.get("expiryMinutes", 60))

        if not blob_path:
            return err("blobPath is required")
        if expiry_minutes > 1440:
            expiry_minutes = 1440  # max 24h

        sas_url = make_sas(blob_path, expiry_minutes)
        return ok({"sasUrl": sas_url, "expiresInMinutes": expiry_minutes})
    except Exception as e:
        logging.error(f"sas_generate error: {e}")
        return err(str(e), 500)


# ── SHARE LINKS ──────────────────────────────────────────────────────

@app.route(route="share/create", methods=["POST", "OPTIONS"])
def share_create(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_response()

    user = verify_token(req)
    if not user and CLIENT_ID:
        return err("Unauthorized", 401)

    try:
        body        = req.get_json()
        project_id  = body.get("projectId", "")
        week        = body.get("week", "")
        expiry_days = int(body.get("expiryDays", 7))

        if not project_id:
            return err("projectId is required")

        token     = str(uuid.uuid4()).replace("-", "")
        expires_at = datetime.now(timezone.utc) + timedelta(days=expiry_days)

        _shares[token] = {
            "token":     token,
            "projectId": project_id,
            "week":      week,
            "expiresAt": expires_at.isoformat(),
            "createdBy": user.get("preferred_username", user.get("name", "unknown")) if user else "system",
            "active":    True,
        }

        share_url = f"{req.headers.get('Origin', '')}/share/{token}"
        return ok({
            "token":     token,
            "shareUrl":  share_url,
            "expiresAt": expires_at.isoformat(),
        })
    except Exception as e:
        logging.error(f"share_create error: {e}")
        return err(str(e), 500)


@app.route(route="share/list", methods=["GET", "OPTIONS"])
def share_list(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_response()

    user = verify_token(req)
    if not user and CLIENT_ID:
        return err("Unauthorized", 401)

    now = datetime.now(timezone.utc)
    shares = []
    for s in _shares.values():
        exp = datetime.fromisoformat(s["expiresAt"])
        shares.append({**s, "expired": exp < now})

    shares.sort(key=lambda x: x["expiresAt"], reverse=True)
    return ok(shares)


@app.route(route="share/{token}", methods=["GET", "DELETE", "OPTIONS"])
def share_resolve(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return options_response()

    token = req.route_params.get("token", "")
    share = _shares.get(token)

    if req.method == "DELETE":
        user = verify_token(req)
        if not user and CLIENT_ID:
            return err("Unauthorized", 401)
        if token in _shares:
            del _shares[token]
        return ok({"deleted": True})

    # GET — resolve for external user (no auth needed)
    if not share:
        return err("Enlace no encontrado", 404)

    expires_at = datetime.fromisoformat(share["expiresAt"])
    if datetime.now(timezone.utc) > expires_at:
        return err("Este enlace ha expirado", 410)

    if not share.get("active", True):
        return err("Este enlace fue revocado", 410)

    project_id = share["projectId"]
    week       = share.get("week", "")

    try:
        svc = get_blob_service()
        cc  = svc.get_container_client(CONTAINER)

        prefix = f"{project_id}/{week}/" if week else f"{project_id}/"
        files = []
        for blob in cc.list_blobs(name_starts_with=prefix):
            fname = blob.name.split("/")[-1]
            if not fname:
                continue
            sas_url = make_sas(blob.name, expiry_minutes=int((expires_at - datetime.now(timezone.utc)).total_seconds() / 60))
            files.append({
                "name":   fname,
                "path":   blob.name,
                "type":   type_of(fname),
                "sasUrl": sas_url,
            })

        files.sort(key=lambda f: f["name"])
        return ok({
            **share,
            "files": files,
        })
    except Exception as e:
        logging.error(f"share_resolve error: {e}")
        return err(str(e), 500)
