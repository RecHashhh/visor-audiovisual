"""Regresión: con el SDK real (12.19), IfMissing no debe ir con etag="*".

El SDK no consume `etag` cuando la condición es IfMissing y lo pasa a la
sesión HTTP, que falla con «unexpected keyword argument 'etag'». Los tests con
clientes falsos no lo detectan; aquí se usa BlobClient real con un transporte
que solo registra la petición.
"""
import sys
import unittest
from pathlib import Path

from azure.core import MatchConditions
from azure.core.pipeline.transport import HttpTransport, HttpResponse
from azure.storage.blob import BlobClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class _Resp(HttpResponse):
    def __init__(self, request, status):
        super().__init__(request, None)
        self.status_code = status
        self.headers = {"x-ms-copy-id": "1", "x-ms-copy-status": "pending", "ETag": '"1"'}
        self.reason = "OK"

    def body(self):
        return b""


class _Transport(HttpTransport):
    def __init__(self):
        self.requests = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def open(self):
        pass

    def close(self):
        pass

    def send(self, request, **kwargs):
        self.requests.append(request)
        return _Resp(request, 202 if request.headers.get("x-ms-copy-source") else 201)


def client(transport):
    return BlobClient("https://cuenta.blob.core.windows.net", "audiovisual", "obra/2024_S07/FOT_20240215_001.jpg",
                      credential=None, transport=transport, retry_total=0)


class SdkConditionsTests(unittest.TestCase):
    def test_copy_if_missing_envia_if_none_match(self):
        t = _Transport()
        client(t).start_copy_from_url("https://origen/x.jpg", metadata={"srcname": "x.jpg", "srcsize": "1"},
                                      match_condition=MatchConditions.IfMissing)
        self.assertEqual(t.requests[-1].headers.get("If-None-Match"), "*")

    def test_commit_y_upload_if_missing(self):
        t = _Transport()
        c = client(t)
        c.commit_block_list(["MDAwMDAw"], metadata={"srcname": "x"}, match_condition=MatchConditions.IfMissing)
        self.assertEqual(t.requests[-1].headers.get("If-None-Match"), "*")
        c.upload_blob(b"{}", overwrite=True, match_condition=MatchConditions.IfMissing)
        self.assertEqual(t.requests[-1].headers.get("If-None-Match"), "*")

    def test_codigo_no_combina_etag_comodin_con_if_missing(self):
        root = Path(__file__).resolve().parents[1]
        for name in ("function_app.py", "uploader.py", "favorites_store.py", "tags_store.py", "presets_store.py"):
            self.assertNotIn('etag="*"', (root / name).read_text(encoding="utf-8"), name)


if __name__ == "__main__":
    unittest.main()
