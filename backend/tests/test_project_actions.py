"""Permisos y acciones de Obra, con almacenamiento simulado y sin red."""
import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import azure.functions as func
import function_app as app


PROJECT = "28002_obra"
WEEK = "sub/2026_S15"
PHOTO = f"{PROJECT}/{WEEK}/FOT_001.jpg"


def request(action, body):
    return func.HttpRequest(method="POST", url=f"http://local/api/projects/{PROJECT}/{action}",
                            route_params={"project_id": PROJECT}, body=json.dumps(body).encode())


def invoke(endpoint, req):
    return endpoint.build().get_user_function()(req)


class GroupTests(unittest.TestCase):
    def perms(self, config, email="ti@ripconciv.com"):
        with patch.object(app, "load_access_config", return_value=config), patch.object(app, "ADMIN_EMAILS", set()):
            return app.effective_perms({"email": email, "name": "TI"})

    def test_member_in_restricted_mode(self):
        p = self.perms({"restricted": True, "groups": {"equipo-ti": {"members": ["ti@ripconciv.com"]}}})
        self.assertTrue(p["allowed"])
        self.assertEqual((p["sections"], p["scopes"], p["groups"]), ("*", {}, ["equipo-ti"]))
        for cap in ("upload", "manageMedia", "share", "refreshIndex", "deleteMedia", "renameProject", "tagMedia", "review"):
            self.assertTrue(p["caps"][cap], cap)
        self.assertFalse(p["caps"]["manageAccess"])

    def test_individual_caps_are_combined_with_or(self):
        cfg = {"restricted": True, "groups": {"equipo-ti": {"members": ["ti@ripconciv.com"]}},
               "users": [{"email": "ti@ripconciv.com", "role": "viewer", "sections": [],
                          "caps": {"upload": False, "deleteMedia": False, "manageAccess": True}}]}
        p = self.perms(cfg)
        self.assertTrue(all(p["caps"].values()))
        self.assertTrue(p["isAdmin"])

    def test_default_group_in_old_config(self):
        for email in app.DEFAULT_TI_MEMBERS:
            self.assertEqual(self.perms({"restricted": True, "users": []}, email)["groups"], ["equipo-ti"])

    def test_explicit_empty_group_removes_defaults(self):
        p = self.perms({"restricted": True, "groups": {"equipo-ti": {"members": []}}}, app.DEFAULT_TI_MEMBERS[0])
        self.assertFalse(p["allowed"])
        self.assertEqual(p["groups"], [])

    def test_disabled_individual_entry_does_not_remove_group(self):
        cfg = {"restricted": True, "users": [{"email": app.DEFAULT_TI_MEMBERS[0], "enabled": False}]}
        self.assertTrue(self.perms(cfg, app.DEFAULT_TI_MEMBERS[0])["caps"]["deleteMedia"])

    def test_presets(self):
        for cap in ("renameProject", "tagMedia", "review", "deleteMedia"):
            self.assertTrue(app.ROLE_CAPS["admin"][cap])
            self.assertFalse(app.ROLE_CAPS["operador"][cap])
            self.assertFalse(app.ROLE_CAPS["viewer"][cap])

    def test_group_normalizes_and_validates_emails(self):
        self.assertEqual(app.access_groups({"groups": {"equipo-ti": {"members": [" TI@ripconciv.com ", "ti@ripconciv.com"]}}})
                         ["equipo-ti"]["members"], ["ti@ripconciv.com"])
        for members in (["bad@"], "ti@example.com", ["a b@example.com"]):
            with self.assertRaises(ValueError):
                app.access_groups({"groups": {"equipo-ti": {"members": members}}})


class DeleteValidationTests(unittest.TestCase):
    def test_nested_week_and_deduplication(self):
        self.assertEqual(app.validate_project_delete(PROJECT, {"week": WEEK, "paths": [PHOTO, PHOTO]}),
                         (WEEK, [PHOTO], f"{PROJECT}/{WEEK}/"))

    def test_cannot_escape_project_or_week(self):
        for path in ("otro/2026_S15/a.jpg", f"{PROJECT}2/2026_S15/a.jpg", f"{PROJECT}/../a.jpg",
                     f"{PROJECT}/sub/2026_S16/a.jpg", f"{PROJECT}/{WEEK}/%2e%2e/a.jpg",
                     f"{PROJECT}/{WEEK}/a\\b.jpg", f"{PROJECT}/{WEEK}//a.jpg", None):
            with self.subTest(path=path), self.assertRaises(ValueError):
                app.validate_project_delete(PROJECT, {"week": WEEK, "paths": [path]})

    def test_invalid_weeks_and_empty_requests(self):
        for body in ({}, [], {"paths": []}, {"paths": "abc"}, {"week": "../2026_S15"},
                     {"week": "/2026_S15"}, {"week": "2026_S00"}, {"week": "2026_S54"}, {"week": ""}):
            with self.subTest(body=body), self.assertRaises(ValueError):
                app.validate_project_delete(PROJECT, body)

    def test_protected_roots(self):
        for project in ("..", "_config", "_thumbs", "_proxies", "a/b", "a\\b"):
            with self.subTest(project=project), self.assertRaises(ValueError):
                app.validate_project_delete(project, {"week": "2026_S15"})

    def test_endpoint_deletes_derivatives_audits_and_refreshes(self):
        cc = Mock()
        perms = {"email": "ti@ripconciv.com"}
        with patch.object(app, "require_perms", return_value=(perms, None)), \
             patch.object(app, "get_blob_service") as svc, \
             patch.object(app, "update_json_blob") as update, \
             patch.object(app, "refresh_project_indexes") as refresh:
            svc.return_value.get_container_client.return_value = cc
            response = invoke(app.project_delete, request("delete", {"paths": [PHOTO]}))
        self.assertEqual(response.status_code, 200)
        self.assertEqual([c.args[0] for c in cc.delete_blob.call_args_list],
                         [PHOTO, app.thumb_sidecar_name(PHOTO), app.proxy_sidecar_name(PHOTO)])
        audit = update.call_args.args[1]([])[0]
        self.assertEqual((audit["by"], audit["project"], audit["count"], audit["paths"]),
                         (perms["email"], PROJECT, 1, [PHOTO]))
        self.assertIn("/audit/borrados-", update.call_args.args[0])
        refresh.assert_called_once_with(PROJECT, [PHOTO])

    def test_batch_includes_derivatives_in_2000_limit(self):
        paths = [f"{PROJECT}/2026_S15/{i}.mov" for i in range(700)]
        with patch.object(app, "require_perms", return_value=({"email": "ti@example.com"}, None)), \
             patch.object(app, "get_blob_service") as svc, patch.object(app, "update_json_blob"), \
             patch.object(app, "refresh_project_indexes"):
            response = invoke(app.project_delete, request("delete", {"paths": paths}))
        result = json.loads(response.get_body())
        self.assertEqual(result["remaining"], 34)
        self.assertEqual(len(result["remainingPaths"]), 34)
        self.assertLessEqual(svc.return_value.get_container_client.return_value.delete_blob.call_count, 2000)

    def test_authorization_precedes_storage(self):
        with patch.object(app, "require_perms", return_value=(None, app.err("Sin permiso", 403))), \
             patch.object(app, "get_blob_service") as svc:
            self.assertEqual(invoke(app.project_delete, request("delete", {"paths": [PHOTO]})).status_code, 403)
            self.assertEqual(invoke(app.project_name, request("name", {"name": "Obra nueva"})).status_code, 403)
        svc.assert_not_called()

    def test_scoped_refresh_empties_obsolete_file_indexes(self):
        payload = {"projects": [], "weeksByProject": {}, "filesByProjectWeek": {}}
        def load(name):
            return [{"week": WEEK}] if name == app.index_weeks_blob_name(PROJECT) else [{"code": PROJECT}, {"code": "otro"}]
        with patch.object(app, "load_json_blob", side_effect=load), \
             patch.object(app, "build_index_payloads", return_value=payload) as build, \
             patch.object(app, "save_json_blob") as save, patch.object(app, "update_json_blob") as update:
            app.refresh_project_indexes(PROJECT, [PHOTO])
        build.assert_called_once_with(PROJECT)
        save.assert_any_call(app.index_weeks_blob_name(PROJECT), [])
        save.assert_any_call(app.index_files_blob_name(PROJECT, WEEK), [])
        self.assertEqual(update.call_args.args[1]([{"code": PROJECT}, {"code": "otro"}]), [{"code": "otro"}])


class ProjectNamesAndCountsTests(unittest.TestCase):
    def test_names_do_not_mutate_cache_or_code(self):
        projects = [{"code": PROJECT, "name": "OBRA", "photoCount": 1234}]
        result = app.apply_project_names(app.normalize_projects_payload(projects), {PROJECT: {"name": "Obra del río"}})
        self.assertEqual(result[0]["name"], "Obra del río")
        self.assertEqual(result[0]["code"], PROJECT)
        self.assertEqual(projects[0]["name"], "OBRA")
        self.assertEqual(result[0]["photoCount"], 1234)
        self.assertNotIn("videoCount", result[0])

    def test_empty_override_restores_automatic_name(self):
        project = {"code": PROJECT, "name": "OBRA"}
        self.assertEqual(app.apply_project_names([project], {PROJECT: {"name": ""}})[0], project)

    def test_favorites_and_jobs_use_current_name(self):
        names = {PROJECT: {"name": "Obra del río"}}
        for reference in ({"projectCode": "28002", "projectName": "OBRA"},
                          {"projectCode": PROJECT, "path": PHOTO, "projectName": "OBRA"}):
            self.assertEqual(app.apply_project_reference_name(reference, names)["projectName"], "Obra del río")
            self.assertEqual(app.apply_project_reference_name(reference, {PROJECT: {"name": ""}})["projectName"], "OBRA")

    def test_project_names_are_applied_to_cache_and_index(self):
        req = func.HttpRequest(method="GET", url="http://local/api/projects", body=b"")
        projects = [{"code": PROJECT, "name": "OBRA"}]
        for cached in (None, projects):
            with self.subTest(cached=cached is not None), \
                 patch.object(app, "require_perms", return_value=({"sections": "*", "scopes": {}}, None)), \
                 patch.object(app, "cache_get", return_value=cached), \
                 patch.object(app, "load_json_blob", return_value=projects), \
                 patch.object(app, "load_project_names", return_value={PROJECT: {"name": "Río"}}), \
                 patch.object(app, "INDEX_ENABLED", True), patch.object(app, "cache_set"):
                result = json.loads(invoke(app.get_projects, req).get_body())
                self.assertEqual(result[0]["name"], "Río")
        self.assertEqual(projects[0]["name"], "OBRA")

    def test_name_validation(self):
        for name, status in (("ab", 400), ("x" * 121, 400), (None, 400), ("", 200), ("  Río  ", 200)):
            with self.subTest(name=name), patch.object(app, "require_perms", return_value=({"email": "ti@example.com"}, None)), \
                 patch.object(app, "update_json_blob"):
                self.assertEqual(invoke(app.project_name, request("name", {"name": name})).status_code, status)

    def test_index_counts_real_type_values(self):
        now = datetime.now(timezone.utc)
        blobs = [SimpleNamespace(name=f"{PROJECT}/2026_S15/{n}", size=1, last_modified=now)
                 for n in ("a.jpg", "b.png", "c.mov", "d.mkv", "e.dng", "f.pdf", ".keep")]
        with patch.object(app, "get_blob_service") as svc:
            svc.return_value.get_container_client.return_value.list_blobs.return_value = blobs
            result = app.build_index_payloads()["projects"][0]
        self.assertEqual((result["photoCount"], result["videoCount"]), (2, 2))

    def test_counts_without_index(self):
        req = func.HttpRequest(method="GET", url="http://local/api/projects", body=b"")
        now = datetime.now(timezone.utc)
        blobs = [SimpleNamespace(name=f"{PROJECT}/2026_S15/{n}", size=1, last_modified=now)
                 for n in ("a.jpg", "b.mov", "c.dng")]
        with patch.object(app, "require_perms", return_value=({"sections": "*", "scopes": {}}, None)), \
             patch.object(app, "cache_get", return_value=None), patch.object(app, "cache_set"), \
             patch.object(app, "INDEX_ENABLED", False), patch.object(app, "load_project_names", return_value={}), \
             patch.object(app, "get_blob_service") as svc:
            svc.return_value.get_container_client.return_value.list_blobs.return_value = blobs
            result = json.loads(invoke(app.get_projects, req).get_body())[0]
        self.assertEqual((result["photoCount"], result["videoCount"]), (1, 1))


if __name__ == "__main__":
    unittest.main()
