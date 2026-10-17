# Rust 原生渲染注意事项

本文是给“Rust 直接读模板 + graph JSON 拼 HTML”的实现备忘，不是 API 文档。

核心结论：

> Rust 只应负责 **graph JSON → HTML** 这一段。  
> 解析、布局、筛选、网络平面推导、导出都在别处，不要搬进渲染器。

现有 Python 侧的可复用边界：

```text
topo.py --graph graph.json -o topology.html
```

对应的实现只有三件事：

1. 读取模板：`template/index.html`、`template/style.css`、`template/app.js`、`assets/vis-network.min.js`
2. 把 graph 序列化成 JSON 塞进 `window.__GRAPH__`
3. 替换 5 个占位符，输出 UTF-8 HTML

看起来简单，但下面这些坑踩一次就会产生“能打开、但数据不对/脚本截断/标题丢失”的问题。

---

## 1. 先决定：Rust 要不要负责 normalize

Python 的 `render_html()` 不做校验，也不做 normalize。  
`--graph` 路径在渲染前会调用 `normalize_graph()`，补齐：

- `schema_version` / `kind`
- `devices[].label` / `type` / `ips` / `meta`
- `meta.layer`（交换机默认 1）
- storage 的 `vendor` / `model` 默认值
- 端口 `id` / `label` 唯一性
- `port.connected`（由 links 反推）
- `link.kind` / `status` / `speed` / `source`
- 过滤指向不存在设备的 link
- `warnings` / `generated_at` / `generator` / `sources`
- `stats`
- Python `normalize_graph()` 还会追加一条 `由中间产物渲染（schema 1.x）` 的 info warning；Rust 原生渲染不追加也可以，但 UI 告警数量会不同。

**推荐做法：**

- Rust 业务侧产出的 graph 已经是“normalized graph”，Rust 渲染器只做 `validate_graph()`。
- 如果 Rust 要接收外部任意 graph，先移植 `normalize_graph()` 的关键规则，或继续让 Python 做 normalize。
- 不要把 Python 的 `normalize_graph()` 当成“渲染器会自动处理”；它不在 `render_html()` 里。

最小的 normalized graph 形状：

```json
{
  "schema_version": "1.0",
  "kind": "topology",
  "generated_at": "2026-10-18 00:00:00",
  "generator": "rust-business-service",
  "devices": [],
  "links": [],
  "warnings": [],
  "sources": { "config": null, "logs": [] },
  "stats": {
    "hosts": 0,
    "switches": 0,
    "storages": 0,
    "unknowns": 0,
    "ports": 0,
    "links": 0,
    "kinds": {}
  }
}
```

### 必查字段

- `schema_version` 必须以 `1.` 开头；不支持 2.x。
- `devices` 必须是数组；`links` 必须是数组。
- 设备 `id` 唯一、非空；`type` 属于 `host/switch/storage/unknown`。
- 端口 `id` 全局唯一；同一个设备内 `label` 唯一。
- link 两端设备必须存在；`a` / `b` 至少要有 `device`。
- `link.kind` 属于 `host/switch/storage/unknown/other`；缺省时按两端类型推导。
- `ports[].connected` 必须由 links 重新算，不能相信外部旧值。
- `stats` 必须按最终 devices/links 重新算，不能用旧统计。
- `generated_at` 建议与 Python 一样用本地时间 `YYYY-MM-DD HH:MM:SS`，否则页面显示时区会变。

---

## 2. 模板占位符只有这几个

`template/index.html` 里一共 5 类占位符：

| 占位符 | 次数 | 位置 |
| --- | --- | --- |
| `/*__STYLE__*/` | 1 | `<style>` |
| `/*__VIS__*/` | 1 | 第一个 `<script>` |
| `/*__APP__*/` | 1 | 最后一个 `<script>` |
| `/*__GRAPH__*/` | 1 | `window.__GRAPH__ = ...` |
| `__TITLE__` | 2 | `<title>` 和 `<h1>` |

注意：

- `window.__GRAPH__` 里的 `__GRAPH__` **不是**占位符；不要替换裸 `__GRAPH__`。
- `__TITLE__` 出现两次，要全部替换。
- 建议在构建时断言：前 4 个各出现 1 次，`__TITLE__` 出现 2 次；缺失/重复直接构建失败。
- 不要把 `/*__APP__*/` 替换成包含 `</script>` 的文本；当前 `app.js` 没有，但以后可能变。

---

## 3. 最大的坑：顺序替换会互相污染

Python 当前是顺序 `replace`：

```python
html = tpl
html = html.replace("/*__STYLE__*/", css)
html = html.replace("/*__VIS__*/", vis)
html = html.replace("/*__APP__*/", app)
html = html.replace("/*__GRAPH__*/", data)
html = html.replace("__TITLE__", title)
```

这有一个隐蔽问题：

> `data` 里如果包含字符串 `__TITLE__`，最后一步会把数据里的 `__TITLE__` 也替换成标题。

反过来说，如果先把 title 换进去，title 里如果包含 `/*__STYLE__*/`，又会被后续替换污染。

**正确做法是单次扫描替换，不重新扫描替换结果。**

也就是说：

- 只在**原始模板**里查找占位符
- 插入的值（CSS、JS、JSON、title）不再被当作模板

伪代码：

```rust
fn fill_template(
    tpl: &str,
    values: &[(&str, &str)], // 占位符 -> 值
) -> Result<String, RenderError> {
    let mut out = String::with_capacity(tpl.len() + 1024 * 1024);
    let mut rest = tpl;

    loop {
        let next = values
            .iter()
            .filter_map(|(token, value)| rest.find(token).map(|pos| (pos, *token, *value)))
            .min_by_key(|(pos, _, _)| *pos);

        let Some((pos, token, value)) = next else {
            out.push_str(rest);
            break;
        };

        out.push_str(&rest[..pos]);
        out.push_str(value);
        rest = &rest[pos + token.len()..];
    }

    Ok(out)
}
```

这样：

- graph 里的 `__TITLE__` 保留原样
- title 里的 `/*__STYLE__*/` 保留原样
- CSS/JS 里未来出现的占位符不会被误替换

这是 Rust 实现比 Python 当前实现更应该做对的地方。

---

## 4. JSON 注入：`</script>` 只是最低要求

graph 会被放进：

```html
<script>window.__GRAPH__ = /*__GRAPH__*/;</script>
```

如果某个设备名、WWN、告警文本包含 `</script>`，HTML 解析器会提前结束脚本，页面直接坏掉。

### 最低限度

和 Python 一样：

```rust
let data = serde_json::to_string(&graph)?
    .replace("</", "<\\/");
```

### 更稳的做法

把 JSON 里的 `<` 全部转成 `\u003C`：

```rust
let data = serde_json::to_string(&graph)?
    .replace('<', "\\u003C")
    .replace('\u{2028}', "\\u2028")
    .replace('\u{2029}', "\\u2029");
```

说明：

- `\u003C` 是合法 JSON 字符串转义，浏览器解析后仍然是 `<`
- 这样连 `<!--`、`</script>`、`</SCRIPT>` 都不会触发 HTML 特殊规则
- 代价是 JSON 字符串比原来长一点
- 不要做 HTML escape（`&lt;`），那会改变数据；这里要的是 JSON escape

`serde_json` 本身会转义控制字符，但不会替你处理 HTML script 上下文，也不会主动转义 U+2028/U+2029，所以需要显式处理。

### 不要用 `to_string_pretty`

Python 用紧凑 JSON。Rust 也应该用 `to_string`，不要 `to_string_pretty`：

- 输出会多很多空白
- HTML 体积变大
- 没有必要

---

## 5. Title 是 HTML 文本，不是 JS 字符串

`__TITLE__` 在 `<title>` 和 `<h1>` 中出现，应该做 HTML 文本转义：

```rust
fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
     .replace('<', "&lt;")
     .replace('>', "&gt;")
     .replace('"', "&quot;")
}
```

建议同时：

- 限制长度（例如 200 字符）
- 去掉控制字符
- 不要把用户输入直接拼进 title

Python 当前是直接替换 title，不做转义；Rust 原生实现应该做得更安全，但要接受和 Python 版本的输出不完全逐字节一致。

---

## 6. 不要把这些逻辑搬进 Rust 渲染器

原生渲染只负责“注入数据”。以下都在浏览器端或解析器里：

- `computeRanks` / `layout` / `fitGraph`
- 网络平面 `buildPlaneView`、ghost 复制、泳道折叠
- 主机组折叠、自动聚合
- 健康状态推导
- 筛选、搜索、高亮、路径分析
- 端口矩阵、冗余分析、图片导出
- localStorage 视图预设

如果 Rust 也计算布局，会和 `template/app.js` 形成第二套真相，后续维护成本很高。

---

## 7. 模板和资源的版本管理

Rust 通常用：

```rust
const INDEX: &str = include_str!("../assets/template/index.html");
const STYLE: &str = include_str!("../assets/template/style.css");
const APP: &str = include_str!("../assets/template/app.js");
const VIS: &str = include_str!("../assets/vis-network.min.js");
```

注意事项：

- 路径相对 Rust 源文件，不是运行目录
- 模板更新后必须重新编译 Rust；如果期望运行时替换模板，就不要用 `include_str!`
- 二进制约增加 1 MB，这是正常的
- 资源必须原样嵌入，不要压缩/格式化 `app.js` 或 `vis-network.min.js`
- 如果 Rust 和 Python 都在仓库里，建议让 Rust 直接引用同一份 `template/` 和 `assets/`，避免复制两份
- 增加 `TEMPLATE_VERSION` 或资源哈希，作为缓存键的一部分
- 发布 Rust 二进制时同时带 `THIRD_PARTY_NOTICES.md`，vis-network 是 Apache-2.0 / MIT 双许可

---

## 8. 数据量、内存和缓存

当前 HTML 约 1 MB，其中：

- `vis-network.min.js` ≈ 689 KB
- `app.js` ≈ 226 KB
- `style.css` ≈ 69 KB
- 模板 ≈ 17 KB
- graph JSON 视数据量而定

Rust 的 `String::replace` 会生成多个中间副本。低 QPS 没问题；高 QPS 建议：

- `String::with_capacity` 预分配
- 单次扫描生成最终 HTML
- 缓存 `hash(graph) + template_version + title → HTML`
- 缓存 HTML 到 Redis/对象存储/本地磁盘，而不是重复渲染
- 限制单次 graph 大小（例如 5–10 MB）和节点数

注意：如果 `generated_at` 放在 graph 里，缓存键要把时间排除，否则永远不命中。

---

## 9. 安全与数据边界

生成的 HTML 包含：

- 设备名、IP、WWN
- 链路、端口、存储信息
- 可能的业务元数据

建议：

- 输出文件权限 `0600`
- 临时目录唯一，不要复用固定路径
- Web 服务返回时设置 `Content-Type: text/html; charset=utf-8`
- 如果通过 HTTP 提供，设置 `X-Content-Type-Options: nosniff`
- 不要把生成 HTML 当作可信静态资源公开
- 对 graph 的字符串长度、设备数、链路数设上限
- title 做 HTML 转义
- graph 内所有值都视为不可信输入；虽然 `app.js` 里大量使用 `esc()`，但不要依赖它兜底
- 不要在 Rust 渲染器里访问网络

如果页面被嵌入到有 CSP 的环境：模板使用内联 `<style>` / `<script>`，需要允许 `'unsafe-inline'`，或者后续改成 nonce 方案。当前是离线单文件，不受影响。

---

## 10. 测试清单

至少覆盖这些用例：

### 10.1 正常路径

- 最小 graph：1 host + 1 switch + 1 storage
- sample graph
- 400 台合成 graph
- 端口视图需要的完整 ports
- `meta.fabric` / `site` / `rack`

### 10.2 对抗字符串

把这些放进设备名、标题、WWN、warning：

```text
</script>
</SCRIPT>
<!--
-->
__TITLE__
/*__STYLE__*/
/*__GRAPH__*/
& < > "
```

断言：

- 页面仍能打开
- `window.__GRAPH__` 解析后值保持不变
- `<title>` / `<h1>` 文本正确
- 没有出现提前闭合的 script
- 没有残留占位符

### 10.3 与 Python 对比

用同一份 graph 分别跑：

```bash
python3 topo.py --graph fixture.json -o /tmp/python.html
cargo run -- --graph fixture.json -o /tmp/rust.html
```

因为 JSON key 顺序和 title 处理可能不同，不要直接 `diff` 整个文件。建议：

- 解析两边 `window.__GRAPH__` 的 JSON，比较语义
- 比较标题文本
- 用 headless browser 加载两边，检查设备/链路数量
- 对固定 title 和固定 graph 做 golden test
- 如果要求逐字节一致，需要统一 JSON 序列化顺序和 title 转义策略

### 10.4 构建期检查

- 5 个占位符数量正确
- `app.js` / `style.css` / `vis-network.min.js` 不包含 `</script>` / `</style>`
- 模板中不存在未替换的 `/*__...__*/`
- 输出是 UTF-8，包含 `<meta charset="utf-8">`

---

## 11. 常见坑速查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 页面白屏 | graph 里的 `</script>` 提前闭合 | JSON 转义 `<` 或 `</` |
| 页面能开但数据少了 | Rust 直接注入未 normalize 的 graph | 补 `ports`/`stats`/`kind`/`meta` 或调用 Python normalize |
| 标题变成 JSON 里的文字 | graph 含 `__TITLE__`，顺序替换污染 | 单次扫描替换 |
| 标题注入 HTML | title 未做 HTML escape | 对 `<>&"` 转义 |
| 统计和画布不一致 | `stats` 用旧数据 | 按最终 devices/links 重算 |
| 端口已连接却显示未连接 | `port.connected` 信任了外部旧值 | 从 links 反推 |
| 链路颜色/筛选不对 | 缺 `link.kind` | 按两端类型推导 |
| 交换机层级不对 | `meta.layer` 缺失 | 默认 1 |
| 存储厂商/型号显示成默认 | `meta.vendor/model` 缺失 | 补默认值或业务值 |
| 构建能过但运行时找不到资源 | 运行时读相对路径 | 用 `include_str!` 或显式配置资源目录 |
| 模板更新后 Rust 没变 | `include_str!` 需要重编译 | CI 强制 rebuild |
| 高 QPS 内存高 | 多次 `replace` + 大字符串 | 预分配、单次渲染、缓存 |
| 生产数据泄露 | HTML 含 WWN/IP | 文件权限、访问控制、不要公开托管 |

---

## 12. 推荐的 Rust 接口

```rust
pub struct RenderOptions {
    pub title: String,
    pub template_version: &'static str,
}

pub fn render_graph(
    graph: &serde_json::Value,
    options: &RenderOptions,
) -> Result<String, RenderError> {
    validate_graph(graph)?;
    let title = escape_html(&options.title);
    let data = escape_json_for_script(graph)?;
    let html = fill_template(
        INDEX,
        &[
            ("/*__STYLE__*/", STYLE),
            ("/*__VIS__*/", VIS),
            ("/*__APP__*/", APP),
            ("/*__GRAPH__*/", &data),
            ("__TITLE__", &title),
        ],
    )?;
    Ok(html)
}

pub fn escape_json_for_script(graph: &serde_json::Value) -> Result<String, RenderError> {
    Ok(serde_json::to_string(graph)?
        .replace('<', "\\u003C")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029"))
}
```

`validate_graph()` 至少检查：

- `schema_version` 1.x
- devices/links 类型
- 设备/端口 ID 唯一
- link 两端存在
- 必需的 `label` / `type` / `ports`

---

## 13. 迁移步骤

1. 先让 Rust 输出 normalized graph，和 Python `--graph` 的输入保持一致
2. 实现单次模板替换 + JSON 转义 + title 转义
3. 用 sample graph 做 Rust/Python 语义对比
4. 用对抗字符串 fixture 做安全测试
5. 把 Rust 渲染器作为主路径，Python 保留为 fallback/对照
6. 增加缓存和资源哈希
7. 发布 Rust 二进制时附带 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`

---

## 14. 一句话总结

Rust 原生渲染的正确边界是：

> **Rust 负责“可信的 normalized graph + 安全转义 + 单次模板替换”；Python 负责解析和 normalize；浏览器负责布局与交互。**

最容易出问题的不是 JSON 拼字符串，而是：

1. 没 normalize 就渲染
2. 顺序替换污染数据
3. `</script>` 没转义
4. title 没转义
5. 模板资源版本不同步
