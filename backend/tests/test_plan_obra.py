"""Planificación sin red: índices y clientes falsos, sin cuenta de Azure."""
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import unquote
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import uploader


BASE = "28002_obra/tramo"
WEEK = f"{BASE}/2024_S07"


def indice_vacio():
    return {"rutas": {}, "origenes": set(), "rutas_origen": {}, "con_origen": set(), "maximos": {}}


def archivo(name="foto_20240215.jpg", size=200):
    return {"name": name, "size": size}


class PlanObraTests(unittest.TestCase):
    def plan(self, files, indice=None):
        return uploader.planificar_obra(files, BASE, "FOT", indice if indice is not None else indice_vacio())

    def test_compatibilidad_archivo_antiguo_por_tamano(self):
        indice = indice_vacio()
        ruta = f"{WEEK}/FOT_20240215_001.jpg"
        indice["rutas"][ruta] = 200
        indice["maximos"]["FOT_20240215"] = 1
        row, = self.plan([archivo()], indice)
        self.assertEqual((row["status"], row["blobPath"]), ("existe", ruta))

    def test_remoto_ya_migrado_sin_carpeta_no_se_duplica(self):
        # Antes la fecha remota ignoraba la carpeta; ahora la usa. Lo ya migrado
        # con la regla antigua (fecha de modificación) debe seguir reconocido.
        item = {"name": "IMG_1.jpg", "size": 500, "relativePath": "Visita 2024-03-01",
                "lastModifiedDateTime": "2024-02-15T10:00:00Z"}
        indice = indice_vacio()
        indice["rutas"][f"{WEEK}/FOT_20240215_001.jpg"] = 500
        self.assertEqual(self.plan([item], indice)[0]["status"], "existe")
        nuevo = self.plan([item])[0]
        self.assertEqual(nuevo["blobPath"], f"{BASE}/2024_S09/FOT_20240301_001.jpg")

    def test_nueva_foto_continua_en_004(self):
        indice = indice_vacio()
        indice["rutas"] = {f"{WEEK}/FOT_20240215_{n:03d}.jpg": 100 for n in range(1, 4)}
        indice["maximos"]["FOT_20240215"] = 3
        row, = self.plan([archivo("nueva_20240215.jpg")], indice)
        self.assertEqual(row["status"], "nuevo")
        self.assertEqual(row["blobPath"], f"{WEEK}/FOT_20240215_004.jpg")

    def test_metadata_omite_aunque_cambie_el_conjunto(self):
        indice = indice_vacio()
        origen = uploader.clave_origen("FOTO_20240215.JPG", 200)
        ruta = f"{WEEK}/FOT_20240215_003.jpg"
        indice["origenes"].add(origen)
        indice["rutas_origen"][origen] = ruta
        row, = self.plan([archivo()], indice)
        self.assertEqual((row["status"], row["blobPath"]), ("existe", ruta))

    def test_duplicados_solo_un_nuevo(self):
        rows = self.plan([archivo(), archivo("FOTO_20240215.JPG")])
        self.assertEqual([r["status"] for r in rows], ["nuevo", "omitido"])
        self.assertIn("duplicado", rows[1]["reason"])

    def test_mismo_nombre_otro_tamano_es_nuevo(self):
        rows = self.plan([archivo(size=200), archivo(size=201)])
        self.assertEqual([r["status"] for r in rows], ["nuevo", "nuevo"])
        self.assertEqual(rows[1]["finalName"], "FOT_20240215_002.jpg")

    def test_lastmodified_sin_fecha_siempre_por_semana(self):
        dt = datetime(2024, 2, 15, tzinfo=timezone.utc)
        row, = self.plan([{**archivo("sin fecha.jpg"), "lastModified": dt.timestamp() * 1000, "keepNames": True}])
        self.assertEqual(row["blobPath"], f"{WEEK}/FOT_20240215_001.jpg")
        self.assertNotIn("General", row["blobPath"])

    def test_metadata_ascii_y_basename(self):
        meta = uploader.metadata_origen("carpeta/Árbol del río.jpg", 123)
        self.assertTrue(meta["srcname"].isascii())
        self.assertIn("%20", meta["srcname"])
        self.assertEqual(unquote(meta["srcname"]), "Árbol del río.jpg")
        self.assertEqual(meta["srcsize"], "123")
        self.assertEqual(uploader.clave_origen("C:\\Fotos\\ÁRBOL.JPG", 123), ("árbol.jpg", 123))

    def test_no_compatibilidad_si_blob_tiene_otro_origen(self):
        indice = indice_vacio()
        ruta = f"{WEEK}/FOT_20240215_001.jpg"
        indice["rutas"][ruta] = 200
        indice["con_origen"].add(ruta)
        indice["maximos"]["FOT_20240215"] = 1
        row, = self.plan([archivo()], indice)
        self.assertEqual((row["status"], row["finalName"]), ("nuevo", "FOT_20240215_002.jpg"))

    def test_no_colisiona_ni_con_indice_maximo_incompleto(self):
        indice = indice_vacio()
        indice["rutas"][f"{WEEK}/FOT_20240215_001.jpg"] = 100
        rows = self.plan([archivo(), archivo("otra_20240215.jpg")], indice)
        self.assertEqual([r["finalName"] for r in rows], ["FOT_20240215_002.jpg", "FOT_20240215_003.jpg"])
        self.assertEqual(indice["maximos"], {})  # No muta el índice recibido.

    def test_office_omitido_y_prefijos_respetados(self):
        rows = uploader.planificar_obra([archivo("doc_20240215.pdf"), archivo("img_20240215.jpeg"), archivo("img_20240215.jpg")], BASE, "DRN", indice_vacio())
        self.assertEqual(rows[0]["status"], "omitido")
        self.assertEqual(rows[1]["finalName"], "FOT_20240215_001.jpeg")
        self.assertEqual(rows[2]["finalName"], "DRN_20240215_001.jpg")

    def test_semana_usa_ano_iso(self):
        row, = self.plan([archivo("img_20210101.jpg")])
        self.assertIn("/2020_S53/", row["blobPath"])

    def test_preparar_trabajos_reutiliza_plan_y_metadata(self):
        files = [{**archivo(), "id": "item", "parentReference": {"driveId": "drive"}}]
        jobs = uploader._preparar_trabajos(files, BASE, "FOT", indice_vacio())
        self.assertEqual(jobs[0]["status"], "nuevo")
        self.assertEqual(jobs[0]["metadata"], uploader.metadata_origen(files[0]["name"], 200))
        self.assertEqual(jobs[0]["blob_path"], f"{WEEK}/FOT_20240215_001.jpg")

    def test_indice_un_solo_listado_con_metadata_y_maximos(self):
        ruta = f"{WEEK}/FOT_20240215_1001.jpg"
        blobs = [SimpleNamespace(name=ruta, size=123, metadata=uploader.metadata_origen("Árbol.jpg", 123)),
                 SimpleNamespace(name=f"{WEEK}/FOT_20240215_002.jpg", size=55, metadata={})]
        container = Mock()
        container.list_blobs.return_value = blobs
        svc = Mock()
        svc.get_container_client.return_value = container
        indice = uploader.construir_indice_origen(svc, f"{BASE}/")
        container.list_blobs.assert_called_once_with(name_starts_with=f"{BASE}/", include=["metadata"])
        self.assertEqual(indice["maximos"], {"FOT_20240215": 1001})
        self.assertIn(("árbol.jpg", 123), indice["origenes"])
        self.assertEqual(indice["rutas"][ruta], 123)
        self.assertEqual(indice["con_origen"], {ruta})

    def test_copia_fallida_no_cuenta_como_origen_subido(self):
        ruta = f"{WEEK}/FOT_20240215_001.jpg"
        container = Mock()
        container.list_blobs.return_value = [SimpleNamespace(name=ruta, size=0, metadata=uploader.metadata_origen("foto.jpg", 123), copy=SimpleNamespace(status="failed"))]
        svc = Mock()
        svc.get_container_client.return_value = container
        indice = uploader.construir_indice_origen(svc, BASE)
        self.assertFalse(indice["origenes"])
        self.assertEqual(indice["maximos"]["FOT_20240215"], 1)

    def test_subida_path_y_bloques_guardan_metadata(self):
        meta = uploader.metadata_origen("Árbol del río.jpg", 3)
        container = Mock()
        svc = Mock()
        svc.get_container_client.return_value = container
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "foto.jpg"
            path.write_bytes(b"abc")
            uploader._subir_a_blob_desde_path(svc, str(path), "destino.jpg", metadata=meta)
            self.assertEqual(container.upload_blob.call_args.kwargs["metadata"], meta)
            uploader._upload_file_in_blocks(container, "destino.jpg", str(path), "image/jpeg", metadata=meta)
        committed = container.get_blob_client.return_value.commit_block_list.call_args.kwargs
        self.assertEqual(committed["metadata"], meta)
        self.assertNotIn("etag", committed)

    def test_streaming_por_url_planifica_semana_y_continua_secuencia(self):
        indice = indice_vacio()
        indice["maximos"]["FOT_20240215"] = 3
        events = Mock()
        with patch.object(uploader, "construir_indice_origen", return_value=indice), \
             patch.object(uploader, "_resolve_download_url", return_value=("https://falso", "foto_20240215.jpg")), \
             patch.object(uploader, "_download_stream_to_tempfile", return_value=("foto_20240215.jpg", "image/jpeg", 200)), \
             patch.object(uploader, "_upload_file_in_blocks") as upload:
            result = uploader.upload_urls_with_progress(Mock(), "28002", "obra", ["https://falso"], events)
        self.assertEqual(result["uploaded"], 1)
        self.assertEqual(upload.call_args.args[1], "28002_obra/2024_S07/FOT_20240215_004.jpg")
        self.assertEqual(upload.call_args.kwargs["metadata"], uploader.metadata_origen("foto_20240215.jpg", 200))


if __name__ == "__main__":
    unittest.main()
