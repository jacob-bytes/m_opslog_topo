"""CMDB JSON → topology graph adapter example.

Input shape (all fields except devices are optional):

{
  "generated_at": "2026-01-01T00:00:00Z",
  "devices": [
    {
      "id": "host-01",              # optional, defaults from type + name
      "type": "host",               # host / switch / storage / unknown
      "label": "host-01",           # or name
      "ips": ["10.0.0.11"],
      "wwn": "10:00:...",           # optional device WWN
      "meta": {"site": "dc-a", "fabric": "A", "vendor": "Huawei"},
      "ports": [{"label": "p1", "wwn": "10:00:..."}]
    }
  ],
  "links": [
    {"a": "host-01:p1", "b": "sw-01:1", "kind": "host", "status": "up"},
    {"a": {"device": "host-01", "port": "p1"},
     "b": {"device": "sw-01", "port": "1"}, "status": "up"}
  ]
}

Run:
  python3 topo.py --adapter adapters/cmdb_json.py --adapter-input sample/cmdb.json -o topology.html
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


TYPE_MAP = {
    "host": "host", "server": "host", "主机": "host",
    "switch": "switch", "san_switch": "switch", "交换机": "switch",
    "storage": "storage", "array": "storage", "nas": "storage", "存储": "storage",
}


def _slug(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        raw = "device"
    return raw


def _port_id(device_id: str, label: str) -> str:
    return f"{device_id}::port::{label}"


def _parse_endpoint(value: Any, devices_by_name: Dict[str, Dict[str, Any]],
                    ports_by_name: Dict[Tuple[str, str], Dict[str, Any]]) -> Dict[str, Any]:
    if isinstance(value, dict):
        dev = str(value.get("device") or value.get("id") or "").strip()
        port = str(value.get("port") or value.get("port_label") or "").strip()
    else:
        raw = str(value or "").strip()
        dev, sep, port = raw.rpartition(":")
        if not sep:
            dev, port = raw, ""
    target = devices_by_name.get(dev)
    if not target:
        raise ValueError(f"链路端点找不到设备: {value!r}")
    if not port:
        return {"device": target["id"], "port": None, "wwn": None}
    p = ports_by_name.get((target["id"], port))
    if not p:
        # 允许 CMDB 只给端口标签，自动补一个空端口
        p = {"id": _port_id(target["id"], port), "label": port, "wwn": None}
    return {"device": target["id"], "port": p["id"], "wwn": p.get("wwn")}


def build(input_path: Optional[str] = None) -> Dict[str, Any]:
    if not input_path:
        raise ValueError("CMDB 适配器需要 --adapter-input 指向 JSON 文件")
    path = Path(input_path)
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("CMDB JSON 根节点必须是对象")

    devices: List[Dict[str, Any]] = []
    by_name: Dict[str, Dict[str, Any]] = {}
    ports_by_name: Dict[Tuple[str, str], Dict[str, Any]] = {}

    for i, raw in enumerate(data.get("devices") or []):
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("label") or raw.get("name") or raw.get("id") or f"device-{i + 1}")
        dtype = TYPE_MAP.get(str(raw.get("type") or "host").strip().lower())
        if not dtype:
            dtype = "host"
        dev_id = str(raw.get("id") or (dtype + ":" + name))
        dev = {
            "id": dev_id,
            "type": dtype,
            "label": name,
            "wwn": raw.get("wwn"),
            "ips": [str(x) for x in (raw.get("ips") or ([raw["ip"]] if raw.get("ip") else []))],
            "meta": dict(raw.get("meta") or {}),
            "ports": [],
        }
        for j, p in enumerate(raw.get("ports") or []):
            if not isinstance(p, dict):
                continue
            label = str(p.get("label") or p.get("name") or p.get("port") or f"p{j + 1}")
            port = {
                "id": str(p.get("id") or _port_id(dev_id, label)),
                "label": label,
                "wwn": p.get("wwn") or p.get("wwpn"),
                "connected": bool(p.get("connected", False)),
                "unused": bool(p.get("unused", False)),
            }
            dev["ports"].append(port)
            ports_by_name[(dev_id, label)] = port
        devices.append(dev)
        by_name[name] = dev
        by_name[dev_id] = dev

    links: List[Dict[str, Any]] = []
    for raw in data.get("links") or []:
        if not isinstance(raw, dict):
            continue
        a = _parse_endpoint(raw.get("a") or raw.get("from"), by_name, ports_by_name)
        b = _parse_endpoint(raw.get("b") or raw.get("to"), by_name, ports_by_name)
        da, db = by_name.get(a["device"]), by_name.get(b["device"])
        kind = raw.get("kind")
        if not kind:
            types = {da["type"] if da else "", db["type"] if db else ""}
            if "storage" in types:
                kind = "storage"
            elif types == {"switch"}:
                kind = "switch"
            elif "host" in types:
                kind = "host"
            else:
                kind = "unknown"
        links.append({
            "a": a, "b": b, "kind": kind,
            "status": raw.get("status") or raw.get("state") or "unknown",
            "speed": raw.get("speed"),
            "source": raw.get("source") or f"cmdb:{path.name}",
        })

    # Mark ports touched by a link as connected, so the UI's port counts are meaningful.
    touched = set()
    for link in links:
        for ep in (link["a"], link["b"]):
            if ep.get("port"):
                touched.add(ep["port"])
    for dev in devices:
        for p in dev["ports"]:
            if p["id"] in touched:
                p["connected"] = True

    return {
        "schema_version": "1.0",
        "generated_at": data.get("generated_at") or "",
        "meta": {"title": data.get("title") or "CMDB topology", "source": "cmdb"},
        "sources": {"config": [str(path)], "logs": []},
        "devices": devices,
        "links": links,
        "warnings": [],
    }
