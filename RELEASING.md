# Releasing

## Versioning

Use tags like `v0.1.0`, `v0.2.0`. The generated HTML and the graph IR
(`schema_version`) are versioned independently; changing the graph schema
requires a README/CHANGELOG note.

## Before tagging

1. Update `CHANGELOG.md`.
2. Run the local checks:

```bash
python3 -m py_compile topo.py
node --check template/app.js
python3 topo.py --config sample/config.txt --logs sample/logs -o /tmp/topology.html
python3 topo.py --adapter adapters/cmdb_json.py --adapter-input sample/cmdb.json -o /tmp/cmdb.html
test -s /tmp/topology.html && test -s /tmp/cmdb.html
```

3. Confirm the working tree is clean and the sample topology is current:

```bash
git status --short
```

## Create the release

The tag push runs `.github/workflows/release.yml`, which builds the demo files
and creates the GitHub Release:

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push origin main
git push origin v0.1.0
```

Release assets produced by the workflow:

- `topology-demo-v0.1.0.html` — sample config/logs, offline single file
- `cmdb-demo-v0.1.0.html` — sample CMDB adapter, offline single file
- `m_opslog_topo-sample-v0.1.0.zip` — sample config/logs/graph/CMDB
- `SHA256SUMS`
- GitHub's automatic source code zip/tar

## Manual fallback

If Actions are disabled:

```bash
mkdir -p release
python3 topo.py --config sample/config.txt --logs sample/logs -o release/topology-demo-v0.1.0.html
python3 topo.py --adapter adapters/cmdb_json.py --adapter-input sample/cmdb.json -o release/cmdb-demo-v0.1.0.html
cd sample && zip -r ../release/m_opslog_topo-sample-v0.1.0.zip . && cd ..
cd release && sha256sum *.html *.zip > SHA256SUMS && cd ..
gh release create v0.1.0 release/* --generate-notes
```

## After release

- Verify the Actions run and the release assets.
- Download `topology-demo-v0.1.0.html` and open it offline in a browser.
- Verify `SHA256SUMS`.
- Keep real customer logs out of the repository and release assets.
