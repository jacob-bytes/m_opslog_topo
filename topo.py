#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
topo.py —— 存储 / SAN 网络拓扑图生成器

输入
----
1. 交换机日志（*.txt，一台交换机一个文件）
2. config.txt（主机 + 存储阵列信息）

输出
----
一个自包含的 HTML 文件（离线可用，JS 库与数据全部内联）：
  * 设备视图 / 端口视图两种粒度
  * 按设备类型、链路类型、交换机、状态、关键字筛选
  * 搜索、邻居聚焦、两点间路径分析、PNG 导出
  * 未识别 WWN、解析告警展示

用法
----
    python3 topo.py --config sample/config.txt --logs sample/logs -o topology.html
    python3 topo.py --config config.txt --logs ./logs --dump      # 只打印解析结果
"""

from __future__ import annotations

import argparse
import html as html_lib
import importlib
import importlib.util
import json
import os
import re
import sys
import tempfile
import webbrowser
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

# ---------------------------------------------------------------------------
# 常量 / 正则
# ---------------------------------------------------------------------------

WWN_PATTERN = r"(?:0x)?(?:[0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){7}|[0-9a-fA-F]{16})"
WWN_RE = re.compile(rf"(?<![0-9a-fA-F]){WWN_PATTERN}(?![0-9a-fA-F])")
IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")

TYPE_ALIASES = {
    "host": {"host", "hosts", "server", "servers", "node", "compute", "esxi", "主机", "服务器"},
    "switch": {"switch", "switches", "sw", "fabric", "brocade", "cisco", "交换机", "光纤交换机"},
    "storage": {"storage", "storages", "array", "arrays", "san", "disk", "磁盘阵列", "存储", "存储阵列"},
}
TYPE_LABEL = {"host": "主机", "switch": "交换机", "storage": "存储", "unknown": "未识别"}
SCHEMA_VERSION = "1.0"

# 防御性默认上限。真实数据量大时用 CLI 参数显式放开。
DEFAULT_MAX_LOG_BYTES = 64 * 1024 * 1024
DEFAULT_MAX_FILES = 1000
DEFAULT_MAX_GRAPH_BYTES = 64 * 1024 * 1024
DEFAULT_MAX_DEVICES = 20000
DEFAULT_MAX_PORTS = 200000
DEFAULT_MAX_LINKS = 500000
DEFAULT_MAX_WARNINGS = 5000
DEFAULT_MAX_TITLE = 200


class LimitError(ValueError):
    """输入/输出超过安全上限。"""

ID_KEYS = {
    "id", "name", "hostname", "host_id", "hostid", "host_name", "storage_id",
    "storageid", "storage_name", "switch_name", "switchname", "device_id",
    "device", "label", "主机", "主机名", "存储", "存储名", "设备", "设备名", "名称",
}
META_KEYS = {
    "site", "fabric", "rack", "group", "tenant", "vendor", "model",
    "站点", "机房", "分组", "租户", "厂商", "型号",
}
TYPE_KEYS = {"type", "kind", "role", "device_type", "devicetype", "category", "类型", "设备类型"}
IP_KEYS = {"ip", "ipaddr", "ip_addr", "ip_address", "mgmt_ip", "mgmtip", "管理ip", "管理_ip"}
PORT_KEYS = {"port", "port_id", "portid", "port_name", "portname", "slot", "端口", "端口号", "口"}

# 交换机日志里表示“本交换机身份”的键
SWITCH_WWN_KEY_RE = re.compile(
    r"(?i)(?:switch[\s_-]*(?:wwn|wwpn)|switchwwn|switchwwpn|交换机[\s_-]*(?:wwn|wwpn)|本机[\s_-]*(?:wwn|wwpn))"
    r"\s*[:=]?\s*(" + WWN_PATTERN + r")"
)
BARE_WWN_KEY_RE = re.compile(r"(?i)^\s*(?:wwn|wwpn)\s*[:=]\s*(" + WWN_PATTERN + r")\s*$")

SWITCH_NAME_RE = re.compile(
    r"(?i)(?:switch[\s_-]*name|switchname|sysname|hostname|交换机名|设备名)\s*[:=]\s*([^\s,;]+)"
)
BARE_NAME_RE = re.compile(r"(?i)^\s*name\s*[:=]\s*([^\s,;]+)")
SWITCH_IP_RE = re.compile(r"(?i)\b(?:ip[\s_-]*address|ipaddr|ip_addr|ip_address|ip|mgmt[\s_-]*ip|管理\s*ip)\s*[:=]?\s*(" + IPV4_RE.pattern + r")")
SWITCH_MODEL_RE = re.compile(r"(?i)(?:model|product|型号|设备型号)\s*[:=]\s*([^\s,;]+)")

# 端口号提取（按优先级）
PORT_PATTERNS = [
    re.compile(r"(?i)\b(?:port|portid|port_id|portno|port_no|if|interface|端口)\s*[:=#]?\s*([A-Za-z]?\d+(?:\s*[/:.]\s*\d+)*)"),
    re.compile(r"(?i)\b((?:fc|eth|ge|xge|te)\s*\d+(?:/\d+)+)"),
    re.compile(r"(?i)\b([A-Za-z]?\d+)\s*(?:号口|口)"),
    re.compile(r"^\s*([A-Za-z]?\d{1,3})\s*(?:[|,\t]|\s{2,})"),
]

PEER_PORT_RE = re.compile(
    r"(?i)(?:peer|remote|opposite|对端|邻居)[\s_-]*(?:port|端口|口)\s*[:=]?\s*([A-Za-z]?\d+(?:\s*[/:.]\s*\d+)*)"
)
PEER_WWN_RE = re.compile(
    r"(?i)(?:peer|remote|opposite|对端|邻居)[\s_-]*(?:wwn|wwpn|device|设备)?\s*[:=]?\s*(" + WWN_PATTERN + r")"
)

STATUS_RE = re.compile(
    r"(?i)\b(?:status|state|状态)\s*[:=]?\s*([A-Za-z_]+|启用|禁用|在线|离线|正常|异常)"
)
SPEED_RE = re.compile(r"(?i)\b(?:speed|rate|速率)\s*[:=]?\s*(\d+(?:\.\d+)?\s*[GMK]?(?:bps|b/s|Gb|G)?)")

UP_WORDS = {"online", "up", "connected", "active", "enable", "enabled", "启用", "在线", "正常"}
DOWN_WORDS = {"offline", "down", "notconnected", "disconnected", "disabled", "disable", "禁用", "离线", "异常"}
UNUSED_WORDS = {
    "no_module", "nomodule", "no module", "notconnected", "no_light", "nolight",
    "no_sfp", "nosfp", "unused", "disabled", "empty", "未使用", "空", "未插", "无模块",
}


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------


@dataclass
class Port:
    id: str
    label: str
    device: str
    wwn: Optional[str] = None
    connected: bool = False
    unused: bool = False
    meta: Dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "label": self.label,
            "device": self.device,
            "wwn": self.wwn,
            "connected": self.connected,
            "unused": self.unused,
        }
        if self.meta:
            out["meta"] = self.meta
        return out


@dataclass
class Device:
    id: str
    type: str
    label: str
    ports: List[Port] = field(default_factory=list)
    wwn: Optional[str] = None          # 交换机自身的 WWN
    ips: List[str] = field(default_factory=list)
    meta: Dict[str, Any] = field(default_factory=dict)
    source: str = ""

    def port_by_wwn(self, wwn: str) -> Optional[Port]:
        for p in self.ports:
            if p.wwn == wwn:
                return p
        return None

    def port_by_label(self, label: str) -> Optional[Port]:
        for p in self.ports:
            if p.label.lower() == label.lower():
                return p
        return None

    def add_port(self, label: Optional[str] = None, wwn: Optional[str] = None, **meta: Any) -> Port:
        if wwn:
            existing = self.port_by_wwn(wwn)
            if existing:
                return existing
        label = (label or "").strip()
        if not label:
            n = 1
            while self.port_by_label(f"p{n}"):
                n += 1
            label = f"p{n}"
        base = label
        n = 2
        while self.port_by_label(label):
            label = f"{base}#{n}"
            n += 1
        pid = f"{self.id}#{label}"
        port = Port(id=pid, label=label, device=self.id, wwn=wwn, meta=dict(meta))
        self.ports.append(port)
        return port

    def to_json(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "type": self.type,
            "label": self.label,
            "ports": [p.to_json() for p in self.ports],
            "wwn": self.wwn,
            "ips": self.ips,
        }
        if self.meta:
            out["meta"] = self.meta
        return out


@dataclass
class Endpoint:
    device: str
    port: Optional[str] = None
    wwn: Optional[str] = None


@dataclass
class Link:
    a: Endpoint
    b: Endpoint
    status: Optional[str] = None
    speed: Optional[str] = None
    source: str = ""

    def endpoints(self) -> Tuple[Endpoint, Endpoint]:
        return self.a, self.b


class Ctx:
    """解析上下文：设备表 + 各类索引 + 告警。"""

    def __init__(
        self,
        max_text_bytes: int = DEFAULT_MAX_LOG_BYTES,
        max_devices: int = DEFAULT_MAX_DEVICES,
        max_warnings: int = DEFAULT_MAX_WARNINGS,
    ) -> None:
        self.devices: Dict[str, Device] = {}
        self.warnings: List[Dict[str, Any]] = []
        self.links: List[Link] = []
        self.sources: List[str] = []
        self.wwn_index: Dict[str, Tuple[Device, Port]] = {}
        self.switch_wwn_index: Dict[str, Device] = {}
        self.max_text_bytes = max_text_bytes
        self.max_devices = max_devices
        self.max_warnings = max_warnings
        self.warnings_truncated = False

    # -- 设备 ------------------------------------------------------------
    def new_device(self, dtype: str, name: str, source: str = "") -> Device:
        if len(self.devices) >= self.max_devices:
            raise LimitError(f"设备数量超过上限 {self.max_devices}，请提高 --max-devices 或检查输入")
        dtype = dtype if dtype in TYPE_LABEL else "unknown"
        name = (name or "").strip() or f"unnamed-{len(self.devices) + 1}"
        base = f"{dtype}:{name}"
        did = base
        n = 2
        while did in self.devices:
            did = f"{base}#{n}"
            n += 1
        dev = Device(id=did, type=dtype, label=name, source=source)
        self.devices[did] = dev
        return dev

    def find_device(self, dtype: str, name: str) -> Optional[Device]:
        did = f"{dtype}:{name}"
        return self.devices.get(did)

    # -- 索引 ------------------------------------------------------------
    def build_index(self) -> None:
        self.wwn_index.clear()
        self.switch_wwn_index.clear()
        for dev in self.devices.values():
            if dev.wwn:
                self.switch_wwn_index.setdefault(dev.wwn, dev)
            for p in dev.ports:
                if p.wwn:
                    self.wwn_index.setdefault(p.wwn, (dev, p))

    # -- 告警 ------------------------------------------------------------
    def warn(self, msg: str, level: str = "warn", **extra: Any) -> None:
        if level not in ("info", "warn", "error"):
            level = "warn"
        if len(self.warnings) >= self.max_warnings:
            if not self.warnings_truncated:
                self.warnings.append({
                    "level": "warn",
                    "msg": f"告警数量超过上限 {self.max_warnings}，后续告警已省略",
                })
                self.warnings_truncated = True
            return
        item: Dict[str, Any] = {"level": level, "msg": msg}
        item.update(extra)
        self.warnings.append(item)


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------


def read_text(path: Path, max_bytes: Optional[int] = None) -> str:
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise ValueError(f"无法读取文件 {path}: {exc}") from exc
    if max_bytes is not None and size > max_bytes:
        raise LimitError(f"文件 {path.name} 超过大小上限 {max_bytes} 字节")
    raw = path.read_bytes()
    if max_bytes is not None and len(raw) > max_bytes:
        raise LimitError(f"文件 {path.name} 超过大小上限 {max_bytes} 字节")
    for enc in ("utf-8-sig", "utf-8", "gb18030", "gbk", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def redact_path_value(value: Any) -> Any:
    if isinstance(value, list):
        return [redact_path_value(v) for v in value]
    if isinstance(value, str):
        return os.path.basename(value.rstrip("/\\")) or value
    return value


def strip_comment(line: str) -> str:
    s = line
    for marker in ("#", "//"):
        idx = s.find(marker)
        if idx != -1:
            s = s[:idx]
    if s.lstrip().startswith(";"):
        return ""
    return s


def canon_wwn(token: str) -> Optional[str]:
    t = token.strip().lower()
    if t.startswith("0x"):
        t = t[2:]
    hexs = re.sub(r"[^0-9a-f]", "", t)
    if len(hexs) == 16:
        return ":".join(hexs[i:i + 2] for i in range(0, 16, 2))
    if len(hexs) == 32 and "naa" in t:
        hexs = hexs[-16:]
        return ":".join(hexs[i:i + 2] for i in range(0, 16, 2))
    return None


def iter_wwns(line: str) -> List[Tuple[int, int, str]]:
    out: List[Tuple[int, int, str]] = []
    for m in WWN_RE.finditer(line):
        w = canon_wwn(m.group(0))
        if w:
            out.append((m.start(), m.end(), w))
    return out


def guess_type(token: str) -> Optional[str]:
    t = (token or "").strip().lower().strip(":[]{}()<>")
    if not t:
        return None
    for dtype, aliases in TYPE_ALIASES.items():
        if t in aliases:
            return dtype
    for dtype, aliases in TYPE_ALIASES.items():
        for alias in aliases:
            if len(alias) > 2 and t.startswith(alias):
                return dtype
    return None


def normalize_status(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    v = value.strip().lower().replace(" ", "")
    if v in UP_WORDS:
        return "up"
    if v in DOWN_WORDS:
        return "down"
    return v


def clean_port(value: str) -> str:
    v = re.sub(r"\s+", "", value.strip())
    v = v.strip(".:,;|")
    return v


def extract_local_port(line: str, exclude: Iterable[Tuple[int, int]] = ()) -> Optional[str]:
    for pat in PORT_PATTERNS:
        for m in pat.finditer(line):
            if any(s <= m.start(1) < e for s, e in exclude):
                continue
            val = clean_port(m.group(1))
            if val:
                return val
    return None


def split_kv(line: str) -> Optional[Tuple[str, str]]:
    m = re.match(r"^\s*([^:=]{1,40}?)\s*[:=]\s*(.+?)\s*$", line)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    m = re.match(r"^\s*([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff.-]{0,30})\s+(\S.*)$", line)
    if m and (WWN_RE.search(m.group(2)) or IPV4_RE.search(m.group(2))):
        return m.group(1).strip(), m.group(2).strip()
    return None


def split_columns(line: str) -> List[str]:
    if "|" in line:
        return [p.strip() for p in line.strip().strip("|").split("|")]
    return [p.strip() for p in re.split(r"\t+|\s{2,}", line.strip()) if p.strip()]


# ---------------------------------------------------------------------------
# config.txt 解析
# ---------------------------------------------------------------------------


def looks_tabular(lines: List[str]) -> Optional[str]:
    """判断 config 是否为表格式（csv / tsv），返回分隔符。"""
    for line in lines:
        s = strip_comment(line).strip()
        if not s:
            continue
        low = s.lower()
        if "wwn" not in low and "wwpn" not in low:
            return None
        for delim in ("\t", ",", ";"):
            if s.count(delim) >= 2 and "wwn" in low:
                return delim
        return None
    return None


def parse_config_tabular(path: Path, ctx: Ctx) -> None:
    text = read_text(path, ctx.max_text_bytes)
    lines = text.splitlines()
    delim = looks_tabular(lines) or ","
    rows: List[List[str]] = []
    header: Optional[List[str]] = None
    for raw in lines:
        s = strip_comment(raw).strip()
        if not s:
            continue
        if delim == "\t":
            cells = [c.strip() for c in s.split("\t")]
        else:
            cells = [c.strip() for c in s.split(delim)]
        if header is None:
            low = " ".join(cells).lower()
            if "wwn" in low or "wwpn" in low:
                header = [c.lower().strip() for c in cells]
                continue
        rows.append(cells)

    if header is None:
        ctx.warn(f"{path.name}: 无法识别表头，已跳过", level="error", source=path.name)
        return

    def col(*names: str) -> Optional[int]:
        for i, h in enumerate(header):
            for n in names:
                if n in h:
                    return i
        return None

    c_type = col("type", "kind", "类型")
    c_id = col("host", "name", "id", "设备", "主机")
    c_wwn = col("wwn", "wwpn", "pwwn")
    c_port = col("port", "端口")
    c_ip = col("ip")

    if c_wwn is None:
        ctx.warn(f"{path.name}: 表头中没有 WWN 列", level="error", source=path.name)
        return

    for idx, cells in enumerate(rows, start=1):
        if not cells or len(cells) <= c_wwn:
            continue
        wwn = canon_wwn(cells[c_wwn])
        if not wwn:
            continue
        raw_name = cells[c_id].strip() if c_id is not None and c_id < len(cells) else ""
        dtype = None
        if c_type is not None and c_type < len(cells):
            dtype = guess_type(cells[c_type])
        if not dtype:
            dtype = "host"
        if not raw_name:
            raw_name = f"{dtype}-{idx}"
        dev = ctx.find_device(dtype, raw_name)
        if not dev:
            dev = ctx.new_device(dtype, raw_name, path.name)
        label = cells[c_port].strip() if c_port is not None and c_port < len(cells) else None
        port = dev.add_port(label=label, wwn=wwn)
        if c_ip is not None and c_ip < len(cells):
            ip = cells[c_ip].strip()
            if IPV4_RE.fullmatch(ip) and ip not in dev.ips:
                dev.ips.append(ip)
        _ = port


def _split_type_name(text: str) -> Tuple[Optional[str], Optional[str]]:
    s = text.strip().strip("[]{}()")
    if not s:
        return None, None
    # "[host host-01]" / "host: host-01" / "hosts.host-01"
    # 注意：'-' 不作为类型分隔符，避免把 "host-01" 拆成类型 host + 名称 01
    m = re.match(
        r"(?i)^(host|hosts|server|switch|switches|sw|storage|storages|array|san)[\s:._/]+(.+)$", s
    )
    if m:
        return guess_type(m.group(1)), m.group(2).strip()
    t = guess_type(s)
    if t:
        # "host-01" 这类“类型前缀 + 名称”的写法保留完整名称
        aliases = set()
        for group in TYPE_ALIASES.values():
            aliases |= group
        return t, (None if s.lower() in aliases else s)
    return None, s


def parse_config_blocks(path: Path, ctx: Ctx) -> None:
    text = read_text(path, ctx.max_text_bytes)
    raw_lines = text.splitlines()

    blocks: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None

    def start_block(**kw: Any) -> Dict[str, Any]:
        nonlocal current
        current = {"lines": [], "section": None, "start": 0}
        current.update(kw)
        blocks.append(current)
        return current

    for lineno, raw in enumerate(raw_lines, start=1):
        line = strip_comment(raw).strip()
        if not line:
            continue
        if line in ("{", "}"):
            continue

        sec = re.match(r"^\[(.+)\]$", line)
        if sec:
            current = start_block(section=sec.group(1), start=lineno)
            continue

        kv = split_kv(line)
        key = kv[0].strip().lower() if kv else ""
        id_like = key in ID_KEYS or key in ("host", "switch", "storage", "array")
        if kv and id_like:
            value = kv[1].strip()
            # 同一块内重复声明名称（如 [host host-03] 后跟 hostname = host-03）不拆块
            cur_name = None
            if current is not None:
                if current.get("id_value"):
                    cur_name = current["id_value"]
                elif current.get("section"):
                    cur_name = _split_type_name(current["section"])[1]
            if cur_name and cur_name.strip().lower() == value.lower():
                current["lines"].append(line)
                continue
            current = start_block(id_key=key, id_value=value, start=lineno)
            continue

        # "host-01: wwn1, wwn2" / "host-01 = wwn" 这类紧凑写法
        if kv and WWN_RE.search(kv[1]) and not kv[0].strip().lower().startswith(("port", "端口", "wwn", "wwpn", "pwwn", "ip")):
            cand = kv[0].strip()
            if re.fullmatch(r"[\w\u4e00-\u9fff][\w\u4e00-\u9fff .@_-]{0,63}", cand):
                current = start_block(name=cand, section=(current.get("section") if current else None), start=lineno)
                current["lines"].append(line)
                continue

        if current is None:
            current = start_block(start=lineno)

        # 裸名字行：块内已有 WWN 且该行是单个标识符 → 视为新设备
        if (
            not kv
            and WWN_RE.search(line) is None
            and re.fullmatch(r"[\w\u4e00-\u9fff][\w\u4e00-\u9fff .@_-]{0,63}", line)
            and current["lines"]
            and any(WWN_RE.search(strip_comment(x)) for x in current["lines"])
        ):
            current = start_block(name=line, section=(current.get("section") if current else None), start=lineno)
            continue

        current["lines"].append(line)

    if not blocks:
        ctx.warn(f"{path.name}: 文件为空或无法识别", level="error", source=path.name)
        return

    for bi, block in enumerate(blocks):
        section = block.get("section")
        dtype: Optional[str] = None
        name: Optional[str] = block.get("name")
        if section:
            dt, sn = _split_type_name(section)
            dtype = dt
            if not name:
                name = sn
        if block.get("id_key"):
            k = block["id_key"]
            v = block["id_value"]
            if k in ("host", "switch", "storage", "array"):
                kt = guess_type(k)
                if kt:
                    dtype = dtype or kt
                if not name:
                    name = v
            else:
                if not name:
                    name = v

        # 仅有类型、没有任何内容的段落（如 [hosts]）只作为上下文，不生成设备
        if not block["lines"] and not block.get("name") and not block.get("id_key") and not name:
            continue

        ports: List[Tuple[Optional[str], str]] = []  # (port label, wwn)
        pending_port: Optional[str] = None
        block_type: Optional[str] = None
        block_ip: List[str] = []
        block_meta: Dict[str, str] = {}

        for line in block["lines"]:
            kv = split_kv(line)
            if kv:
                k, v = kv[0].strip().lower(), kv[1].strip()
                if k in TYPE_KEYS:
                    block_type = block_type or guess_type(v)
                elif k in IP_KEYS:
                    for ip in IPV4_RE.findall(v):
                        if ip not in block_ip:
                            block_ip.append(ip)
                elif k in META_KEYS:
                    block_meta[k] = v
                elif k in PORT_KEYS and not WWN_RE.search(v):
                    pending_port = clean_port(v)
                    continue
                elif k in ID_KEYS and not name:
                    name = v
                    continue

            wwns = iter_wwns(line)
            if not wwns:
                continue

            port_hint = pending_port
            if not port_hint and kv and kv[0].strip().lower() in PORT_KEYS:
                port_hint = clean_port(kv[1])
            if not port_hint:
                m = re.search(
                    r"(?i)\b(?:port|portid|port_id|端口)\s*[:=#]?\s*([A-Za-z0-9][A-Za-z0-9/._-]*)", line
                )
                if m and not WWN_RE.fullmatch(m.group(1)):
                    port_hint = clean_port(m.group(1))
            if not port_hint:
                m = re.match(r"^\s*([A-Za-z0-9]{1,8})\s*[:=]\s*(" + WWN_PATTERN + r")", line)
                non_port_keys = ID_KEYS | TYPE_KEYS | IP_KEYS | {"wwn", "wwpn", "pwwn"}
                cand_key = m.group(1).strip() if m else ""
                if m and cand_key.lower() not in non_port_keys and cand_key.lower() != (name or "").lower():
                    port_hint = clean_port(cand_key)

            for i, (_, _, w) in enumerate(wwns):
                ports.append((port_hint if i == 0 else None, w))
            pending_port = None

        dtype = dtype or block_type or guess_type(name or "") or "host"
        if not name:
            first_wwn = ports[0][1] if ports else None
            name = f"未命名-{TYPE_LABEL.get(dtype, dtype)}-{bi + 1}"
            if first_wwn:
                name += f"-{first_wwn[-5:].replace(':', '')}"
            ctx.warn(
                f"{path.name}: 第 {block.get('start', bi + 1)} 行附近的设备没有名字，已命名为 {name}",
                level="warn",
                source=path.name,
            )

        dev = ctx.find_device(dtype, name)
        if not dev:
            dev = ctx.new_device(dtype, name, path.name)
        for ip in block_ip:
            if ip not in dev.ips:
                dev.ips.append(ip)
        dev.meta.update(block_meta)
        if dev.source:
            dev.source = f"{dev.source}, {path.name}"
        for label, w in ports:
            dev.add_port(label=label, wwn=w)

        if not ports:
            ctx.warn(
                f"{path.name}: 设备 {name} 没有配置任何 WWN",
                level="info",
                source=path.name,
                device=dev.id,
            )


def parse_config(path: Path, ctx: Ctx) -> None:
    text = read_text(path, ctx.max_text_bytes)
    if looks_tabular(text.splitlines()):
        parse_config_tabular(path, ctx)
    else:
        parse_config_blocks(path, ctx)


# ---------------------------------------------------------------------------
# 交换机日志解析
# ---------------------------------------------------------------------------


@dataclass
class RawPortRecord:
    port: Optional[str]
    peer_wwn: Optional[str]
    peer_port: Optional[str]
    peer_name: Optional[str] = None
    status: Optional[str] = None
    speed: Optional[str] = None
    unused: bool = False
    line: str = ""


def _table_mapping(header: List[str]) -> Optional[Dict[str, int]]:
    mapping: Dict[str, int] = {}
    for i, cell in enumerate(header):
        c = cell.lower().strip()
        if not c:
            continue
        if ("peer" in c or "remote" in c or "对端" in c) and ("port" in c or "口" in c):
            mapping.setdefault("peer_port", i)
            continue
        if "peer" in c or "remote" in c or "对端" in c or "wwn" in c or "wwpn" in c or "attached" in c:
            mapping.setdefault("wwn", i)
            continue
        if c in ("port", "port id", "portid", "port_no", "portno", "端口"):
            mapping.setdefault("port", i)
            continue
        if "status" in c or "state" in c or "状态" in c:
            mapping.setdefault("status", i)
            continue
        if c in ("switch", "name", "device", "设备", "设备名"):
            mapping.setdefault("peer_name", i)
    if "port" in mapping and "wwn" in mapping:
        return mapping
    return None


def _parse_table_rows(lines: List[str], ctx: Ctx) -> Tuple[List[RawPortRecord], Set[int]]:
    records: List[RawPortRecord] = []
    consumed: Set[int] = set()
    i = 0
    while i < len(lines):
        raw = lines[i]
        line = strip_comment(raw).strip()
        if not line or WWN_RE.search(line):
            i += 1
            continue
        header = split_columns(line)
        if len(header) < 3 or len(header) > 12:
            i += 1
            continue
        mapping = _table_mapping(header)
        if not mapping:
            i += 1
            continue
        consumed.add(i)
        j = i + 1
        while j < len(lines):
            row_raw = lines[j]
            row = row_raw.strip()
            if not row or set(row) <= set("-=+| "):
                break
            cells = split_columns(row)
            if len(cells) < 2:
                break
            wwn_cell = cells[mapping["wwn"]] if mapping["wwn"] < len(cells) else ""
            wwn = canon_wwn(wwn_cell) if wwn_cell else None
            if not wwn:
                # 行内其它列可能包含 WWN
                for c in cells:
                    wwn = canon_wwn(c) if re.fullmatch(WWN_PATTERN, c.strip()) else None
                    if wwn:
                        break
            if not wwn:
                break
            port_cell = cells[mapping["port"]] if mapping["port"] < len(cells) else ""
            port = clean_port(port_cell) if re.fullmatch(r"[A-Za-z]?\d+(?:/\d+)*", port_cell.strip()) else None
            peer_port = None
            if "peer_port" in mapping and mapping["peer_port"] < len(cells):
                pp = cells[mapping["peer_port"]].strip()
                if re.fullmatch(r"[A-Za-z]?\d+(?:/\d+)*", pp):
                    peer_port = pp
            status = None
            if "status" in mapping and mapping["status"] < len(cells):
                status = normalize_status(cells[mapping["status"]])
            if not port:
                for c in cells:
                    if re.fullmatch(r"\d+(?:/\d+)*", c.strip()):
                        port = c.strip()
                        break
            records.append(
                RawPortRecord(
                    port=port,
                    peer_wwn=wwn,
                    peer_port=peer_port,
                    status=status,
                    line=row,
                )
            )
            consumed.add(j)
            j += 1
        i = j + 1
    return records, consumed


def extract_switch_identity(path: Path, max_bytes: Optional[int] = None) -> Dict[str, Any]:
    """从日志中提取交换机自身身份（名称 / WWN / IP / 型号）。"""
    text = read_text(path, max_bytes)
    ident: Dict[str, Any] = {"name": None, "wwn": None, "ip": None, "model": None}
    for raw in text.splitlines():
        line = strip_comment(raw).strip()
        if not line:
            continue
        m = SWITCH_WWN_KEY_RE.search(line)
        if m:
            ident["wwn"] = ident["wwn"] or canon_wwn(m.group(1))
            continue
        m = BARE_WWN_KEY_RE.match(line)
        if m and not PEER_WWN_RE.search(line):
            ident["wwn"] = ident["wwn"] or canon_wwn(m.group(1))
            continue
        if ident["name"] is None:
            m = SWITCH_NAME_RE.search(line) or BARE_NAME_RE.match(line)
            if m:
                cand = m.group(1).strip()
                if cand and not WWN_RE.search(cand) and not re.fullmatch(r"[\d:]+", cand):
                    ident["name"] = cand
        if ident["ip"] is None:
            m = SWITCH_IP_RE.search(line)
            if m and IPV4_RE.fullmatch(m.group(1)):
                ident["ip"] = m.group(1)
        if ident["model"] is None:
            m = SWITCH_MODEL_RE.search(line)
            if m:
                ident["model"] = m.group(1).strip()
    return ident


def prescan_switch_identities(paths: List[Path], ctx: Ctx) -> None:
    """先登记所有交换机的名称和 WWN，保证级联链路能双向解析。"""
    for path in paths:
        ident = extract_switch_identity(path, ctx.max_text_bytes)
        name = ident["name"] or path.stem
        dev = ctx.find_device("switch", name)
        if not dev:
            dev = ctx.new_device("switch", name, path.name)
        if ident["wwn"]:
            dev.wwn = ident["wwn"]
            ctx.switch_wwn_index[ident["wwn"]] = dev
        if ident["ip"] and ident["ip"] not in dev.ips:
            dev.ips.append(ident["ip"])
        if ident["model"]:
            dev.meta["model"] = ident["model"]
        if dev.source:
            if path.name not in dev.source:
                dev.source = f"{dev.source}, {path.name}"
        else:
            dev.source = path.name
    ctx.build_index()


def parse_switch_log(path: Path, ctx: Ctx) -> Optional[Device]:
    ident = extract_switch_identity(path, ctx.max_text_bytes)
    sw_wwn = ident["wwn"]
    sw_name = ident["name"]
    sw_ip = ident["ip"]
    sw_model = ident["model"]

    text = read_text(path, ctx.max_text_bytes)
    lines = text.splitlines()

    if not sw_name:
        sw_name = path.stem
        if not sw_wwn:
            ctx.warn(
                f"{path.name}: 未找到交换机名称与 WWN，已用文件名作为名称",
                level="warn",
                source=path.name,
            )

    dev = ctx.find_device("switch", sw_name)
    if not dev:
        dev = ctx.new_device("switch", sw_name, path.name)
    if sw_wwn:
        dev.wwn = sw_wwn
        ctx.switch_wwn_index[sw_wwn] = dev
    if sw_ip and sw_ip not in dev.ips:
        dev.ips.append(sw_ip)
    if sw_model:
        dev.meta["model"] = sw_model
    dev.source = f"{dev.source}, {path.name}" if dev.source else path.name

    records, consumed = _parse_table_rows(lines, ctx)

    # 通用逐行解析
    for idx, raw in enumerate(lines):
        if idx in consumed:
            continue
        line = strip_comment(raw).strip()
        if not line:
            continue
        if SWITCH_WWN_KEY_RE.search(line) or BARE_WWN_KEY_RE.match(line):
            continue
        if SWITCH_NAME_RE.search(line) and not WWN_RE.search(line):
            continue
        if SWITCH_IP_RE.search(line) and not WWN_RE.search(line):
            continue
        if line.startswith("#") or line.startswith("--"):
            continue

        wwns = iter_wwns(line)
        peer_m = PEER_WWN_RE.search(line)
        peer_wwn = canon_wwn(peer_m.group(1)) if peer_m else None
        if peer_m and sw_wwn and peer_wwn == sw_wwn:
            peer_wwn = None

        peer_port = None
        pp_m = PEER_PORT_RE.search(line)
        exclude: List[Tuple[int, int]] = []
        if pp_m:
            peer_port = clean_port(pp_m.group(1))
            exclude.append((pp_m.start(1), pp_m.end(1)))

        port = extract_local_port(line, exclude)
        unused = any(w in line.lower() for w in UNUSED_WORDS) and not wwns

        if unused and port:
            if not dev.port_by_label(port):
                dev.add_port(label=port, unused=True)
            continue

        if not wwns:
            # 可能是“对端交换机名 + 端口”的形式
            if pp_m or ("peer" in line.lower() or "对端" in line):
                m = re.search(r"(?i)(?:peer|remote|对端|邻居)[\s_-]*(?:switch|device|设备)?\s*[:=]?\s*([\w.-]+)", line)
                if m and port:
                    name = m.group(1)
                    if name.lower() not in ("port", "wwn", "wwpn"):
                        records.append(
                            RawPortRecord(port=port, peer_wwn=None, peer_port=peer_port, peer_name=name, line=line)
                        )
            continue

        if not port:
            continue

        if peer_wwn is None:
            candidates = [w for _, _, w in wwns if w != sw_wwn]
            if not candidates:
                continue
            # 一行多个 WWN 时（如 show flogi 的 PORT NAME / NODE NAME）优先取配置里存在的那个
            peer_wwn = next((w for w in candidates if w in ctx.wwn_index), candidates[0])

        status = None
        m = STATUS_RE.search(line)
        if m:
            status = normalize_status(m.group(1))
        if status is None:
            low = line.lower()
            for w in UP_WORDS:
                if re.search(rf"\b{re.escape(w)}\b", low):
                    status = "up"
                    break
            if status is None:
                for w in DOWN_WORDS:
                    if re.search(rf"\b{re.escape(w)}\b", low):
                        status = "down"
                        break

        speed = None
        m = SPEED_RE.search(line)
        if m:
            speed = m.group(1).strip()

        records.append(
            RawPortRecord(
                port=port,
                peer_wwn=peer_wwn,
                peer_port=peer_port,
                status=status,
                speed=speed,
                line=line,
            )
        )

    if not records:
        ctx.warn(
            f"{path.name}: 没有解析到任何端口互联信息，请检查日志格式（可用 --dump 查看）",
            level="warn",
            source=path.name,
        )

    # 端口记录 → Link
    for rec in records:
        local_port = dev.port_by_label(rec.port) if rec.port else None
        if rec.port and not local_port:
            local_port = dev.add_port(label=rec.port)
        if local_port is None:
            continue
        peer: Optional[Endpoint] = None
        if rec.peer_wwn:
            hit = ctx.wwn_index.get(rec.peer_wwn)
            if hit:
                pdev, pport = hit
                peer = Endpoint(device=pdev.id, port=pport.id, wwn=rec.peer_wwn)
            else:
                sw = ctx.switch_wwn_index.get(rec.peer_wwn)
                if sw and sw.id != dev.id:
                    peer_port_obj = None
                    if rec.peer_port:
                        peer_port_obj = sw.port_by_label(rec.peer_port) or sw.add_port(label=rec.peer_port)
                    peer = Endpoint(
                        device=sw.id,
                        port=peer_port_obj.id if peer_port_obj else None,
                        wwn=rec.peer_wwn,
                    )
                elif not sw:
                    unk = ctx.find_device("unknown", rec.peer_wwn)
                    if not unk:
                        unk = ctx.new_device("unknown", rec.peer_wwn, path.name)
                        unk.wwn = rec.peer_wwn
                        unk.meta["unresolved"] = True
                        unk.add_port(label=":".join(rec.peer_wwn.split(":")[-3:]), wwn=rec.peer_wwn)
                    peer = Endpoint(device=unk.id, port=unk.ports[0].id, wwn=rec.peer_wwn)
        elif rec.peer_name:
            for cand in ctx.devices.values():
                if cand.type == "switch" and cand.id != dev.id and cand.label.lower() == rec.peer_name.lower():
                    pport = cand.port_by_label(rec.peer_port) if rec.peer_port else None
                    if rec.peer_port and not pport:
                        pport = cand.add_port(label=rec.peer_port)
                    peer = Endpoint(device=cand.id, port=pport.id if pport else None)
                    break

        if peer is None:
            continue
        if peer.device == dev.id and peer.port == local_port.id:
            continue
        ctx.links.append(
            Link(
                a=Endpoint(device=dev.id, port=local_port.id, wwn=local_port.wwn),
                b=peer,
                status=rec.status,
                speed=rec.speed,
                source=path.name,
            )
        )

    return dev


# ---------------------------------------------------------------------------
# 链接整理
# ---------------------------------------------------------------------------


def _ep_key(ep: Endpoint) -> Tuple[str, str]:
    return (ep.device, ep.port or "")


def _link_key(link: Link) -> Tuple[Tuple[str, str], Tuple[str, str]]:
    k1, k2 = _ep_key(link.a), _ep_key(link.b)
    return (k1, k2) if k1 <= k2 else (k2, k1)


def _port_sort_key(port_id: Optional[str]) -> Tuple[int, str]:
    if not port_id:
        return (10**9, "")
    label = port_id.split("#", 1)[-1]
    parts = re.findall(r"\d+", label)
    return (int(parts[0]) if parts else 10**8, label)


def merge_links(ctx: Ctx) -> List[Link]:
    """去重 + 补齐交换机级联链路两端的端口。"""
    merged: Dict[Tuple[Tuple[str, str], Tuple[str, str]], Link] = {}
    for link in ctx.links:
        key = _link_key(link)
        old = merged.get(key)
        if old is None:
            merged[key] = link
        else:
            old.status = old.status or link.status
            old.speed = old.speed or link.speed
            if link.source not in old.source:
                old.source = f"{old.source}, {link.source}"

    links = list(merged.values())

    # 交换机级联：一侧只知道对端交换机 WWN 时，尝试与对端日志里的记录按端口顺序配对
    by_pair: Dict[Tuple[str, str], List[Link]] = defaultdict(list)
    for link in links:
        a, b = link.a, link.b
        if a.device == b.device:
            continue
        da, db = ctx.devices.get(a.device), ctx.devices.get(b.device)
        if not da or not db or da.type != "switch" or db.type != "switch":
            continue
        if bool(a.port) != bool(b.port):
            key = tuple(sorted((a.device, b.device)))
            by_pair[key].append(link)

    replace: Dict[int, Link] = {}
    drop: Set[int] = set()
    for pair, group in by_pair.items():
        missing_a = [l for l in group if not _port_of(l, pair[0])]
        missing_b = [l for l in group if not _port_of(l, pair[1])]
        missing_a.sort(key=lambda l: _port_sort_key(_port_of(l, pair[1])))
        missing_b.sort(key=lambda l: _port_sort_key(_port_of(l, pair[0])))
        for la, lb in zip(missing_a, missing_b):
            if id(la) == id(lb):
                continue
            # la 缺 pair[0] 的端口（带 pair[1] 端口），lb 缺 pair[1] 的端口（带 pair[0] 端口）
            ep_a = _endpoint_for(lb, pair[0])
            ep_b = _endpoint_for(la, pair[1])
            if ep_a.device != pair[0] or ep_b.device != pair[1]:
                continue
            new = Link(a=ep_a, b=ep_b, status=la.status or lb.status, speed=la.speed or lb.speed,
                       source=la.source + ", " + lb.source)
            replace[id(la)] = new
            drop.add(id(lb))

    result: List[Link] = []
    seen: Set[Tuple[Tuple[str, str], Tuple[str, str]]] = set()
    for link in links:
        if id(link) in drop:
            continue
        link = replace.get(id(link), link)
        key = _link_key(link)
        if key in seen:
            continue
        seen.add(key)
        result.append(link)
    return result


def _port_of(link: Link, device_id: str) -> Optional[str]:
    if link.a.device == device_id:
        return link.a.port
    if link.b.device == device_id:
        return link.b.port
    return None


def _endpoint_for(link: Link, device_id: str) -> Endpoint:
    if link.a.device == device_id:
        return link.a
    return link.b


def link_kind(a: Device, b: Device) -> str:
    types = {a.type, b.type}
    if "unknown" in types:
        return "unknown"
    if types == {"host", "switch"}:
        return "host"
    if types == {"storage", "switch"}:
        return "storage"
    if types == {"switch"}:
        return "switch"
    if types == {"storage"}:
        return "storage"
    return "other"


# ---------------------------------------------------------------------------
# 构建输出
# ---------------------------------------------------------------------------


def assign_layers(devices: Dict[str, Device], links: List[Link]) -> Dict[str, int]:
    """主机 0，交换机 1..n，存储最后，未知设备挂在其邻居右侧。"""
    switch_ids = [d.id for d in devices.values() if d.type == "switch"]
    sw_adj: Dict[str, Set[str]] = {sid: set() for sid in switch_ids}
    anchors: Set[str] = set()

    for link in links:
        a, b = devices.get(link.a.device), devices.get(link.b.device)
        if not a or not b:
            continue
        if a.type == "switch" and b.type == "switch":
            sw_adj[a.id].add(b.id)
            sw_adj[b.id].add(a.id)
        elif a.type == "host" or b.type == "host":
            # 只有“紧邻主机”的交换机才是第 1 层；连接存储的交换机由级联关系推出层级
            if a.type == "switch":
                anchors.add(a.id)
            else:
                anchors.add(b.id)

    layer: Dict[str, int] = {}
    queue: List[str] = []
    for sid in anchors:
        layer[sid] = 1
        queue.append(sid)
    if switch_ids and not anchors:
        for sid in switch_ids:
            layer[sid] = 1
            queue.append(sid)

    head = 0
    while head < len(queue):
        cur = queue[head]
        head += 1
        for nb in sw_adj.get(cur, ()):
            if nb not in layer:
                layer[nb] = layer[cur] + 1
                queue.append(nb)

    for sid in switch_ids:
        if sid not in layer:
            layer[sid] = 1
            queue.append(sid)
    while head < len(queue):
        cur = queue[head]
        head += 1
        for nb in sw_adj.get(cur, ()):
            if nb not in layer:
                layer[nb] = layer[cur] + 1
                queue.append(nb)

    for dev in devices.values():
        if dev.type == "host":
            layer[dev.id] = 0

    # 存储：接在所有相邻交换机的最右侧
    for dev in devices.values():
        if dev.type != "storage":
            continue
        best = 1
        for link in links:
            other_id = None
            if link.a.device == dev.id:
                other_id = link.b.device
            elif link.b.device == dev.id:
                other_id = link.a.device
            if not other_id:
                continue
            other = devices.get(other_id)
            if other and other.type == "switch":
                best = max(best, layer.get(other.id, 1))
        layer[dev.id] = best + 1

    max_layer = max(layer.values(), default=1)
    for dev in devices.values():
        if dev.type == "unknown":
            best = 0
            for link in links:
                other_id = None
                if link.a.device == dev.id:
                    other_id = link.b.device
                elif link.b.device == dev.id:
                    other_id = link.a.device
                if other_id:
                    best = max(best, layer.get(other_id, 0))
            layer[dev.id] = min(max_layer, best + 1) if best else 1

    return layer


def build_payload(ctx: Ctx, args: argparse.Namespace) -> Dict[str, Any]:
    links = merge_links(ctx)

    # 标记端口连接状态
    connected_ports: Set[str] = set()
    for link in links:
        if link.a.port:
            connected_ports.add(link.a.port)
        if link.b.port:
            connected_ports.add(link.b.port)
    for dev in ctx.devices.values():
        for p in dev.ports:
            p.connected = p.id in connected_ports

    # 删除只有自身 WWN 的未识别占位设备
    for did in list(ctx.devices):
        dev = ctx.devices[did]
        if dev.type == "unknown" and not dev.ports and not dev.wwn:
            del ctx.devices[did]

    for did in list(ctx.devices):
        dev = ctx.devices[did]
        if not dev.wwn:
            if dev.type == "switch":
                continue
            if dev.ports:
                dev.wwn = dev.ports[0].wwn
            elif dev.meta.get("unresolved"):
                dev.wwn = dev.label

    layer = assign_layers(ctx.devices, links)

    unresolved: List[Dict[str, Any]] = []
    for dev in ctx.devices.values():
        if dev.type == "unknown":
            for p in dev.ports:
                unresolved.append(
                    {
                        "wwn": p.wwn or dev.wwn or dev.label,
                        "device": dev.id,
                        "source": dev.source,
                    }
                )

    link_json = []
    for link in links:
        a, b = ctx.devices.get(link.a.device), ctx.devices.get(link.b.device)
        if not a or not b:
            continue
        kind = link_kind(a, b)
        link_json.append(
            {
                "a": {"device": link.a.device, "port": link.a.port, "wwn": link.a.wwn},
                "b": {"device": link.b.device, "port": link.b.port, "wwn": link.b.wwn},
                "kind": kind,
                "status": link.status,
                "speed": link.speed,
                "source": link.source,
            }
        )

    dev_json = []
    for dev in sorted(ctx.devices.values(), key=lambda d: (d.type, d.label.lower())):
        if dev.type == "storage":
            # 当前业务存储固定为华为 OceanStor；外部数据可在 meta 中覆盖
            dev.meta.setdefault("vendor", "Huawei")
            dev.meta.setdefault("model", "OceanStor")
        dev.meta["layer"] = layer.get(dev.id, 0)
        dev_json.append(dev.to_json())

    if args.exclude_unknown:
        keep = {d["id"] for d in dev_json if d["type"] != "unknown"}
        dev_json = [d for d in dev_json if d["type"] != "unknown"]
        link_json = [l for l in link_json if l["a"]["device"] in keep and l["b"]["device"] in keep]

    final_counts: Dict[str, int] = defaultdict(int)
    final_ports = 0
    for d in dev_json:
        final_counts[d["type"]] += 1
        final_ports += len(d["ports"])

    final_kinds: Dict[str, int] = defaultdict(int)
    for l in link_json:
        final_kinds[l["kind"]] += 1

    known_ids = {d["id"] for d in dev_json}
    for item in unresolved:
        if item["device"] not in known_ids:
            continue
        src = f"，来源 {item['source']}" if item["source"] else ""
        ctx.warn(
            f"未识别的对端 WWN {item['wwn']}（不在 config.txt 中{src}）",
            level="info",
            device=item["device"],
        )

    max_devices = getattr(args, "max_devices", DEFAULT_MAX_DEVICES)
    max_ports = getattr(args, "max_ports", DEFAULT_MAX_PORTS)
    max_links = getattr(args, "max_links", DEFAULT_MAX_LINKS)
    if len(dev_json) > max_devices:
        raise LimitError(f"设备数量超过上限 {max_devices}，请提高 --max-devices")
    if final_ports > max_ports:
        raise LimitError(f"端口数量超过上限 {max_ports}，请提高 --max-ports")
    if len(link_json) > max_links:
        raise LimitError(f"链路数量超过上限 {max_links}，请提高 --max-links")

    def source_value(value: Any) -> Any:
        if getattr(args, "redact_paths", False) and isinstance(value, str):
            return os.path.basename(value.rstrip("/\\")) or value
        return value

    stats = {
        "hosts": final_counts.get("host", 0),
        "switches": final_counts.get("switch", 0),
        "storages": final_counts.get("storage", 0),
        "unknowns": final_counts.get("unknown", 0),
        "ports": final_ports,
        "links": len(link_json),
        "kinds": dict(final_kinds),
    }

    return {
        "schema_version": SCHEMA_VERSION,
        "kind": "topology",
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "generator": "topo.py",
        "sources": {
            "config": source_value(str(args.config)),
            "logs": [source_value(str(p)) for p in ctx.sources],
        },
        "stats": stats,
        "devices": dev_json,
        "links": link_json,
        "warnings": ctx.warnings,
    }


# ---------------------------------------------------------------------------
# 中间产物（graph JSON）：校验、归一化、读取
# ---------------------------------------------------------------------------


def _kind_from_types(a_type: str, b_type: str) -> str:
    types = {a_type, b_type}
    if "unknown" in types:
        return "unknown"
    if types == {"host", "switch"}:
        return "host"
    if types == {"storage", "switch"}:
        return "storage"
    if types == {"switch"}:
        return "switch"
    if types == {"storage"}:
        return "storage"
    return "other"


def normalize_graph(
    payload: Dict[str, Any],
    max_devices: int = DEFAULT_MAX_DEVICES,
    max_ports: int = DEFAULT_MAX_PORTS,
    max_links: int = DEFAULT_MAX_LINKS,
    max_warnings: int = DEFAULT_MAX_WARNINGS,
    redact_paths: bool = False,
) -> Dict[str, Any]:
    """把外部构造的图数据补齐成渲染器能直接消费的稳定结构。

    只依赖 schema_version / devices / links 这几个字段，其余业务字段原样保留，
    方便接入 CMDB、资产系统等自定义属性。
    """
    if not isinstance(payload, dict):
        raise ValueError("图数据根节点必须是 JSON 对象")

    version = str(payload.get("schema_version") or SCHEMA_VERSION)
    if not version.startswith("1."):
        raise ValueError(f"不支持的 schema_version: {version}（当前渲染器支持 1.x）")

    devices = payload.get("devices")
    if not isinstance(devices, list):
        raise ValueError("图数据缺少 devices 数组")
    links = payload.get("links")
    if links is None:
        links = []
    if not isinstance(links, list):
        raise ValueError("links 必须是数组")
    if len(devices) > max_devices:
        raise LimitError(f"设备数量超过上限 {max_devices}，请提高 --max-devices")
    if len(links) > max_links:
        raise LimitError(f"链路数量超过上限 {max_links}，请提高 --max-links")

    note = f"由中间产物渲染（schema {version}）"
    warnings: List[Dict[str, Any]] = []
    for raw_warning in (payload.get("warnings") or []):
        if not isinstance(raw_warning, dict):
            continue
        if str(raw_warning.get("msg", "")).startswith("由中间产物渲染"):
            continue
        level = str(raw_warning.get("level") or "info").lower()
        if level not in ("info", "warn", "error"):
            level = "info"
        item = dict(raw_warning)
        item["level"] = level
        if redact_paths and isinstance(item.get("source"), str):
            item["source"] = redact_path_value(item["source"])
        warnings.append(item)
        if len(warnings) >= max_warnings:
            warnings.append({"level": "warn", "msg": f"告警数量超过上限 {max_warnings}，后续告警已省略"})
            break
    warnings.append({"level": "info", "msg": note})

    valid_types = set(TYPE_LABEL)
    dev_by_id: Dict[str, Dict[str, Any]] = {}
    known_port_ids: Set[str] = set()
    seen_device_ids: Set[str] = set()
    port_total_seen = 0

    for idx, raw in enumerate(devices):
        if not isinstance(raw, dict):
            warnings.append({"level": "error", "msg": f"devices[{idx}] 不是对象，已忽略"})
            continue
        did = str(raw.get("id") or "").strip()
        if not did:
            did = f"device-{idx + 1}"
            raw["id"] = did
        raw["id"] = did
        if did in seen_device_ids:
            warnings.append({"level": "warn", "msg": f"设备 id 重复：{did}，后出现的记录已忽略"})
            continue
        seen_device_ids.add(did)
        dtype = str(raw.get("type") or "unknown").lower()
        if dtype not in valid_types:
            warnings.append({"level": "warn", "msg": f"设备 {did} 的类型 {dtype} 未识别，按 unknown 处理"})
            dtype = "unknown"
        raw["type"] = dtype
        raw["label"] = str(raw.get("label") or did)
        if redact_paths and isinstance(raw.get("source"), str):
            raw["source"] = redact_path_value(raw["source"])
        raw["wwn"] = raw.get("wwn") or None
        if not isinstance(raw.get("ips"), list):
            raw["ips"] = [raw["ips"]] if raw.get("ips") else []
        meta = raw.get("meta")
        raw["meta"] = meta if isinstance(meta, dict) else {}
        if dtype == "switch" and not raw["meta"].get("layer"):
            raw["meta"]["layer"] = 1
        if dtype == "storage":
            raw["meta"].setdefault("vendor", "Huawei")
            raw["meta"].setdefault("model", "OceanStor")

        ports = raw.get("ports")
        if not isinstance(ports, list):
            ports = []
        raw["ports"] = ports
        port_total_seen += len([p for p in ports if isinstance(p, dict)])
        if port_total_seen > max_ports:
            raise LimitError(f"端口数量超过上限 {max_ports}，请提高 --max-ports")
        seen_labels = set()
        for pi, port in enumerate(ports):
            if not isinstance(port, dict):
                continue
            label = str(port.get("label") or f"p{pi + 1}")
            base_label = label
            n = 2
            while label in seen_labels:
                label = f"{base_label}#{n}"
                n += 1
            seen_labels.add(label)
            port["label"] = label
            pid = str(port.get("id") or f"{did}#{label}")
            if pid in known_port_ids:
                warnings.append({"level": "warn", "msg": f"端口 id 重复：{pid}，已自动改名"})
            while pid in known_port_ids:
                pid = f"{pid}-{pi + 1}"
            port["id"] = pid
            known_port_ids.add(pid)
            port["wwn"] = port.get("wwn") or None
            port["connected"] = False
            port["unused"] = bool(port.get("unused"))
            if not isinstance(port.get("meta"), dict):
                port["meta"] = {}

        dev_by_id[did] = raw

    # 过滤掉两端设备不存在的链路，并补全 kind
    clean_links: List[Dict[str, Any]] = []
    linked_ports: Set[Tuple[str, str]] = set()
    for idx, link in enumerate(links):
        if not isinstance(link, dict):
            continue
        a = link.get("a") or {}
        b = link.get("b") or {}
        a_dev = str(a.get("device") or "")
        b_dev = str(b.get("device") or "")
        if a_dev not in dev_by_id or b_dev not in dev_by_id:
            warnings.append({"level": "warn", "msg": f"links[{idx}] 指向不存在的设备，已忽略"})
            continue
        a["device"] = a_dev
        b["device"] = b_dev
        a["port"] = a.get("port") or None
        b["port"] = b.get("port") or None
        link["a"] = a
        link["b"] = b
        if a["port"]:
            linked_ports.add((a_dev, a["port"]))
        if b["port"]:
            linked_ports.add((b_dev, b["port"]))
        kind = link.get("kind")
        if kind not in ("host", "switch", "storage", "unknown", "other"):
            kind = _kind_from_types(dev_by_id[a_dev]["type"], dev_by_id[b_dev]["type"])
        link["kind"] = kind
        link["status"] = link.get("status") or None
        link["speed"] = link.get("speed") or None
        link["source"] = link.get("source") or ""
        if redact_paths and isinstance(link["source"], str):
            link["source"] = redact_path_value(link["source"])
        if not isinstance(link.get("meta"), dict):
            link["meta"] = {}
        clean_links.append(link)

    # 由链路反推端口连接状态，避免中间产物里 connected 标错
    for dev in dev_by_id.values():
        for port in dev["ports"]:
            port["connected"] = (dev["id"], port["id"]) in linked_ports

    counts: Dict[str, int] = {}
    port_total = 0
    for dev in dev_by_id.values():
        counts[dev["type"]] = counts.get(dev["type"], 0) + 1
        port_total += len(dev["ports"])
    kinds: Dict[str, int] = {}
    for link in clean_links:
        kinds[link["kind"]] = kinds.get(link["kind"], 0) + 1

    payload["schema_version"] = SCHEMA_VERSION
    payload["kind"] = "topology"
    payload["devices"] = list(dev_by_id.values())
    payload["links"] = clean_links
    payload["warnings"] = warnings
    payload["generated_at"] = payload.get("generated_at") or datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    payload["generator"] = payload.get("generator") or "external"
    if not isinstance(payload.get("sources"), dict):
        payload["sources"] = {"config": None, "logs": []}
    if redact_paths:
        src = payload["sources"]
        src["config"] = redact_path_value(src.get("config"))
        src["logs"] = redact_path_value(src.get("logs") or [])
    payload["stats"] = {
        "hosts": counts.get("host", 0),
        "switches": counts.get("switch", 0),
        "storages": counts.get("storage", 0),
        "unknowns": counts.get("unknown", 0),
        "ports": port_total,
        "links": len(clean_links),
        "kinds": kinds,
    }
    return payload


def load_graph(
    path: Path,
    max_bytes: int = DEFAULT_MAX_GRAPH_BYTES,
    max_devices: int = DEFAULT_MAX_DEVICES,
    max_ports: int = DEFAULT_MAX_PORTS,
    max_links: int = DEFAULT_MAX_LINKS,
    max_warnings: int = DEFAULT_MAX_WARNINGS,
    redact_paths: bool = False,
) -> Dict[str, Any]:
    try:
        data = json.loads(read_text(path, max_bytes))
    except json.JSONDecodeError as exc:
        raise ValueError(f"JSON 解析失败：{exc}") from exc
    return normalize_graph(
        data,
        max_devices=max_devices,
        max_ports=max_ports,
        max_links=max_links,
        max_warnings=max_warnings,
        redact_paths=redact_paths,
    )


def filter_unknown_graph(payload: Dict[str, Any]) -> Dict[str, Any]:
    data = json.loads(json.dumps(payload, ensure_ascii=False))  # deep copy
    keep = {d["id"] for d in data.get("devices", []) if d.get("type") != "unknown"}
    data["devices"] = [d for d in data.get("devices", []) if d.get("id") in keep]
    data["links"] = [
        l for l in data.get("links", [])
        if l.get("a", {}).get("device") in keep and l.get("b", {}).get("device") in keep
    ]
    # 被隐藏设备相关的提示一并移除，避免“已隐藏但还是报未识别”
    data["warnings"] = [
        w for w in data.get("warnings", [])
        if not (isinstance(w, dict) and w.get("device") and w["device"] not in keep)
    ]
    return normalize_graph(data)


# ---------------------------------------------------------------------------
# HTML 渲染
# ---------------------------------------------------------------------------


def _fill_template(tpl: str, values: Dict[str, str]) -> str:
    """单次扫描替换；插入的值不会被再次当成占位符。"""
    out: List[str] = []
    pos = 0
    n = len(tpl)
    while pos < n:
        next_pos: Optional[int] = None
        next_token = ""
        for token in values:
            found = tpl.find(token, pos)
            if found >= 0 and (next_pos is None or found < next_pos):
                next_pos = found
                next_token = token
        if next_pos is None:
            out.append(tpl[pos:])
            break
        out.append(tpl[pos:next_pos])
        out.append(values[next_token])
        pos = next_pos + len(next_token)
    return "".join(out)


def render_html(
    payload: Dict[str, Any],
    base: Path,
    title: str,
    max_title: int = DEFAULT_MAX_TITLE,
) -> str:
    title = str(title or "")
    if len(title) > max_title:
        raise LimitError(f"标题长度超过上限 {max_title}，请缩短标题或提高 --max-title")
    try:
        tpl = (base / "template" / "index.html").read_text(encoding="utf-8")
        css = (base / "template" / "style.css").read_text(encoding="utf-8")
        app = (base / "template" / "app.js").read_text(encoding="utf-8")
        vis = (base / "assets" / "vis-network.min.js").read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"渲染模板或资源读取失败：{exc}") from exc

    expected = {
        "/*__STYLE__*/": 1,
        "/*__VIS__*/": 1,
        "/*__APP__*/": 1,
        "/*__GRAPH__*/": 1,
        "__TITLE__": 2,
    }
    for token, count in expected.items():
        if tpl.count(token) != count:
            raise ValueError(f"模板占位符异常：{token} 期望 {count} 次，实际 {tpl.count(token)} 次")

    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    data = data.replace("</", "<\\/")
    data = data.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    safe_title = html_lib.escape(title, quote=True)

    return _fill_template(tpl, {
        "/*__STYLE__*/": css,
        "/*__VIS__*/": vis,
        "/*__APP__*/": app,
        "/*__GRAPH__*/": data,
        "__TITLE__": safe_title,
    })


# ---------------------------------------------------------------------------
# 命令行
# ---------------------------------------------------------------------------


def collect_logs(
    paths: List[str],
    max_files: int = DEFAULT_MAX_FILES,
    max_total_bytes: int = DEFAULT_MAX_LOG_BYTES,
) -> List[Path]:
    out: List[Path] = []
    for p in paths:
        path = Path(p)
        if path.is_dir():
            out.extend(sorted(path.glob("*.txt")))
            out.extend(sorted(path.glob("*.log")))
        elif path.is_file():
            out.append(path)
    seen: Set[Path] = set()
    uniq: List[Path] = []
    total = 0
    for p in out:
        try:
            rp = p.resolve()
        except OSError:
            continue
        if rp in seen:
            continue
        seen.add(rp)
        try:
            total += p.stat().st_size
        except OSError as exc:
            raise ValueError(f"无法读取日志文件 {p}: {exc}") from exc
        uniq.append(p)
        if len(uniq) > max_files:
            raise LimitError(f"日志文件数量超过上限 {max_files}，请提高 --max-files")
        if total > max_total_bytes:
            raise LimitError(f"日志总大小超过上限 {max_total_bytes} 字节，请提高 --max-log-bytes")
    return uniq


def dump_report(payload: Dict[str, Any]) -> None:
    s = payload["stats"]
    print("=" * 66)
    print("拓扑解析结果")
    print("=" * 66)
    print(f"主机 {s['hosts']} 台 | 交换机 {s['switches']} 台 | 存储 {s['storages']} 套 "
          f"| 未识别设备 {s['unknowns']} 个")
    print(f"端口 {s['ports']} 个 | 链路 {s['links']} 条 "
          f"(主机 {s['kinds'].get('host', 0)}, 级联 {s['kinds'].get('switch', 0)}, "
          f"存储 {s['kinds'].get('storage', 0)}, 未识别 {s['kinds'].get('unknown', 0)})")
    print()
    print("-- 设备 --")
    for d in payload["devices"]:
        wwn = d.get("wwn") or ""
        ips = ",".join(d.get("ips") or [])
        print(f"  [{TYPE_LABEL.get(d['type'], d['type'])}] {d['label']:<24} "
              f"端口 {len(d['ports']):>2}  {wwn} {ips}")
    print()
    print("-- 链路 --")
    dev_by_id = {d["id"]: d for d in payload["devices"]}
    port_label = {}
    for d in payload["devices"]:
        for p in d["ports"]:
            port_label[p["id"]] = p["label"]
    for l in payload["links"]:
        a, b = dev_by_id.get(l["a"]["device"]), dev_by_id.get(l["b"]["device"])
        if not a or not b:
            continue
        pa = port_label.get(l["a"]["port"] or "", "-")
        pb = port_label.get(l["b"]["port"] or "", "-")
        print(f"  {a['label']}:{pa:<8} <-> {b['label']}:{pb:<8}  [{l['kind']}] {l.get('status') or ''}")
    if payload["warnings"]:
        print()
        print("-- 告警 --")
        for w in payload["warnings"]:
            print(f"  [{w['level']}] {w['msg']}")


def atomic_write_text(path: Path, text: str, mode: int = 0o600) -> None:
    """同目录临时文件 + os.replace，避免留下半个输出文件。"""
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(parent))
    try:
        try:
            os.fchmod(fd, mode)
        except (AttributeError, OSError):
            pass
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def write_graph_json(payload: Dict[str, Any], path: str) -> None:
    out = Path(path)
    atomic_write_text(out, json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"已输出中间产物：{out.resolve()}")


def emit_all(payload: Dict[str, Any], args: argparse.Namespace) -> int:
    if args.dump:
        dump_report(payload)

    written = set()
    try:
        if args.graph_out:
            write_graph_json(payload, args.graph_out)
            written.add(str(Path(args.graph_out).resolve()))
        if args.json_out and str(Path(args.json_out).resolve()) not in written:
            write_graph_json(payload, args.json_out)
    except (OSError, ValueError) as exc:
        print(f"错误：写入 graph JSON 失败：{exc}", file=sys.stderr)
        return 2

    base = Path(__file__).resolve().parent
    try:
        html = render_html(payload, base, args.title, max_title=getattr(args, "max_title", DEFAULT_MAX_TITLE))
    except (OSError, ValueError) as exc:
        print(f"错误：渲染失败：{exc}", file=sys.stderr)
        return 2

    out_path = Path(args.output)
    try:
        atomic_write_text(out_path, html)
    except (OSError, ValueError) as exc:
        print(f"错误：写入 {out_path} 失败：{exc}", file=sys.stderr)
        return 2
    print(f"已生成拓扑图：{out_path.resolve()}  ({len(html) / 1024:.0f} KB)")
    if args.open:
        try:
            webbrowser.open(out_path.resolve().as_uri())
        except Exception as exc:  # noqa: BLE001
            print(f"警告：无法自动打开浏览器：{exc}", file=sys.stderr)
    return 0


def load_adapter(
    spec: str,
    adapter_input: Optional[str],
    max_devices: int = DEFAULT_MAX_DEVICES,
    max_ports: int = DEFAULT_MAX_PORTS,
    max_links: int = DEFAULT_MAX_LINKS,
    max_warnings: int = DEFAULT_MAX_WARNINGS,
    redact_paths: bool = False,
) -> Dict[str, Any]:
    """Load an external adapter function and return a normalized graph payload.

    spec examples:
      adapters/cmdb_json.py:build
      adapters.cmdb_api:build
    The function receives adapter_input (path/URL or None) and returns a graph dict.
    """
    module_part, sep, func_name = spec.partition(":")
    if not module_part:
        raise ValueError("适配器格式应为 path.py:function 或 module:function")
    func_name = func_name or "build"
    path = Path(module_part)
    if path.is_file():
        mod_name = f"topo_adapter_{path.stem}_{abs(hash(str(path.resolve()))) & 0xFFFFFFFF}"
        module_spec = importlib.util.spec_from_file_location(mod_name, path)
        if module_spec is None or module_spec.loader is None:
            raise ValueError(f"无法加载适配器：{spec}")
        module = importlib.util.module_from_spec(module_spec)
        sys.modules[mod_name] = module
        module_spec.loader.exec_module(module)
    else:
        module = importlib.import_module(module_part)
    fn = getattr(module, func_name, None)
    if not callable(fn):
        raise ValueError(f"适配器缺少函数：{func_name}")
    payload = fn(adapter_input)
    if not isinstance(payload, dict):
        raise ValueError("适配器必须返回 graph JSON 对象")
    return normalize_graph(
        payload,
        max_devices=max_devices,
        max_ports=max_ports,
        max_links=max_links,
        max_warnings=max_warnings,
        redact_paths=redact_paths,
    )


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="根据交换机日志 + config.txt 生成交互式 SAN 拓扑图（单文件 HTML）；"
                    "也可直接读取中间产物 graph.json 渲染。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            "  解析并生成： python3 topo.py --config config.txt --logs ./logs -o topology.html\n"
            "  解析并留档： python3 topo.py --config config.txt --logs ./logs --graph-out graph.json -o topology.html\n"
            "  只做渲染：   python3 topo.py --graph graph.json -o topology.html\n"
            "  CMDB 适配器：python3 topo.py --adapter adapters/cmdb_json.py --adapter-input sample/cmdb.json -o topology.html\n"
        ),
    )
    parser.add_argument("--config", help="主机/存储配置文件路径（与 --graph 二选一）")
    parser.add_argument("--logs", nargs="+", help="交换机日志目录或文件（与 --graph 二选一）")
    parser.add_argument("--graph", help="直接读取中间产物 graph.json 渲染，跳过解析")
    parser.add_argument("--adapter", help="外部适配器 path.py:func 或 module:func；函数接收 --adapter-input 并返回 graph JSON")
    parser.add_argument("--adapter-input", help="传给外部适配器的路径 / URL / 参数")
    parser.add_argument("--graph-out", help="输出中间产物 graph.json，供其他系统复用/二次渲染")
    parser.add_argument("-o", "--output", default="topology.html", help="输出 HTML 路径（默认 topology.html）")
    parser.add_argument("--title", default="m_opslog_topo", help="页面标题（默认 m_opslog_topo）")
    parser.add_argument("--exclude-unknown", action="store_true", help="不展示未识别的对端 WWN")
    parser.add_argument("--dump", action="store_true", help="打印解析结果，便于核对格式")
    parser.add_argument("--json", dest="json_out", help="输出图数据 JSON（--graph-out 的兼容别名）")
    parser.add_argument("--open", action="store_true", help="生成后用浏览器打开")
    parser.add_argument("--redact-paths", action="store_true", help="输出 sources 只保留文件名，不写绝对路径")
    parser.add_argument("--max-log-bytes", type=int, default=DEFAULT_MAX_LOG_BYTES, help=f"日志总大小上限（默认 {DEFAULT_MAX_LOG_BYTES}）")
    parser.add_argument("--max-files", type=int, default=DEFAULT_MAX_FILES, help=f"日志文件数上限（默认 {DEFAULT_MAX_FILES}）")
    parser.add_argument("--max-graph-bytes", type=int, default=DEFAULT_MAX_GRAPH_BYTES, help=f"graph JSON 大小上限（默认 {DEFAULT_MAX_GRAPH_BYTES}）")
    parser.add_argument("--max-devices", type=int, default=DEFAULT_MAX_DEVICES, help=f"设备数量上限（默认 {DEFAULT_MAX_DEVICES}）")
    parser.add_argument("--max-ports", type=int, default=DEFAULT_MAX_PORTS, help=f"端口数量上限（默认 {DEFAULT_MAX_PORTS}）")
    parser.add_argument("--max-links", type=int, default=DEFAULT_MAX_LINKS, help=f"链路数量上限（默认 {DEFAULT_MAX_LINKS}）")
    parser.add_argument("--max-warnings", type=int, default=DEFAULT_MAX_WARNINGS, help=f"告警数量上限（默认 {DEFAULT_MAX_WARNINGS}）")
    parser.add_argument("--max-title", type=int, default=DEFAULT_MAX_TITLE, help=f"标题长度上限（默认 {DEFAULT_MAX_TITLE}）")
    args = parser.parse_args(argv)
    for name in ("max_log_bytes", "max_files", "max_graph_bytes", "max_devices", "max_ports", "max_links", "max_warnings", "max_title"):
        if getattr(args, name) <= 0:
            print(f"错误：--{name.replace('_', '-')} 必须大于 0", file=sys.stderr)
            return 2

    # 0) 外部适配器（CMDB / API / 自定义）
    if args.adapter:
        if args.graph:
            print("错误：--adapter 与 --graph 不能同时使用", file=sys.stderr)
            return 2
        try:
            payload = load_adapter(
                args.adapter,
                args.adapter_input,
                max_devices=args.max_devices,
                max_ports=args.max_ports,
                max_links=args.max_links,
                max_warnings=args.max_warnings,
                redact_paths=args.redact_paths,
            )
            if args.exclude_unknown:
                payload = filter_unknown_graph(payload)
        except Exception as exc:  # noqa: BLE001
            print(f"错误：适配器执行失败：{exc}", file=sys.stderr)
            return 2
        return emit_all(payload, args)

    # 1) 只渲染中间产物
    if args.graph:
        graph_path = Path(args.graph)
        if not graph_path.is_file():
            print(f"错误：找不到中间产物 {graph_path}", file=sys.stderr)
            return 2
        try:
            payload = load_graph(
                graph_path,
                max_bytes=args.max_graph_bytes,
                max_devices=args.max_devices,
                max_ports=args.max_ports,
                max_links=args.max_links,
                max_warnings=args.max_warnings,
                redact_paths=args.redact_paths,
            )
            if args.exclude_unknown:
                payload = filter_unknown_graph(payload)
        except Exception as exc:  # noqa: BLE001
            print(f"错误：读取中间产物失败：{exc}", file=sys.stderr)
            return 2
        return emit_all(payload, args)

    # 2) 解析原始日志
    if not args.config or not args.logs:
        print("错误：需要 --config 和 --logs，或者用 --graph 直接渲染中间产物", file=sys.stderr)
        return 2

    config_path = Path(args.config)
    if not config_path.is_file():
        print(f"错误：找不到配置文件 {config_path}", file=sys.stderr)
        return 2
    try:
        logs = collect_logs(args.logs, max_files=args.max_files, max_total_bytes=args.max_log_bytes)
    except ValueError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2
    if not logs:
        print(f"错误：{args.logs} 下没有找到日志文件", file=sys.stderr)
        return 2

    ctx = Ctx(
        max_text_bytes=args.max_log_bytes,
        max_devices=args.max_devices,
        max_warnings=args.max_warnings,
    )
    ctx.sources = [str(p) for p in logs]

    try:
        parse_config(config_path, ctx)
    except Exception as exc:  # noqa: BLE001
        print(f"错误：解析 {config_path} 失败：{exc}", file=sys.stderr)
        return 2

    if not ctx.devices:
        print(f"错误：{config_path} 中没有解析出任何设备", file=sys.stderr)
        return 2

    ctx.build_index()
    try:
        prescan_switch_identities(logs, ctx)
    except Exception as exc:  # noqa: BLE001
        print(f"错误：预扫描日志失败：{exc}", file=sys.stderr)
        return 2
    for log in logs:
        try:
            parse_switch_log(log, ctx)
        except LimitError as exc:
            print(f"错误：{exc}", file=sys.stderr)
            return 2
        except Exception as exc:  # noqa: BLE001
            ctx.warn(f"{log.name}: 解析异常 {exc}", level="error", source=log.name)
            print(f"警告：解析 {log} 失败：{exc}", file=sys.stderr)

    ctx.build_index()

    try:
        payload = build_payload(ctx, args)
    except Exception as exc:  # noqa: BLE001
        print(f"错误：构建图数据失败：{exc}", file=sys.stderr)
        return 2
    return emit_all(payload, args)


if __name__ == "__main__":
    raise SystemExit(main())
