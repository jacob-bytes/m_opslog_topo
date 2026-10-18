#!/usr/bin/env python3
"""Offline performance baseline for graph normalization and HTML rendering.

This is a local benchmark, not a CI gate. It uses synthetic data only.
"""
from __future__ import annotations

import argparse
import copy
import gc
import hashlib
import json
import platform
import statistics
import subprocess
import sys
import tempfile
import time
import tracemalloc
from pathlib import Path
from typing import Any, Callable, Dict, List, Tuple

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import topo  # noqa: E402

TITLE = "m_opslog_topo perf baseline"
GENERATED_AT = "2026-01-01 00:00:00"


def build_graph(n_hosts: int) -> Dict[str, Any]:
    """Build a deterministic synthetic graph: hosts + 8 access + 2 core + 2 storage."""
    devices: List[Dict[str, Any]] = []
    links: List[Dict[str, Any]] = []

    access = []
    host_ports_per_access = max(24, (n_hosts + 7) // 8 + 2)
    for i in range(8):
        fabric = "A" if i < 4 else "B"
        did = f"sw-acc-{i:02d}"
        access.append(did)
        devices.append({
            "id": did,
            "type": "switch",
            "label": f"acc-{i:02d}",
            "ips": [f"10.10.0.{i + 1}"],
            "meta": {"layer": 1, "fabric": fabric, "site": "dc-a"},
            "ports": [{"id": f"{did}::h{j}", "label": f"h{j}"} for j in range(host_ports_per_access)]
            + [{"id": f"{did}::c0", "label": "c0"}, {"id": f"{did}::c1", "label": "c1"}],
        })

    core = []
    for i in range(2):
        did = f"sw-core-{i:02d}"
        core.append(did)
        devices.append({
            "id": did,
            "type": "switch",
            "label": f"core-{i:02d}",
            "ips": [f"10.10.1.{i + 1}"],
            "meta": {"layer": 2, "site": "dc-a"},
            "ports": [{"id": f"{did}::c{j}", "label": f"c{j}"} for j in range(8)],
        })

    storage = []
    for i in range(2):
        did = f"st-{i:02d}"
        storage.append(did)
        devices.append({
            "id": did,
            "type": "storage",
            "label": f"storage-{i:02d}",
            "ips": [f"10.20.1.{i + 1}"],
            "meta": {"vendor": "Huawei", "model": "OceanStor", "fabric": "A" if i == 0 else "B"},
            "ports": [{"id": f"{did}::p{j}", "label": f"p{j}", "wwn": f"10:00:00:00:00:00:{i:02x}:{j:02x}"} for j in range(2)],
        })

    for i in range(n_hosts):
        did = f"host-{i:04d}"
        acc = access[i % len(access)]
        fabric = "A" if (i % len(access)) < 4 else "B"
        devices.append({
            "id": did,
            "type": "host",
            "label": did,
            "ips": [f"10.20.{i // 250}.{i % 250 + 1}"],
            "meta": {"fabric": fabric, "site": "dc-a"},
            "ports": [{"id": f"{did}::p0", "label": "p0", "wwn": f"10:01:00:00:00:{(i >> 24) & 255:02x}:{(i >> 16) & 255:02x}:{(i >> 8) & 255:02x}"}],
        })
        links.append({
            "a": {"device": did, "port": f"{did}::p0"},
            "b": {"device": acc, "port": f"{acc}::h{i // 8}"},
            "kind": "host",
            "status": "up",
        })

    for ai, did in enumerate(access):
        for ci, cid in enumerate(core):
            links.append({
                "a": {"device": did, "port": f"{did}::c{ci}"},
                "b": {"device": cid, "port": f"{cid}::c{ai}"},
                "kind": "switch",
                "status": "up",
            })

    for ci, cid in enumerate(core):
        for si, sid in enumerate(storage):
            links.append({
                "a": {"device": cid, "port": f"{cid}::s{si}"},
                "b": {"device": sid, "port": f"{sid}::p{si}"},
                "kind": "storage",
                "status": "up",
            })

    # Ensure core switch has enough ports for switch/storage links.
    for d in devices:
        if d["type"] == "switch" and d["id"].startswith("sw-core"):
            d["ports"].extend([
                {"id": f"{d['id']}::s0", "label": "s0"},
                {"id": f"{d['id']}::s1", "label": "s1"},
            ])

    return {
        "schema_version": "1.0",
        "kind": "topology",
        "generated_at": GENERATED_AT,
        "generator": "perf-baseline",
        "sources": {"config": "synthetic", "logs": []},
        "devices": devices,
        "links": links,
        "warnings": [],
    }


def measure(fn: Callable[[], Any], repeat: int) -> Tuple[float, float, Any]:
    times: List[float] = []
    peaks: List[int] = []
    result: Any = None
    for _ in range(repeat):
        gc.collect()
        tracemalloc.start()
        start = time.perf_counter()
        result = fn()
        elapsed = time.perf_counter() - start
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        times.append(elapsed * 1000.0)
        peaks.append(peak)
    return statistics.median(times), max(peaks) / 1024.0, result


def run_rust(binary: Path, graph_path: Path, output: Path, repeat: int, title: str) -> float:
    times: List[float] = []
    for _ in range(repeat):
        start = time.perf_counter()
        subprocess.run(
            [str(binary), "--graph", str(graph_path), "-o", str(output), "--title", title],
            check=True,
            capture_output=True,
            text=True,
        )
        times.append((time.perf_counter() - start) * 1000.0)
    return statistics.median(times)


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Offline graph normalize/render performance baseline")
    parser.add_argument("--sizes", nargs="+", type=int, default=[100, 400, 1000])
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--title", default=TITLE)
    parser.add_argument("--output", default=str(ROOT / "reports/perf-baseline.json"))
    parser.add_argument("--markdown", default=str(ROOT / "reports/perf-baseline.md"))
    parser.add_argument("--rust", action="store_true", help="Also measure the native Rust renderer subprocess")
    parser.add_argument("--rust-bin", default=str(ROOT / "rust/topo-render/target/debug/topo-render"))
    args = parser.parse_args(argv)

    if args.repeat < 1:
        print("error: --repeat must be >= 1", file=sys.stderr)
        return 2
    if any(n < 1 for n in args.sizes):
        print("error: --sizes must be positive", file=sys.stderr)
        return 2

    rust_bin = Path(args.rust_bin)
    if args.rust and not rust_bin.exists():
        print(f"error: Rust binary not found: {rust_bin}", file=sys.stderr)
        return 2

    rows = []
    for hosts in args.sizes:
        base = build_graph(hosts)
        graph_bytes = len(json.dumps(base, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

        norm_ms, norm_peak, normalized = measure(
            lambda: topo.normalize_graph(copy.deepcopy(base)),
            args.repeat,
        )
        render_ms, render_peak, html = measure(
            lambda: topo.render_html(normalized, ROOT, args.title),
            args.repeat,
        )
        html_bytes = len(html.encode("utf-8"))
        row = {
            "hosts": hosts,
            "devices": len(normalized["devices"]),
            "links": len(normalized["links"]),
            "graph_bytes": graph_bytes,
            "normalize_ms": round(norm_ms, 3),
            "render_ms": round(render_ms, 3),
            "html_bytes": html_bytes,
            "html_sha256": hashlib.sha256(html.encode("utf-8")).hexdigest(),
            "normalize_peak_kb": round(norm_peak, 1),
            "render_peak_kb": round(render_peak, 1),
        }

        if args.rust:
            with tempfile.TemporaryDirectory() as d:
                graph_path = Path(d) / "graph.json"
                graph_path.write_text(json.dumps(normalized, ensure_ascii=False), encoding="utf-8")
                rust_out = Path(d) / "rust.html"
                row["rust_ms"] = round(run_rust(rust_bin, graph_path, rust_out, args.repeat, args.title), 3)
                row["rust_html_bytes"] = rust_out.stat().st_size
                row["rust_html_sha256"] = hashlib.sha256(rust_out.read_bytes()).hexdigest()

        rows.append(row)
        print(
            f"{hosts:>5} hosts | {row['devices']:>6} devices | {row['links']:>6} links | "
            f"norm {row['normalize_ms']:>8.2f} ms | render {row['render_ms']:>8.2f} ms | "
            f"HTML {row['html_bytes'] / 1024:>8.1f} KB"
            + (f" | rust {row['rust_ms']:>8.2f} ms" if args.rust else "")
        )

    report = {
        "tool": "perf-baseline",
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "repeat": args.repeat,
        "title": args.title,
        "rust": args.rust,
        "rows": rows,
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    md = Path(args.markdown)
    md.parent.mkdir(parents=True, exist_ok=True)
    headers = ["hosts", "devices", "links", "graph KB", "normalize ms", "render ms", "HTML KB"]
    if args.rust:
        headers.append("Rust ms")
    lines = [
        "# Performance Baseline",
        "",
        f"- generated: `{report['generated_at']}`",
        f"- Python: `{report['python']}`",
        f"- platform: `{report['platform']}`",
        f"- repeat: `{report['repeat']}` (median)",
        "",
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join(["---"] * len(headers)) + " |",
    ]
    for row in rows:
        cells = [
            str(row["hosts"]), str(row["devices"]), str(row["links"]),
            f"{row['graph_bytes'] / 1024:.1f}",
            f"{row['normalize_ms']:.2f}", f"{row['render_ms']:.2f}",
            f"{row['html_bytes'] / 1024:.1f}",
        ]
        if args.rust:
            cells.append(f"{row['rust_ms']:.2f}")
        lines.append("| " + " | ".join(cells) + " |")
    lines += [
        "",
        "## Notes",
        "",
        "- Synthetic graph: hosts + 8 access switches + 2 core switches + 2 storage.",
        "- `normalize` measures `topo.normalize_graph()`; `render` measures "
        "`topo.render_html()` including template/asset reads.",
        "- Rust column measures the separate native renderer process end-to-end, not just the string fill.",
        "- This is a local baseline, not a hard CI threshold; compare on the same machine and Python version.",
    ]
    md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\nJSON: {out}\nMarkdown: {md}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
