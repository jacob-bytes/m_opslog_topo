# 中间产物：拓扑图数据 schema（v1）

生成器 `topo.py` 把“解析”和“渲染”拆成两段，中间用一份 JSON 契约衔接：

```
交换机日志 + config.txt
        │  topo.py 解析 / 归一化
        ▼
topology.graph.json     ← 版本化的中间产物（本文档）
        │  topo.py --graph 渲染
        ▼
topology.html           ← 单文件离线页面
```

只要你的系统能产出同样结构的 JSON，就可以直接复用整套前端，不必重写绘制、筛选、布局和交互。

```bash
# 解析并同时留档
python3 topo.py --config config.txt --logs ./logs --graph-out graph.json -o topology.html

# 只渲染中间产物
python3 topo.py --graph graph.json -o topology.html
```

---

## 顶层结构

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `schema_version` | string | 建议 | 当前 `1.0`；渲染器只接受 `1.x` |
| `kind` | string | 否 | 固定 `topology`，便于文件识别 |
| `generated_at` | string | 否 | 展示用时间 |
| `generator` | string | 否 | 数据来源标识，如 `topo.py` / `cmdb-exporter` |
| `sources` | object | 否 | 原始来源信息，仅展示/追溯 |
| `stats` | object | 否 | 渲染器会按 `devices`/`links` 重新计算，可不填 |
| `devices` | array | **是** | 设备列表 |
| `links` | array | **是** | 链路列表（可为空数组） |
| `warnings` | array | 否 | 解析提示，展示在侧栏 |
| `groups` | array | 否 | 业务分组等扩展字段，渲染器原样保留（预留） |
| `meta` | object | 否 | 任意扩展字段，渲染器原样保留 |

## 设备 `devices[]`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | **是** | 全局唯一，建议 `类型:名称`，如 `host:app-01` |
| `type` | string | **是** | `host` / `switch` / `storage` / `unknown` |
| `label` | string | 否 | 展示名，缺省用 `id` |
| `wwn` | string | 否 | 设备自身 WWN（交换机通常需要） |
| `ips` | string[] | 否 | 管理 IP，卡片副标题与详情展示 |
| `ports` | array | 否 | 网口列表；没有网口的设备也允许 |
| `meta` | object | 否 | `layer`（交换机层级）、`vendor`、`model`、`group`、`site`、`rack`、`tags` 等 |

#> 存储设备默认补 `meta.vendor = "Huawei"`、`meta.model = "OceanStor"`；外部数据可以覆盖成其他厂商/型号，界面会自动切换品牌标识颜色。

## 网口 `devices[].ports[]`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | **是** | 全局唯一，建议 `设备id#端口名` |
| `label` | string | 否 | 端口名，如 `p1` / `0A` / `fc1/1` |
| `wwn` | string | 否 | 该网口的 WWN，是设备与日志关联的主键 |
| `connected` | bool | 否 | 渲染器会根据 `links` 重新推导 |
| `unused` | bool | 否 | 空闲端口；配合“显示未使用端口”开关 |
| `meta` | object | 否 | 速率、光模块、VLAN 等扩展 |

## 链路 `links[]`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `a` | object | **是** | `{ "device": "设备id", "port": "端口id 或 null", "wwn": "可选" }` |
| `b` | object | **是** | 同上 |
| `kind` | string | 否 | `host` / `switch` / `storage` / `unknown` / `other`；缺省按设备类型推导 |
| `status` | string | 否 | `up` / `down`；“只看在线链路”依赖它 |
| `speed` | string | 否 | 如 `32G`，仅展示 |
| `source` | string | 否 | 来源日志，仅展示 |

> `a.port` / `b.port` 可以为 `null`（只知道对端设备、不知道对端端口），端口视图会退化为“端口 → 设备”。

## 最小示例

```json
{
  "schema_version": "1.0",
  "kind": "topology",
  "devices": [
    {
      "id": "host:app-01",
      "type": "host",
      "label": "app-01",
      "ips": ["10.0.0.11"],
      "ports": [
        { "id": "host:app-01#p1", "label": "p1", "wwn": "10:00:00:00:c9:a1:00:01", "connected": true }
      ]
    },
    {
      "id": "switch:sw1",
      "type": "switch",
      "label": "sw1",
      "wwn": "10:00:00:00:c9:ff:00:01",
      "meta": { "layer": 1 },
      "ports": [
        { "id": "switch:sw1#1", "label": "1", "connected": true },
        { "id": "switch:sw1#10", "label": "10", "connected": true }
      ]
    },
    {
      "id": "storage:st1",
      "type": "storage",
      "label": "st1",
      "ports": [
        { "id": "storage:st1#0A", "label": "0A", "wwn": "20:00:00:00:c9:b1:00:01", "connected": true }
      ]
    }
  ],
  "links": [
    {
      "a": { "device": "host:app-01", "port": "host:app-01#p1" },
      "b": { "device": "switch:sw1", "port": "switch:sw1#1" },
      "kind": "host",
      "status": "up"
    },
    {
      "a": { "device": "switch:sw1", "port": "switch:sw1#10" },
      "b": { "device": "storage:st1", "port": "storage:st1#0A" },
      "kind": "storage",
      "status": "up"
    }
  ]
}
```

完整样例见 `sample/topology.graph.json`（由 `topo.py` 自动生成），最小可运行样例见 `sample/mini.graph.json`。

## 归一化规则

`--graph` 渲染前会做一次归一化（`normalize_graph`）：

1. 缺失的 `label` / `ips` / `meta` / `ports` 补默认值
2. 补全 `stats`（设备数、端口数、链路数、链路类型分布）
3. 端口 `connected` 一律根据 `links` 重新推导，避免手写数据不一致
4. 端点设备不存在的链路会被丢弃，并在 `warnings` 中提示
5. 交换机缺失 `meta.layer` 时默认第 1 层；存储缺失 `meta.vendor`/`meta.model` 时默认华为 OceanStor
6. 非 `1.x` 的 `schema_version` 会直接报错，防止不兼容数据静默渲染
7. 所有未识别的扩展字段（`meta`、`groups` 等）原样保留

## 版本策略

- `1.x` 内保持向后兼容：只新增可选字段，不改变既有字段含义
- 破坏性变更升到 `2.0`，渲染器显式拒绝
- 生成器写入的 `schema_version` 与内嵌 HTML 的数据一致，方便回溯
