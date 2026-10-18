# Security Policy

## Supported versions

Security fixes target the latest release on `main`. The current supported
release is **v0.1.3**.

## Reporting a vulnerability

Please use GitHub's **Security → Advisories → Report a vulnerability** flow
for this repository. Do not open a public issue for a vulnerability that
could expose topology data, credentials, internal paths, or execute code.

Include:

- affected command / input
- minimal reproduction graph or log snippet (redacted)
- expected vs actual result
- browser / OS / Python version if relevant

## Threat model

`m_opslog_topo` is an offline generator and a single-file HTML viewer.

### What it does not do

- no network requests from the generated HTML
- no runtime third-party Python dependencies
- no authentication or multi-tenant isolation
- no server-side execution of generated HTML

### Trust boundaries

- `config.txt`, switch logs and graph JSON may contain sensitive topology data.
- `--adapter` loads and executes Python code. Treat adapter paths and adapter
  inputs as trusted input only.
- `cmdb_api.py` fetches a caller-supplied URL. It permits only `http/https` and
  rejects localhost, loopback and private addresses by default. Internal CMDB
  endpoints require `TOPO_ALLOW_PRIVATE_URL=1`.
- Generated HTML includes device names, IPs, WWNs, ports and warnings. Treat
  it as a sensitive file.

## Built-in hardening

- HTML title is escaped.
- Warning levels are whitelisted before being used as CSS classes.
- Graph JSON is protected against `</script>`, U+2028 and U+2029 injection.
- CSV exports guard against spreadsheet formula injection.
- Input files, graph JSON and collections have configurable limits.
- Output is written through a same-directory temporary file and atomic replace,
  with `0600` permissions.
- `--redact-paths` removes absolute source paths from the emitted graph.
- CI runs the hardening unit tests; release requires the test job to pass.

## Known limitations

- The generated HTML is a snapshot and has no access control.
- Browser localStorage presets are per-browser and not encrypted.
- The viewer does not sanitize arbitrary extensions added to `meta`; keep extra
  metadata non-sensitive.
- Full XSS protection ultimately depends on the viewer's `esc()` calls; do not
  render untrusted graphs in a privileged browser profile.
