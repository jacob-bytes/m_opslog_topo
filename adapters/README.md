# Adapters

`topo.py` 支持通过适配器把 CMDB / API / 自定义数据源转换成 graph JSON，再复用同一套渲染。

## 用法

```bash
# CMDB JSON
python3 topo.py \
  --adapter adapters/cmdb_json.py \
  --adapter-input sample/cmdb.json \
  -o topology.html

# API（返回同样的 JSON 结构）
python3 topo.py \
  --adapter adapters/cmdb_api.py \
  --adapter-input https://cmdb.example/api/topology \
  -o topology.html

# 也可以用模块路径
python3 topo.py --adapter adapters.cmdb_json:build --adapter-input cmdb.json
```

## 适配器契约

适配器是一个 Python 函数：

```python
def build(input_value: str | None) -> dict:
    return {
        "schema_version": "1.0",
        "devices": [...],
        "links": [...],
    }
```

- `input_value` 来自 `--adapter-input`
- 函数返回 graph 对象；`topo.py` 会自动 `normalize_graph()`
- 抛出的异常会显示为 CLI 错误，退出码 2

## graph 对象

```json
{
  "devices": [
    {
      "id": "host-01",
      "type": "host",
      "label": "host-01",
      "ips": ["10.0.0.11"],
      "meta": {"site": "dc-a", "fabric": "A"},
      "ports": [{"id": "host-01::p1", "label": "p1", "wwn": "10:00:..."}]
    }
  ],
  "links": [
    {
      "a": {"device": "host-01", "port": "host-01::p1"},
      "b": {"device": "sw-01", "port": "sw-01::1"},
      "kind": "host",
      "status": "up"
    }
  ]
}
```

`cmdb_json.py` 是一个可运行的 CMDB JSON 示例；`cmdb_api.py` 演示从 HTTP API 拉取后复用同一套映射。
