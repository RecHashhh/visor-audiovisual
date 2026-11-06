"""Revisión de proyectos: blobs en memoria, sin servicios de red."""
import copy
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import azure.functions as func
import function_app as app


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.base = [{"code": "A", "name": "Base A"}, {"code": "B", "name": "Base B"}]
        self.index = [{"code": "A", "name": "Índice A", "photoCount": 12, "videoCount": 3,
                       "weeks": 4, "lastModified": "2026-11-06T12:00:00Z"},
                      {"code": "C", "name": "Extra C", "photoCount": 5, "videoCount": 1, "weeks": 2}]
        self.members = ["uno@ripconciv.com", "dos@ripconciv.com"]
        self.blobs = {app.index_projects_blob_name(): self.index}
        self.writes = 0

        def update(blob, transform):
            self.writes += 1
            saved = transform(copy.deepcopy(self.blobs.get(blob)))
            self.blobs[blob] = copy.deepcopy(saved)
            return saved

        patches = [patch.object(app, "load_review_base", return_value=self.base),
                   patch.object(app, "load_json_blob", side_effect=lambda blob: copy.deepcopy(self.blobs.get(blob))),
                   patch.object(app, "update_json_blob", side_effect=update),
                   patch.object(app, "load_project_names", return_value={"A": {"name": "Nombre actual"}}),
                   patch.object(app, "load_access_config", return_value={"groups": {"equipo-ti": {"members": self.members}}}),
                   patch.object(app, "require_perms", return_value=({"email": self.members[0]}, None))]
        for mock in patches:
            mock.start()
            self.addCleanup(mock.stop)

    def call(self, code=None, body=None, method=None):
        req = func.HttpRequest(method=method or ("POST" if code else "GET"),
                               url=f"http://local/api/review/{code or ''}",
                               route_params={"code": code} if code else {},
                               body=json.dumps(body).encode() if body is not None else b"")
        endpoint = app.post_review if code else app.get_review
        response = endpoint.build().get_user_function()(req)
        return response.status_code, json.loads(response.get_body())

    def test_union_base_extra_and_current_names(self):
        self.blobs[app.review_blob_name()] = {"extra": ["A", "C", "C"], "projects": {"A": {"note": "Clasificar"}}}
        status, result = self.call()
        self.assertEqual(status, 200)
        self.assertEqual([p["code"] for p in result["projects"]], ["A", "B", "C"])
        a, b, c = result["projects"]
        self.assertEqual((a["name"], a["photoCount"], a["videoCount"], a["weeks"]), ("Nombre actual", 12, 3, 4))
        self.assertEqual(a["note"], "Clasificar")
        self.assertFalse(a["extra"])
        self.assertTrue(c["extra"])
        self.assertEqual(result["assignees"], sorted(self.members))
        self.assertEqual(result["availableProjects"][0]["name"], "Nombre actual")

    def test_missing_project_stays_in_checklist(self):
        status, result = self.call()
        missing = result["projects"][1]
        self.assertEqual(status, 200)
        self.assertEqual((missing["code"], missing["name"], missing["missing"]), ("B", "Base B", True))
        self.assertEqual((missing["photoCount"], missing["videoCount"], missing["weeks"]), (0, 0, 0))
        self.assertEqual(missing["status"], "pendiente")
        self.assertEqual(self.call("B", {"status": "en-revision"})[0], 200)

    def test_round_robin_skips_assigned_and_deduplicates(self):
        data = {"extra": ["C", "D"], "projects": {"A": {"assignee": self.members[1], "note": "Conservar"}}}
        self.blobs[app.review_blob_name()] = data
        status, result = self.call("assign", {"codes": ["A", "B", "B", "C", "D"],
                                              "assignees": self.members, "onlyUnassigned": True})
        self.assertEqual(status, 200)
        states = result["projects"]
        self.assertEqual([states[c]["assignee"] for c in ["A", "B", "C", "D"]],
                         [self.members[1], self.members[0], self.members[1], self.members[0]])
        self.assertEqual(states["A"]["note"], "Conservar")
        self.assertEqual(states["B"]["updatedBy"], self.members[0])
        status, result = self.call("assign", {"codes": ["A"], "assignees": [self.members[0]]})
        self.assertEqual((status, result["projects"]["A"]["assignee"]), (200, self.members[0]))

    def test_assignee_outside_group_is_rejected(self):
        for code, body in [("A", {"assignee": "externo@ripconciv.com"}),
                           ("assign", {"codes": ["A"], "assignees": ["externo@ripconciv.com"]}),
                           ("assign", {"codes": ["A"], "assignees": [""]})]:
            with self.subTest(code=code, body=body):
                self.assertEqual(self.call(code, body)[0], 400)
        self.assertEqual(self.writes, 0)
        self.assertEqual(self.call("A", {"assignee": " UNO@RIPCONCIV.COM "})[1]["projects"]["A"]["assignee"], self.members[0])
        self.assertEqual(self.call("A", {"assignee": ""})[1]["projects"]["A"]["assignee"], "")

    def test_review_timestamp_and_reviewer_survive_note_edits(self):
        status, result = self.call("A", {"status": "revisado"})
        reviewed = result["projects"]["A"]
        self.assertEqual(status, 200)
        self.assertTrue(reviewed["reviewedAt"])
        self.assertEqual(reviewed["reviewedBy"], self.members[0])
        with patch.object(app, "require_perms", return_value=({"email": self.members[1]}, None)):
            edited = self.call("A", {"note": "Depurado y etiquetado"})[1]["projects"]["A"]
        self.assertEqual(edited["reviewedAt"], reviewed["reviewedAt"])
        self.assertEqual(edited["reviewedBy"], self.members[0])
        self.assertEqual(edited["updatedBy"], self.members[1])
        self.assertEqual(self.call("A", {"status": "revisado"})[1]["projects"]["A"]["reviewedAt"], reviewed["reviewedAt"])
        undone = self.call("A", {"status": "pendiente"})[1]["projects"]["A"]
        self.assertIsNone(undone["reviewedAt"])
        self.assertIsNone(undone["reviewedBy"])

    def test_extra_add_remove_and_validation(self):
        self.assertEqual(self.call("extra", {"add": ["C", "C", "A"]})[1]["extra"], ["C"])
        self.assertEqual(self.call("C", {"note": "Extra"})[0], 200)
        self.assertEqual(self.call("extra", {"remove": ["C"]})[1]["extra"], [])
        self.assertEqual(self.call("C", {"note": "Fuera"})[0], 400)
        self.assertEqual(self.call("extra", {"add": ["NO_EXISTE"]})[0], 400)
        self.assertEqual(self.call("extra", {"remove": ["A"]})[0], 400)
        self.assertEqual(self.call("assign", {"codes": ["NO_EXISTE"], "assignees": self.members})[0], 400)

    def test_invalid_patch_and_inputs(self):
        for body in ([], {}, {"status": "otro"}, {"note": "x" * 501}, {"note": None},
                     {"assignee": []}, {"reviewedAt": "inventado"}):
            with self.subTest(body=body):
                self.assertEqual(self.call("A", body)[0], 400)
        self.assertEqual(self.call("A", {"note": "á" * 500})[0], 200)
        for body in ({"codes": "A", "assignees": self.members}, {"codes": ["A"], "assignees": []},
                     {"codes": ["A"], "assignees": self.members, "onlyUnassigned": "true"}):
            self.assertEqual(self.call("assign", body)[0], 400)

    def test_permission_required_before_storage(self):
        with patch.object(app, "require_perms", return_value=(None, app.err("Sin permiso", 403))) as auth, \
             patch.object(app, "load_json_blob") as read:
            for code in (None, "A", "assign", "extra"):
                self.assertEqual(self.call(code, {})[0], 403)
            read.assert_not_called()
            self.assertTrue(all(call.kwargs == {"cap": "review"} for call in auth.call_args_list))
        self.assertEqual(self.writes, 0)

    def test_index_unavailable_is_not_a_list_of_missing_projects(self):
        self.blobs.pop(app.index_projects_blob_name())
        self.assertEqual(self.call()[0], 503)
        self.assertEqual(self.call("extra", {"add": ["C"]})[0], 503)

    def test_transform_preserves_other_projects_and_blob_fields(self):
        original = {"extra": ["C"], "projects": {"B": {"note": "Otro trabajo"}}}
        saved = app.update_review_state(original, "A", {"note": "Mi trabajo"}, self.members[0], "ahora")
        self.assertEqual(saved["extra"], ["C"])
        self.assertEqual(saved["projects"]["B"], original["projects"]["B"])
        self.assertNotIn("A", original["projects"])


if __name__ == "__main__":
    unittest.main()
