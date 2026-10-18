from __future__ import annotations

import html
import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
import sys
sys.path.insert(0, str(ROOT))

import topo  # noqa: E402


def sample_graph() -> dict:
    return {
        "schema_version": "1.0",
        "devices": [
            {
                "id": "h1",
                "type": "host",
                "label": "__TITLE__",
                "ips": ["10.0.0.11"],
                "meta": {"fabric": 'A" onmouseover="alert(1)'},
                "ports": [{"id": "h1::p1", "label": "p1", "wwn": "10:00:00:00:00:00:00:01"}],
            },
            {
                "id": "sw1",
                "type": "switch",
                "label": "sw1",
                "ips": ["10.0.0.1"],
                "meta": {"layer": 1},
                "ports": [{"id": "sw1::1", "label": "1"}, {"id": "sw1::2", "label": "2"}],
            },
            {
                "id": "st1",
                "type": "storage",
                "label": 'storage</script><script>alert(1)</script>',
                "ips": ["10.0.0.21"],
                "meta": {
                    "vendor": "<img src=x onerror=alert(2)>",
                    "model": "<script>alert(3)</script>",
                },
                "ports": [{"id": "st1::p1", "label": "p1"}],
            },
        ],
        "links": [
            {
                "a": {"device": "h1", "port": "h1::p1"},
                "b": {"device": "sw1", "port": "sw1::1"},
                "kind": "host",
                "status": "up",
            },
            {
                "a": {"device": "sw1", "port": "sw1::2"},
                "b": {"device": "st1", "port": "st1::p1"},
                "kind": "storage",
                "status": "up",
            },
        ],
        "warnings": [{"level": 'info" onmouseover="alert(4)', "msg": "<svg onload=alert(5)>"}],
    }


@unittest.skipUnless(shutil.which("cargo"), "cargo is not installed")
class RustDifferentialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.binary = ROOT / "rust/topo-render/target/debug/topo-render"
        subprocess.run(
            ["cargo", "build", "--quiet", "--manifest-path", str(ROOT / "rust/topo-render/Cargo.toml")],
            cwd=ROOT,
            check=True,
        )
        if not cls.binary.exists():
            raise unittest.SkipTest("Rust renderer binary is not available")

    def test_semantic_render_parity(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            graph = topo.normalize_graph(sample_graph())
            graph_path = d / "graph.json"
            graph_path.write_text(json.dumps(graph, ensure_ascii=False), encoding="utf-8")
            title = 'Differential </title><script>alert(1)</script> & "quote"'

            py_html = topo.render_html(graph, ROOT, title)
            rust_html_path = d / "rust.html"
            subprocess.run(
                [
                    str(self.binary),
                    "--graph", str(graph_path),
                    "-o", str(rust_html_path),
                    "--title", title,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            rust_html = rust_html_path.read_text(encoding="utf-8")

            for name, html_text in (("python", py_html), ("rust", rust_html)):
                self.assertEqual(html_text.count("</script>"), 3, name)
                self.assertNotIn("window.__GRAPH__ = /*__GRAPH__*/", html_text, name)
                for token in ("/*__STYLE__*/", "/*__VIS__*/", "/*__APP__*/", "/*__GRAPH__*/"):
                    self.assertNotIn(token, html_text, f"{name} leftover {token}")
                self.assertNotIn("<title>__TITLE__</title>", html_text, name)
                self.assertNotIn("<h1>__TITLE__</h1>", html_text, name)

            py_title = re.search(r"<title>(.*?)</title>", py_html, re.S).group(1)
            rust_title = re.search(r"<title>(.*?)</title>", rust_html, re.S).group(1)
            self.assertEqual(py_title, rust_title)
            self.assertEqual(html.unescape(py_title), title)

            py_graph = re.search(r"window\.__GRAPH__\s*=\s*(\{.*?\});</script>", py_html, re.S).group(1)
            rust_graph = re.search(r"window\.__GRAPH__\s*=\s*(\{.*?\});</script>", rust_html, re.S).group(1)
            self.assertEqual(json.loads(py_graph), json.loads(rust_graph))
            self.assertEqual(json.loads(rust_graph), graph)


if __name__ == "__main__":
    unittest.main()
