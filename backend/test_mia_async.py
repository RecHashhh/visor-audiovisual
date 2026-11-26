"""Hub → MIA async upload contract: plan (staging SAS) → finalize (MIA job).

Runs the real Function handlers with blob storage and the MIA HTTP call mocked,
and checks the job body against the rules MIA enforces in
PRY-CENTRAL-APIM/RPC-TI-BE-MIA/routers/jobs.py (validate_job_request).

    .venv/bin/python -m unittest test_mia_async.py
"""
import json
import os
import unittest
from types import SimpleNamespace
from unittest import mock

os.environ.update({
    "MIA_ASYNC_UPLOADS_ENABLED": "true",
    "MIA_API_BASE_URL": "https://apim.example/pry-mia/v1",
    "MIA_API_SCOPE": "api://e880e144-11e5-4841-8758-6299aa5df362/.default",
    "MIA_CLIENT_ID": "hub-app",
    "MIA_CLIENT_SECRET": "x",
})

import azure.functions as func  # noqa: E402
import function_app as fa  # noqa: E402


def mia_rules(body: dict) -> str | None:
    """Mirror of MIA's validate_job_request for the hub's allowlist."""
    src, dst = body["source"], body["destination"]
    if src["container_name"] != "audiovisual-staging" or dst["container_name"] != "audiovisual":
        return "container not allowed"
    seen = set()
    for f in body["files"]:
        for blob, prefix in ((f["source_blob"], src["prefix"]), (f["destination_blob"], dst["prefix"])):
            if not blob.startswith(prefix.rstrip("/") + "/") or ".." in blob.split("/") or blob.startswith("/"):
                return f"{blob} outside {prefix}"
        if f["destination_blob"] in seen:
            return "duplicate destination"
        seen.add(f["destination_blob"])
    return None


def post(handler, body: dict) -> tuple[int, dict]:
    req = func.HttpRequest("POST", "http://localhost/api/x", body=json.dumps(body).encode(), headers={})
    resp = handler.build().get_user_function()(req)  # unwrap @app.route
    return resp.status_code, json.loads(resp.get_body() or b"{}")


class FakeContainer:
    """In-memory stand-in for the staging container."""
    def __init__(self):
        self.blobs = {}

    def upload_blob(self, name, data, overwrite=False):
        self.blobs[name] = data.encode() if isinstance(data, str) else data

    def download_blob(self, name):
        if name not in self.blobs:
            raise fa.ResourceNotFoundError("missing")
        return mock.Mock(readall=lambda: self.blobs[name])

    def delete_blob(self, name):
        del self.blobs[name]

    def list_blobs(self, name_starts_with=""):
        return [SimpleNamespace(name=n, size=len(d)) for n, d in self.blobs.items() if n.startswith(name_starts_with)]


def mia_ok():
    resp = mock.Mock(ok=True, status_code=202)
    resp.json.return_value = {"status": True, "data": {"job_id": "j-1", "status": "queued", "total_files": 2}}
    return resp


class MiaAsyncUpload(unittest.TestCase):
    def setUp(self):
        self.stage = FakeContainer()
        self.perms = {"email": "t@x"}
        svc = mock.MagicMock()
        svc.get_container_client.return_value = self.stage
        patches = [
            mock.patch.object(fa, "require_perms", side_effect=lambda *a, **k: (self.perms, None)),
            mock.patch.object(fa, "get_blob_service", return_value=svc),
            mock.patch.object(fa, "ensure_blob_container"),
            mock.patch.object(fa, "make_sas_url_write", side_effect=lambda blob, **kw: f"https://sas/{kw.get('container_name')}/{blob}"),
            mock.patch.object(fa.uploader, "_resolve_carpeta", return_value="P001 - Puente Rio"),
            mock.patch.object(fa.uploader, "construir_blob_index", return_value={"P001 - Puente Rio/vuelo/General/ya.mp4"}),
            mock.patch.object(fa._mia_tokens, "get", return_value="app-token"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def plan(self):
        status, plan = post(fa.upload_local_plan, {
            "projectCode": "P001", "projectName": "Puente Rio", "keepNames": True, "subfolder": "vuelo",
            "files": [
                {"name": "a.mp4", "size": 10, "relativePath": "dron/a.mp4"},
                {"name": "b c.jpg", "size": 20, "relativePath": "dron/../b c.jpg"},
                {"name": "ya.mp4", "size": 5, "relativePath": "ya.mp4"},
            ],
        })
        self.assertEqual(status, 200, plan)
        return plan.get("data", plan)

    def test_plan_stages_new_files_and_skips_existing(self):
        plan = self.plan()
        self.assertTrue(plan["asyncUpload"])
        new = [f for f in plan["files"] if f["status"] == "nuevo"]
        self.assertEqual(len(new), 2)
        self.assertEqual([f["status"] for f in plan["files"] if f["name"] == "ya.mp4"], ["existe"])
        for f in new:
            self.assertTrue(f["stagingBlobPath"].startswith(f"staging/{plan['batchId']}/"))
            self.assertIn("/audiovisual-staging/", f["sasUrl"])  # browser writes to staging, never to the final path

    def upload(self, plan):
        """What the browser does with the SAS links: write each new file to staging."""
        for f in plan["files"]:
            if f["status"] == "nuevo":
                self.stage.upload_blob(f["stagingBlobPath"], b"x" * 10)

    def test_finalize_builds_the_job_from_the_saved_plan(self):
        plan = self.plan()
        self.upload(plan)
        with mock.patch.object(fa.requests, "post", return_value=mia_ok()) as mia:
            # Extra fields a tampering browser might send are ignored.
            status, body = post(fa.upload_local_finalize, {
                "batchId": plan["batchId"], "destinationPrefix": "_config",
                "files": [{"source_blob": "x", "destination_blob": "_config/evil.json"}],
            })

        self.assertEqual(status, 202, body)
        self.assertEqual(body.get("data", body)["jobId"], "j-1")
        url, = mia.call_args.args
        sent = mia.call_args.kwargs["json"]
        self.assertEqual(url, "https://apim.example/pry-mia/v1/files/jobs")
        self.assertEqual(mia.call_args.kwargs["headers"]["Authorization"], "Bearer app-token")
        self.assertIsNone(mia_rules(sent), sent)
        self.assertEqual(sent["destination"]["prefix"], "P001 - Puente Rio/vuelo")
        self.assertEqual(sorted(f["destination_blob"] for f in sent["files"]),
                         sorted(f["blobPath"] for f in plan["files"] if f["status"] == "nuevo"))
        self.assertEqual({f["size_bytes"] for f in sent["files"]}, {10})
        self.assertTrue(sent["delete_source_on_success"])
        # The saved plan is consumed: a second finalize can't create a duplicate job.
        self.assertEqual(post(fa.upload_local_finalize, {"batchId": plan["batchId"]})[0], 404)

    def test_finalize_only_includes_files_that_reached_staging(self):
        plan = self.plan()
        first = next(f for f in plan["files"] if f["status"] == "nuevo")
        self.stage.upload_blob(first["stagingBlobPath"], b"x")
        with mock.patch.object(fa.requests, "post", return_value=mia_ok()) as mia:
            self.assertEqual(post(fa.upload_local_finalize, {"batchId": plan["batchId"]})[0], 202)
        self.assertEqual([f["source_blob"] for f in mia.call_args.kwargs["json"]["files"]], [first["stagingBlobPath"]])

    def test_finalize_rejects_another_users_batch(self):
        plan = self.plan()
        self.upload(plan)
        self.perms = {"email": "other@x"}
        with mock.patch.object(fa.requests, "post") as mia:
            self.assertEqual(post(fa.upload_local_finalize, {"batchId": plan["batchId"]})[0], 403)
        mia.assert_not_called()

    def test_mia_rejection_is_reported(self):
        plan = self.plan()
        self.upload(plan)
        mia_resp = mock.Mock(ok=False, status_code=400, text='{"message":"Contenedor de origen no permitido"}')
        with mock.patch.object(fa.requests, "post", return_value=mia_resp):
            status, body = post(fa.upload_local_finalize, {"batchId": plan["batchId"]})
        self.assertEqual(status, 502)
        self.assertIn("no permitido", json.dumps(body, ensure_ascii=False))
        # Plan kept so the user can retry finalize.
        self.assertIn(f"plans/{plan['batchId']}.json", self.stage.blobs)

    def test_finalize_validates_input_and_flag(self):
        self.assertEqual(post(fa.upload_local_finalize, {"batchId": "../plans/x"})[0], 400)
        self.assertEqual(post(fa.upload_local_finalize, {"batchId": "a" * 32})[0], 404)
        with mock.patch.object(fa, "MIA_ASYNC_UPLOADS_ENABLED", False):
            self.assertEqual(post(fa.upload_local_finalize, {"batchId": "a" * 32})[0], 409)


if __name__ == "__main__":
    unittest.main()
