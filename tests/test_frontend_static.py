from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class FrontendHardeningMarkers(unittest.TestCase):
    def setUp(self):
        self.app = (ROOT / "template" / "app.js").read_text(encoding="utf-8")

    def test_filter_key_is_escaped(self):
        self.assertIn("data-fclear=\"' + esc(c.key) + '\"", self.app)

    def test_warning_level_is_whitelisted(self):
        self.assertIn("['info', 'warn', 'error'].indexOf(w.level)", self.app)
        self.assertIn("'<div class=\"warn-item ' + level", self.app)

    def test_csv_formula_guard(self):
        self.assertIn("if (/^[=+\\-@\\t\\r]/.test(v)) v = \"'\" + v;", self.app)

    def test_download_filename_is_sanitized(self):
        self.assertIn("a.download = safeDownloadName(", self.app)


if __name__ == "__main__":
    unittest.main()
