from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import topo  # noqa: E402
from adapters.cmdb_api import _validate_url  # noqa: E402


def minimal_payload() -> dict:
    return {
        "schema_version": "1.0",
        "devices": [
            {
                "id": "host-01",
                "type": "host",
                "label": "host-01",
                "ips": ["10.0.0.1"],
                "meta": {"fabric": "A"},
                "ports": [{"id": "host-01::p1", "label": "p1", "wwn": "10:00:00:00:00:00:00:01"}],
            },
            {
                "id": "sw-01",
                "type": "switch",
                "label": "sw-01",
                "ips": [],
                "meta": {"layer": 1},
                "ports": [{"id": "sw-01::1", "label": "1"}],
            },
        ],
        "links": [
            {
                "a": {"device": "host-01", "port": "host-01::p1"},
                "b": {"device": "sw-01", "port": "sw-01::1"},
                "kind": "host",
                "status": "up",
            }
        ],
        "warnings": [],
    }


class RenderHardeningTests(unittest.TestCase):
    def test_title_is_escaped(self):
        payload = topo.normalize_graph(minimal_payload())
        html = topo.render_html(payload, ROOT, "</title><script>alert(1)</script>")
        self.assertIn("<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>", html)
        self.assertNotIn("<title></title><script>alert(1)</script>", html)

    def test_template_fill_does_not_rescan_graph(self):
        payload = minimal_payload()
        payload["devices"][0]["label"] = "__TITLE__"
        payload = topo.normalize_graph(payload)
        html = topo.render_html(payload, ROOT, "Real Title")
        match = re.search(r"window\.__GRAPH__\s*=\s*(\{.*?\});</script>", html, re.S)
        self.assertIsNotNone(match)
        graph = json.loads(match.group(1))
        self.assertEqual(graph["devices"][0]["label"], "__TITLE__")
        self.assertIn("<title>Real Title</title>", html)

    def test_graph_closing_script_is_escaped(self):
        payload = minimal_payload()
        payload["devices"][0]["label"] = "host</script><script>alert(1)</script>"
        payload = topo.normalize_graph(payload)
        html = topo.render_html(payload, ROOT, "safe")
        self.assertEqual(html.count("</script>"), 3)
        self.assertIn("<\\/script>", html)

    def test_title_limit(self):
        payload = topo.normalize_graph(minimal_payload())
        with self.assertRaises(ValueError):
            topo.render_html(payload, ROOT, "x" * 10, max_title=5)

    def test_placeholders_are_all_replaced(self):
        payload = topo.normalize_graph(minimal_payload())
        html = topo.render_html(payload, ROOT, "safe")
        for token in ("/*__STYLE__*/", "/*__VIS__*/", "/*__APP__*/", "/*__GRAPH__*/", "__TITLE__"):
            self.assertNotIn(token, html)


class NormalizeHardeningTests(unittest.TestCase):
    def test_warning_level_is_whitelisted(self):
        payload = minimal_payload()
        payload["warnings"] = [{"level": 'info" onmouseover="alert(1)', "msg": "x"}]
        data = topo.normalize_graph(payload)
        self.assertEqual(data["warnings"][0]["level"], "info")

    def test_duplicate_device_ids_are_ignored(self):
        payload = minimal_payload()
        payload["devices"].append(dict(payload["devices"][0]))
        data = topo.normalize_graph(payload)
        self.assertEqual(len(data["devices"]), 2)
        self.assertTrue(any("id 重复" in w["msg"] for w in data["warnings"]))

    def test_max_devices(self):
        payload = minimal_payload()
        with self.assertRaises(ValueError):
            topo.normalize_graph(payload, max_devices=1)

    def test_max_links(self):
        payload = minimal_payload()
        with self.assertRaises(ValueError):
            topo.normalize_graph(payload, max_links=0)

    def test_redact_paths(self):
        payload = minimal_payload()
        payload["sources"] = {
            "config": "/secret/site/config.txt",
            "logs": ["/secret/site/sw-01.txt"],
        }
        data = topo.normalize_graph(payload, redact_paths=True)
        self.assertEqual(data["sources"]["config"], "config.txt")
        self.assertEqual(data["sources"]["logs"], ["sw-01.txt"])


class IoHardeningTests(unittest.TestCase):
    def test_read_text_limit(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "big.txt"
            p.write_text("0123456789", encoding="utf-8")
            with self.assertRaises(ValueError):
                topo.read_text(p, max_bytes=5)

    def test_atomic_write_mode(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "out.html"
            topo.atomic_write_text(p, "hello")
            self.assertEqual(p.read_text(encoding="utf-8"), "hello")
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)
            self.assertEqual([x.name for x in Path(d).iterdir()], ["out.html"])

    def test_adapter_rejects_file_and_loopback(self):
        with self.assertRaises(ValueError):
            _validate_url("file:///etc/passwd")
        with self.assertRaises(ValueError):
            _validate_url("http://127.0.0.1/x")
        with self.assertRaises(ValueError):
            _validate_url("http://localhost/x")


if __name__ == "__main__":
    unittest.main()
