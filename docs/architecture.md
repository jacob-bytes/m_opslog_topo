# 架构与前端演进路线

本文回答两个问题：

1. 业务变复杂后，如何复用现有的 HTML 生成能力？
2. 把视觉改成 shadcn/ui 风格是否可行？

---

## 1. 两段式：解析与渲染解耦

当前生成器内部其实已经是三段：

```
解析（parse_config / parse_switch_log）
        ▼
建图与归一化（build_payload）
        ▼
渲染（render_html + template + vis-network）
```

现在把中间的图数据固化成**版本化的中间产物**：

```
原始数据（交换机日志 / config.txt / CMDB / API / 工单系统 …）
        │
        │  任意适配器（Python / Go / Java / 前端脚本均可）
        ▼
topology.graph.json     ← 稳定契约，schema v1
        │
        │  topo.py --graph
        ▼
topology.html           ← 单文件离线页面
```

```bash
# 解析原始输入，同时留下中间产物
python3 topo.py --config config.txt --logs ./logs \
    --graph-out graph.json -o topology.html

# 只渲染中间产物（不需要 config / logs）
python3 topo.py --graph graph.json -o topology.html

# 最小可运行样例（手写的 3 台设备）
python3 topo.py --graph sample/mini.graph.json -o mini.html
```

Schema 细节见 [`graph-schema.md`](graph-schema.md)。

### 为什么这能承接复杂业务

- **解析器可替换**：不同厂商日志、CMDB、IPAM、监控系统各自写适配器，最终都产出同一份 `graph.json`
- **渲染器只认契约**：拓扑绘制、分层布局、筛选、路径分析、样式切换全部复用，不需要跟着数据源改
- **中间产物可版本化**：`schema_version` 控制兼容性，1.x 只加字段不破坏语义
- **扩展字段透传**：设备/链路/端口的 `meta` 以及顶层 `groups` 会原样保留，方便后续做业务分组、机房、租户、标签等
- **可离线留档**：同一份 graph.json 可以反复渲染、对比不同版本、放入工单附件

### 适合复杂业务的扩展点

| 需求 | 建议做法 |
| --- | --- |
| 多机房 / 多租户 / 业务分组 | 写进 `device.meta.site` / `tenant` / `group`，或顶层 `groups` |
| 设备型号、固件、资产编号 | `device.meta.vendor/model/serial` |
| 端口速率、光模块、VLAN | `port.meta.speed/optic/vlan` |
| 链路带宽、误码、利用率 | `link.meta` + 自定义字段；渲染器已保留 |
| 新的设备类型（防火墙、负载均衡） | 目前渲染器内置 4 类；扩展需要加一套配色/图标，属于前端改动 |
| 服务端预计算布局 | 现在布局在浏览器端算；如需固定坐标，可在 graph.json 加 `meta.layout` 并在前端读取 |

> 中间产物是 UI 无关的。同一份 graph.json 既可以给现在的 canvas 渲染器，也可以给 React Flow / shadcn 版本，迁移成本可控。

---

## 2. shadcn/ui 可行吗？

**可行，但要先区分“shadcn 的视觉”和“shadcn 本身”。**

shadcn/ui 不是运行时组件库，而是一组**复制进项目的 React + Tailwind + Radix 组件源码**。它带来的价值是：

- 一套成熟的 design token（background / foreground / card / border / primary / muted / radius）
- 一套可访问性良好的交互组件（Dialog、Tabs、Checkbox、Popover、ScrollArea、Toast…）
- 与 Tailwind 生态一致的开发体验

当前产物是 **Python 生成的单文件 HTML + 原生 JS + canvas 绘图**，没有 React/Tailwind 运行时。所以有三条路：

### 方案 A：把 shadcn 的视觉移植到现有原生页面（推荐，若必须保持单文件）

- 用 shadcn 的 CSS 变量和组件样式重写 `template/style.css`
- 把现有按钮、弹窗、标签页、复选框、Toast 换成 shadcn 的视觉规范
- 节点卡片继续用 canvas 绘制（可沿用当前三套风格，或新增一套 “shadcn” 风格）

| | |
| --- | --- |
| 成本 | 中低，主要是 CSS + 少量 DOM 结构 |
| 产出 | 仍然是单文件、离线、无构建、几秒生成 |
| 还原度 | 视觉 80–90%；交互行为是我们自己实现的，不依赖 Radix |
| 风险 | 低；不影响现有 Python 流水线 |

### 方案 B：React + shadcn/ui + React Flow（推荐，若这是一个长期演进的产品）

- `topo.py` 只负责产出 `graph.json`
- 前端用 Vite + React + Tailwind + shadcn/ui 构建
- 图用 React Flow，节点改成真正的 React 组件，可以直接用 shadcn 的 Card/Badge/Progress/ScrollArea
- 构建产物可以由 Python 内联回单文件 HTML，或直接部署为 Web 应用

| | |
| --- | --- |
| 成本 | 中高：引入 Node/pnpm、构建链、React 生态 |
| 产出 | 是真正的 shadcn 应用，组件可维护、可扩展 |
| 还原度 | 100% |
| 风险 | 节点从 canvas 改为 DOM，几百到低四位数节点可行；上万节点需要虚拟化/聚合 |
| 适合 | 有前端团队、需要复杂交互、权限、实时刷新、嵌入式产品 |

### 方案 C：React 外壳 + canvas 图（混合）

- 侧栏、弹窗、筛选器用 shadcn/React
- 拓扑画布继续用 vis-network（保住大图性能）
- Python 仍然只产出 graph.json

| | |
| --- | --- |
| 成本 | 中高，需要处理 React 与 canvas 的生命周期、事件同步 |
| 产出 | shadcn 的外壳 + 高性能画布 |
| 风险 | 两套渲染模型并存，调试成本最高 |
| 适合 | 节点规模很大（数千+）且必须使用 shadcn 视觉 |

### 关键权衡

| 维度 | 方案 A（原生 + shadcn token） | 方案 B（React + shadcn + React Flow） | 方案 C（混合） |
| --- | --- | --- | --- |
| 单文件离线 | ✅ | 可做到（构建后内联） | 可做到 |
| 构建链 | 无 | Node + pnpm | Node + pnpm |
| 视觉还原 | 高 | 最高 | 高 |
| 大图性能 | 最好（canvas） | 中（DOM 节点） | 最好（canvas） |
| 复杂交互/可维护性 | 中 | 高 | 中 |
| 迁移成本 | 低 | 高 | 最高 |

### 我的建议

- **如果 HTML 是“交付物/报告/工单附件”**：选 **A**。保留单文件、零依赖、离线可看，把 shadcn 的 token 和组件视觉移植过来即可。
- **如果这是要长期迭代的内部平台**：选 **B**。graph.json 已经是稳定契约，前端可以独立演进；React Flow 的 HTML 节点也更容易做复杂交互。
- **只有在“必须 shadcn + 必须上万节点”同时成立时**，才考虑 C。

无论选哪条，**中间产物都不用重做**——这正是先把 `graph.json` 抽出来的意义。

---

## 3. 方案 A 的落地情况

**已落地，而且保留了最初那版的观感。**

做法不是把 shadcn 覆盖掉，而是把“外壳”做成可切换的 token 层：

1. **界面风格（外壳）**：`经典` / `shadcn`
   - 经典（默认）：蓝色主色、14px 圆角、柔和阴影，恢复最初那版的观感
   - shadcn：zinc 中性色、8/12px 圆角、细边框、黑色主按钮、Dialog/Tabs/Checkbox/Badge/Toast 的 shadcn 形态
   - 两者共用同一套 DOM 和组件结构，只切换 CSS token 与少量圆角/阴影；切换不重建图
2. **节点风格**：线稿（默认）/ 玻璃 / shadcn / 机架，独立于界面风格
   - 经典 + 线稿 = 最初那版
   - shadcn + shadcn = 完整 shadcn 视觉
   - shadcn 节点：白底/深底中性卡片，无类型色；靠线框图标、文字标签和端口点阵区分，未识别设备虚线边框
3. **默认组合**：经典外壳 + 线稿节点（打开即是最初那版）
4. **持久化**：`topo-shell`（界面）、`topo-style-v3`（节点）分别记忆
5. **验证**：light/dark、经典/shadcn、设备/端口视图、筛选器与筛选条均已截图对比

> 因为组件结构从一开始就是按 shadcn 的形态搭的（Button/Dialog/Tabs/Checkbox/Badge/Toast），所以“经典”本质上是一套 shadcn 主题 token，而不是回退到另一套代码。节点仍由 canvas 绘制，不引入 React/Radix，继续单文件、离线、无构建。

> 由于节点仍然由 canvas 绘制，这套方案**不是**引入 React/Radix，而是把 shadcn 的设计语言和组件形态移植到原生页面；好处是继续单文件、离线、无构建。

## 4. 如果走方案 B，接口怎么切

```ts
// graph.json 直接作为前端数据源
type Graph = {
  schema_version: string;
  devices: Device[];
  links: Link[];
  warnings?: Warning[];
  groups?: unknown[];
};
```

- `topo.py --graph-out graph.json` 产出契约
- 前端用 React Flow 的 `nodes`/`edges` 适配层把 `devices`/`links` 转成画布元素
- 筛选、详情、路径分析继续复用同一份数据
- 构建时把 `dist` 内联成单 HTML，或作为静态站点部署

---

## 5. 结论

- **中间产物可行且已经落地**：`--graph-out` / `--graph` 已可用，schema v1 和归一化规则已固定。
- **shadcn 可行**：要视觉就选 A，要生态和长期产品化就选 B；两者都能复用同一份 graph.json。
- 建议先把“数据适配器”和“渲染器”的边界守住，前端风格是可以替换的外壳，不是架构的核心。
