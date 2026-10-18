"""API adapter example: fetch a CMDB endpoint and reuse the CMDB JSON mapping.

The endpoint should return the same JSON shape documented in cmdb_json.py.
For a different response shape, replace the mapping logic in cmdb_json.py or
add your own adapter module and return a graph dict.

Run:
  python3 topo.py --adapter adapters/cmdb_api.py \
    --adapter-input https://cmdb.example/api/topology -o topology.html
"""

from __future__ import annotations

import ipaddress
import json
import os
import socket
import tempfile
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

from adapters.cmdb_json import build as build_cmdb_json

MAX_RESPONSE_BYTES = 8 * 1024 * 1024


def _validate_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme.lower() not in ("http", "https"):
        raise ValueError("CMDB API 只允许 http/https URL，拒绝 file/ftp 等协议")
    host = parsed.hostname
    if not host:
        raise ValueError("CMDB API URL 缺少主机名")
    if os.environ.get("TOPO_ALLOW_PRIVATE_URL") != "1":
        if host.lower() in ("localhost", "localhost.localdomain"):
            raise ValueError("CMDB API 拒绝 localhost；内部服务请显式设置 TOPO_ALLOW_PRIVATE_URL=1")
        try:
            infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
        except OSError:
            infos = []
        for info in infos:
            try:
                ip = ipaddress.ip_address(info[4][0])
            except ValueError:
                continue
            if (ip.is_private or ip.is_loopback or ip.is_link_local or
                    ip.is_reserved or ip.is_multicast or ip.is_unspecified):
                raise ValueError(
                    "CMDB API 拒绝私网/回环地址；内部服务请显式设置 TOPO_ALLOW_PRIVATE_URL=1"
                )
    return url


def _read_limited(resp: Any) -> bytes:
    length = resp.headers.get("Content-Length") if getattr(resp, "headers", None) else None
    if length:
        try:
            declared = int(length)
        except (TypeError, ValueError):
            declared = None
        if declared is not None and declared > MAX_RESPONSE_BYTES:
            raise ValueError(f"CMDB API 响应超过上限 {MAX_RESPONSE_BYTES} 字节")
    raw = resp.read(MAX_RESPONSE_BYTES + 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ValueError(f"CMDB API 响应超过上限 {MAX_RESPONSE_BYTES} 字节")
    return raw


def build(input_url: Optional[str] = None) -> Dict[str, Any]:
    if not input_url:
        raise ValueError("API 适配器需要 --adapter-input 指向 API URL")
    input_url = _validate_url(input_url)
    req = urllib.request.Request(input_url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as resp:  # noqa: S310 - caller-controlled URL
        _validate_url(resp.geturl())
        raw = _read_limited(resp)
        data = json.loads(raw.decode("utf-8"))

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
