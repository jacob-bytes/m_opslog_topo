# Performance Baseline

- generated: `2026-10-18 14:12:31`
- Python: `3.13.5`
- platform: `macOS-26.5.1-arm64-arm-64bit-Mach-O`
- repeat: `3` (median)

| hosts | devices | links | graph KB | normalize ms | render ms | HTML KB | Rust ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | 112 | 120 | 43.8 | 11.00 | 5.91 | 1049.9 | 8.25 |
| 400 | 412 | 420 | 145.8 | 28.74 | 14.12 | 1189.1 | 16.85 |
| 1000 | 1012 | 1020 | 356.0 | 74.45 | 33.21 | 1481.9 | 36.78 |

## Notes

- Synthetic graph: hosts + 8 access switches + 2 core switches + 2 storage.
- `normalize` measures `topo.normalize_graph()`; `render` measures `topo.render_html()` including template/asset reads.
- Rust column measures the separate native renderer process end-to-end, not just the string fill.
- This is a local baseline, not a hard CI threshold; compare on the same machine and Python version.
