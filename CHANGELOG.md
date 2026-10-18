# Changelog

All notable changes to this project are documented here.

## [v0.1.2] - 2026-10-18

### Fixed

- Escape storage vendor/model text in the detail panel.
- Escape unknown link kinds in the port matrix.
- Lock the remaining HTML interpolation points with additional frontend
  hardening tests.

## [v0.1.1] - 2026-10-18

### Security

- Escape the page title before embedding it in HTML.
- Whitelist warning levels and escape filter keys used in DOM attributes.
- Guard CSV exports against spreadsheet formula injection.
- Validate `cmdb_api.py` URLs: only `http/https`, block localhost/private
  addresses by default, and cap response size.
- Add configurable input limits for logs, graph JSON, devices, ports, links,
  warnings, and titles.
- Use atomic writes with `0600` permissions for HTML and graph JSON output.
- Add `--redact-paths` to remove absolute source paths from emitted data.

### Changed

- Normalize now rejects duplicate device IDs (with a warning), caps warning
  levels, and reports duplicate port IDs.
- CLI render/write failures return exit code `2` instead of a traceback.

### Tests

- Add `tests/test_hardening.py` (title/script escaping, warning levels,
  duplicate IDs, input limits, atomic writes, URL validation, redaction).
- CI runs the hardening tests.
- Release workflow now has a required test job before publishing.

## [v0.1.0] - 2026-10-17

First public release: an offline SAN/NAS topology generator that turns switch
logs and config into one self-contained HTML file.

### Added

- Parse `config.txt` + switch logs into a versioned graph IR.
- Single-file offline HTML with vendored vis-network.
- Layered device/port views, health, search, filters, port matrix, inventory.
- Host group collapsing and automatic aggregation at scale.
- Network plane layout from `meta.fabric`, with ghost A/B nodes, lane column
  headers, lane collapse, health counts, and cross-plane link hints.
- Redundancy matrix, per-cell path detail, and switch-removal simulation.
- Picker host grouping by access switch for large inventories.
- Local view presets (filters, scope, layout, style, theme).
- Advanced search fields (`site:`, `fabric:`, `type:`, `layer:`, `status:`,
  `vendor:`, `model:`, `ip:`, `wwn:`, `port:`, `name:`).
- `⌘K` / `Ctrl+K` command palette.
- JSON and CMDB/API adapters.
- Preview documentation and generated sample `topology.html`.

### Known limitations

- Port view does not support network plane layout yet; it falls back to layered.
- Picker grouping is collapsed grouping, not full virtual scrolling.
- Redundancy cell paths are BFS approximations; fault simulation removes switch
  nodes only.
- No zoning, LUN mapping, multipath software, or live API synchronization.

[Unreleased]: https://github.com/jacob-bytes/m_opslog_topo/compare/v0.1.2...HEAD
[v0.1.2]: https://github.com/jacob-bytes/m_opslog_topo/releases/tag/v0.1.2
[v0.1.1]: https://github.com/jacob-bytes/m_opslog_topo/releases/tag/v0.1.1
[v0.1.0]: https://github.com/jacob-bytes/m_opslog_topo/releases/tag/v0.1.0
