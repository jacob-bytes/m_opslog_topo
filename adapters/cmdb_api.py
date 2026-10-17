"""API adapter example: fetch a CMDB endpoint and reuse the CMDB JSON mapping.

The endpoint should return the same JSON shape documented in cmdb_json.py.
For a different response shape, replace the mapping logic in cmdb_json.py or
add your own adapter module and return a graph dict.

Run:
  python3 topo.py --adapter adapters/cmdb_api.py \
    --adapter-input https://cmdb.example/api/topology -o topology.html
"""

from __future__ import annotations

import json
import os
import tempfile
import urllib.request
from typing import Any, Dict, Optional

from adapters.cmdb_json import build as build_cmdb_json


def build(input_url: Optional[str] = None) -> Dict[str, Any]:
    if not input_url:
        raise ValueError("API 适配器需要 --adapter-input 指向 API URL")
    req = urllib.request.Request(input_url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as resp:  # noqa: S310 - caller-controlled URL
        data = json.loads(resp.read().decode("utf-8"))

    # Reuse the documented CMDB JSON mapping without duplicating the transform.
    fd, tmp_name = tempfile.mkstemp(prefix="topo-cmdb-api-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False)
        payload = build_cmdb_json(tmp_name)
        payload.setdefault("sources", {})["config"] = [input_url]
        return payload
    finally:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
