"""
Genera copias livianas (MP4 H.264, máx. 1920 px, índice al inicio) de los
videos que el navegador no puede reproducir, como ProRes, y las deja donde las
busca /api/sas/generate con preferProxy:

    00000_hospital-manta/2020_S20/VID_20200511_002.mov
    → _proxies/00000_hospital-manta/2020_S20/VID_20200511_002.mov.mp4

El original no se toca: el visor reproduce la copia y Descargar sigue
entregando el archivo original. Sin copia, la app no se rompe: el visor avisa
que el formato no es compatible.

Uso:
    python make_video_proxies.py              # revisa los .mov
    python make_video_proxies.py --ext .mov .mp4
    python make_video_proxies.py --dry-run    # solo lista qué convertiría
    python make_video_proxies.py --force      # regenera las existentes
    python make_video_proxies.py --prefix 00000_hospital-manta/

Requisitos:
    pip install azure-storage-blob
    ffmpeg y ffprobe en el PATH

Variables de entorno (las mismas que el backend):
    AZURE_STORAGE_CONNECTION_STRING, BLOB_CONTAINER
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone

from azure.storage.blob import BlobSasPermissions, BlobServiceClient, ContentSettings, generate_blob_sas

CONTAINER = os.environ.get("BLOB_CONTAINER", "audiovisual")
PROXIES_PREFIX = os.environ.get("PROXIES_PREFIX", "_proxies")
# Carpetas internas de la app: nunca son material a convertir.
INTERNAL_PREFIXES = ("_proxies/", "_thumbs/", "_index/", "_config/", "_shares/")

# Lo que Chrome y Edge reproducen sin extensiones. Todo lo demás se convierte.
BROWSER_OK = {"h264", "vp8", "vp9", "av1"}
MAX_SIDE = 1920


def proxy_name(blob_name: str) -> str:
    return f"{PROXIES_PREFIX.strip('/')}/{blob_name.strip('/')}.mp4"


def sas_url(svc: BlobServiceClient, blob_name: str) -> str:
    token = generate_blob_sas(
        account_name=svc.account_name, container_name=CONTAINER, blob_name=blob_name,
        account_key=svc.credential.account_key, permission=BlobSasPermissions(read=True),
        expiry=datetime.now(timezone.utc) + timedelta(hours=2),
    )
    return f"{svc.get_blob_client(CONTAINER, blob_name).url}?{token}"


def video_codec(url: str) -> str:
    """ffprobe lee solo el índice por rangos HTTP; no baja el archivo."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=codec_name", "-of", "csv=p=0", url],
        capture_output=True, text=True, timeout=180,
    )
    # Algunos archivos traen campos extra ("h264,"): nos quedamos con el primero.
    first = (out.stdout.strip().splitlines() or [""])[0]
    return first.split(",")[0].strip().lower()


def convert(src: str, dst: str) -> None:
    # Escala para que el lado mayor quede en MAX_SIDE como mucho (vale para
    # horizontales y verticales); -2 mantiene la proporción con alto par.
    scale = (f"scale='if(gt(iw,ih),min({MAX_SIDE},iw),-2)':"
             f"'if(gt(iw,ih),-2,min({MAX_SIDE},ih))'")
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src,
         "-map", "0:v:0", "-map", "0:a:0?",
         "-vf", scale, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
         "-movflags", "+faststart", dst],
        check=True,
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ext", nargs="+", default=[".mov"], help="extensiones a revisar")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--prefix", default="", help="solo blobs bajo esta ruta (p. ej. 00000_hospital-manta/)")
    args = ap.parse_args()
    # La consola de Windows no siempre es UTF-8; que un print nunca tumbe una subida.
    sys.stdout.reconfigure(errors="replace")

    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"Falta {tool} en el PATH")
    conn = os.environ.get("AZURE_STORAGE_CONNECTION_STRING")
    if not conn:
        sys.exit("Falta AZURE_STORAGE_CONNECTION_STRING")

    svc = BlobServiceClient.from_connection_string(conn)
    cc = svc.get_container_client(CONTAINER)
    exts = tuple(e.lower() for e in args.ext)

    existing = {b.name for b in cc.list_blobs(name_starts_with=f"{PROXIES_PREFIX.strip('/')}/") if b.name.endswith(".mp4")}
    candidates = [b for b in cc.list_blobs(name_starts_with=args.prefix or None)
                  if b.name.lower().endswith(exts) and not b.name.startswith(INTERNAL_PREFIXES)]
    print(f"{len(candidates)} video(s) con {', '.join(exts)}; {len(existing)} copia(s) ya existentes")

    made = skipped = failed = 0
    for b in candidates:
        target = proxy_name(b.name)
        if target in existing and not args.force:
            skipped += 1
            continue
        try:
            codec = video_codec(sas_url(svc, b.name))
        except Exception as exc:
            print(f"  ! {b.name}: no se pudo leer el códec ({exc})")
            failed += 1
            continue
        if not codec or codec in BROWSER_OK:
            skipped += 1
            continue
        print(f"  {b.name}  [{codec}, {b.size / 1e9:.2f} GB]", flush=True)
        if args.dry_run:
            continue

        started = time.time()
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "src" + os.path.splitext(b.name)[1])
            dst = os.path.join(tmp, "proxy.mp4")
            try:
                with open(src, "wb") as fh:
                    cc.download_blob(b.name, max_concurrency=8).readinto(fh)
                convert(src, dst)
                with open(dst, "rb") as fh:
                    cc.upload_blob(
                        target, fh, overwrite=True, max_concurrency=4,
                        content_settings=ContentSettings(content_type="video/mp4"),
                        metadata={"source_etag": (b.etag or "").strip('"'), "source_codec": codec},
                    )
                size = os.path.getsize(dst)
                print(f"    → {target}  {size / 1e6:.0f} MB en {time.time() - started:.0f} s", flush=True)
                made += 1
            except Exception as exc:
                print(f"  ! {b.name}: {exc}", flush=True)
                failed += 1

    print(f"Listo: {made} creada(s), {skipped} omitida(s), {failed} con error")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
