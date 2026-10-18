/* topo.js —— 拓扑图交互层
 * 依赖：vis-network、window.__GRAPH__
 * 设备/网口用 canvas 自定义绘制，放大不失真。
 */
(function () {
  'use strict';

  var G = window.__GRAPH__ || { devices: [], links: [], warnings: [], stats: {} };
  if (!window.vis || !vis.Network) {
    document.body.innerHTML = '<div style="padding:40px;font:14px sans-serif">未加载 vis-network，请重新生成 HTML。</div>';
    return;
  }

  var FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  var MONO = '"SFMono-Regular", ui-monospace, Menlo, Consolas, monospace';
  var TYPE_LABEL = { host: '主机', switch: '交换机', storage: '存储阵列', unknown: '未识别设备' };
  var STYLE_LABELS = { line: '线稿', shadcn: 'shadcn', skeuo: '机架' };
  var exportScale = 1;
  var AUTO_BUNDLE_MIN_LINKS = 300;
  var TYPE_ICON = { host: '▣', switch: '⬡', storage: '▤', unknown: '?' };
  var TYPE_ORDER = { host: 0, switch: 1, unknown: 1, storage: 2 };

  var CARD = {
    light: {
      host: { top: '#ffffff', mid: '#f4f8ff', bottom: '#e4efff', line: '#bfdbfe', accent: '#2563eb', ink: '#0b2a5b', muted: '#5b7290', badge: 'rgba(37,99,235,0.10)' },
      switch: { top: '#fffdf8', mid: '#fff9ec', bottom: '#ffefd0', line: '#fde3a7', accent: '#d97706', ink: '#4a2c00', muted: '#8a6a3a', badge: 'rgba(217,119,6,0.12)' },
      storage: { top: '#f8fffc', mid: '#f1fdf8', bottom: '#d5f9e8', line: '#a7f3d0', accent: '#059669', ink: '#04352a', muted: '#3f7a68', badge: 'rgba(5,150,105,0.12)' },
      unknown: { top: '#fbfcfe', mid: '#f6f9fc', bottom: '#e9eef5', line: '#cbd5e1', accent: '#64748b', ink: '#334155', muted: '#64748b', badge: 'rgba(100,116,139,0.10)' }
    },
    dark: {
      host: { top: '#182c4c', mid: '#132440', bottom: '#0e1c34', line: '#2b4a75', accent: '#60a5fa', ink: '#e6efff', muted: '#9db4d0', badge: 'rgba(96,165,250,0.16)' },
      switch: { top: '#332711', mid: '#2b2110', bottom: '#211a0c', line: '#5c4517', accent: '#fbbf24', ink: '#fef3c7', muted: '#c8a865', badge: 'rgba(251,191,36,0.16)' },
      storage: { top: '#0d2c25', mid: '#0c251f', bottom: '#081d18', line: '#1d5c4a', accent: '#34d399', ink: '#d1fae5', muted: '#7fc9b2', badge: 'rgba(52,211,153,0.16)' },
      unknown: { top: '#1a2638', mid: '#16202f', bottom: '#111a27', line: '#33445c', accent: '#94a3b8', ink: '#e2e8f0', muted: '#94a3b8', badge: 'rgba(148,163,184,0.14)' }
    }
  };

  var KIND_LABEL = { host: '主机链路', switch: '交换机级联', storage: '存储链路', unknown: '未识别链路', other: '其他链路' };
  var KIND_ORDER = ['host', 'switch', 'storage', 'unknown', 'other'];
  var EDGE_COLOR = {
    light: { host: '#60a5fa', switch: '#f59e0b', storage: '#34d399', unknown: '#94a3b8', other: '#a78bfa' },
    dark: { host: '#60a5fa', switch: '#fbbf24', storage: '#34d399', unknown: '#94a3b8', other: '#a78bfa' }
  };

  var PORT_W = 64, PORT_H = 26, PORT_GAP = 30, PORT_OFFSET = 140;
  var CARD_W = 244, CARD_H = 152, COMPACT_W = 210, COMPACT_H = 46;

  /* ------------------------------------------------------------------ */
  /* 数据索引 / 状态                                                     */
  /* ------------------------------------------------------------------ */

  var devById = new Map();
  var portById = new Map();
  (G.devices || []).forEach(function (d) {
    devById.set(d.id, d);
    if (!d.ports) d.ports = [];
    if (!d.ips) d.ips = [];
    d.ports.forEach(function (p) { p.device = d.id; portById.set(p.id, p); });
  });

  var allLinks = [];
  var seq = 0;
  (G.links || []).forEach(function (raw) {
    if (!raw || !raw.a || !raw.b) return;
    var da = devById.get(raw.a.device);
    var db = devById.get(raw.b.device);
    if (!da || !db) return;
    allLinks.push({
      id: 'l' + (seq++),
      a: { device: raw.a.device, port: raw.a.port || null, wwn: raw.a.wwn || null },
      b: { device: raw.b.device, port: raw.b.port || null, wwn: raw.b.wwn || null },
      kind: raw.kind || 'other',
      status: raw.status || null,
      speed: raw.speed || null,
      source: raw.source || ''
    });
  });

  var state = {
    gran: 'device',
    types: { host: true, switch: true, storage: true, unknown: true },
    kinds: { host: true, switch: true, storage: true, unknown: true, other: true },
    offDevices: new Set(),
    offPorts: new Set(),
    hiddenLayers: new Set(),
    onlyUp: false,
    hideIsolated: true,
    collapseHosts: false,
    autoBundle: true,
    sideTab: 'filter',
    layout: 'layered',
    collapsedPlanes: new Set(),
    expandedGroups: new Set(),
    scope: 'all',
    showUnused: false,
    showWwn: false,
    isolateQuery: false,
    query: '',
    spacing: 1,
    theme: 'light',
    style: 'line',
    shell: 'classic',
    focus: null,
    focusCenter: null,
    searchHits: new Set(),
    pinned: new Set(),
    pathNodes: null,
    pathPairs: null,
    pathMode: false,
    pathSel: [],
    current: null,
    view: { devices: new Set(), links: [], nodes: [], edges: [] },
    nodes: [],
    edges: [],
    nodeById: new Map()
  };

  var network = null;
  var nodesDS = null;
  var edgesDS = null;
  var nodeFlags = new Map();
  var rankCols = [];
  var planeCols = [];
  var matrix = { device: null, query: '', onlyUsed: false, rows: [] };
  var command = { open: false, items: [], active: 0 };
  var redundancy = { data: null, query: '' };

  var picker = {
    open: false,
    tab: 'all',
    query: '',
    expanded: new Set(),
    expandedHostGroups: new Set(),
    draft: null
  };

  /* ------------------------------------------------------------------ */
  /* 通用工具                                                           */
  /* ------------------------------------------------------------------ */

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function alpha(hex, a) {
    var h = String(hex || '#999').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function shortWwn(w) {
    if (!w) return '';
    var parts = String(w).split(':');
    return parts.length > 3 ? '…:' + parts.slice(-3).join(':') : w;
  }

  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function palette() { return CARD[state.theme]; }
  function edgeColors() { return EDGE_COLOR[state.theme]; }

  var HEALTH_LABEL = { ok: '正常', degraded: '降级', down: '离线', unknown: '未知' };
  var HEALTH_RANK = { ok: 0, unknown: 1, degraded: 2, down: 3 };
  function healthColors() {
    return state.theme === 'dark'
      ? { ok: '#34d399', degraded: '#fbbf24', down: '#f87171', unknown: '#71717a' }
      : { ok: '#10b981', degraded: '#f59e0b', down: '#ef4444', unknown: '#a1a1aa' };
  }
  function linkHealth(l) {
    if (!l) return 'unknown';
    var s = String(l.status || '').toLowerCase();
    if (/(down|offline|failed|error|disabled|离线|断开|故障)/.test(s)) return 'down';
    if (/(up|online|active|connected|在线|正常)/.test(s)) return 'up';
    return 'unknown';
  }
  function worstHealth(list) {
    var worst = 'ok';
    (list || []).forEach(function (h) {
      if ((HEALTH_RANK[h] || 0) > (HEALTH_RANK[worst] || 0)) worst = h;
    });
    return worst;
  }
  var healthCache = new Map();
  function deviceHealth(d) {
    if (!d) return 'unknown';
    if (d._realId) return deviceHealth(devById.get(d._realId));
    if (d._group) return d._health || 'unknown';
    if (healthCache.has(d.id)) return healthCache.get(d.id);
    var down = 0, up = 0;
    allLinks.forEach(function (l) {
      if (l.a.device !== d.id && l.b.device !== d.id) return;
      var h = linkHealth(l);
      if (h === 'down') down++;
      else if (h === 'up') up++;
    });
    var out = down > 0 ? (up > 0 ? 'degraded' : 'down') : (up > 0 ? 'ok' : 'unknown');
    healthCache.set(d.id, out);
    return out;
  }
  function drawHealthDot(ctx, node, x, y) {
    var d = devById.get(node._device);
    if (!d) return;
    var h = d._group ? (d._health || 'unknown') : deviceHealth(d);
    var color = healthColors()[h] || healthColors().unknown;
    var dotX = x - node._w / 2 + 7;
    var dotY = y - node._h / 2 + 7;
    ctx.save();
    ctx.beginPath();
    ctx.arc(dotX, dotY, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = state.theme === 'dark' ? 'rgba(9,9,11,.8)' : 'rgba(255,255,255,.9)';
    ctx.stroke();
    ctx.restore();
  }

  function portLabel(portId) {
    var p = portId ? portById.get(portId) : null;
    return p ? p.label : (portId ? String(portId).split('#').pop() : '—');
  }

  function endpointText(ep) {
    var d = devById.get(ep.device);
    return (d ? d.label : ep.device) + ':' + portLabel(ep.port);
  }

  function nodeDeviceId(nodeId) {
    var n = state.nodeById.get(nodeId);
    return n ? n._device : nodeId;
  }

  function displayName(d) {
    if (!d) return '';
    return d.type === 'unknown' ? '未识别设备' : d.label;
  }

  var SEARCH_KEYS = {
    site: 1, fabric: 1, rack: 1, type: 1, layer: 1, status: 1,
    vendor: 1, model: 1, ip: 1, wwn: 1, port: 1, name: 1
  };

  function parseDeviceQuery(q) {
    var filters = {}, text = [];
    String(q || '').trim().split(/\s+/).forEach(function (token) {
      var m = token.match(/^([a-z_]+):(.*)$/i);
      if (m && SEARCH_KEYS[m[1].toLowerCase()] && m[2] !== '') {
        var key = m[1].toLowerCase();
        if (!filters[key]) filters[key] = [];
        filters[key].push(m[2].toLowerCase());
      } else if (token) {
        text.push(token.toLowerCase());
      }
    });
    return { text: text.join(' ').trim(), filters: filters };
  }

  function deviceTextMatch(d, text) {
    if (!text) return false;
    if (String(d.label || '').toLowerCase().indexOf(text) >= 0) return true;
    if (String(d.wwn || '').toLowerCase().indexOf(text) >= 0) return true;
    for (var i = 0; i < d.ips.length; i++) if (String(d.ips[i]).toLowerCase().indexOf(text) >= 0) return true;
    if (d.type === 'storage') {
      var info = storageInfo(d);
      if (String(info.vendor).toLowerCase().indexOf(text) >= 0) return true;
      if (String(info.model).toLowerCase().indexOf(text) >= 0) return true;
    }
    if (String(d.meta && d.meta.fabric || '').toLowerCase().indexOf(text) >= 0) return true;
    if (String(d.meta && d.meta.site || '').toLowerCase().indexOf(text) >= 0) return true;
    return false;
  }

  function deviceFilterMatch(d, filters) {
    function values(key) { return filters[key] || []; }
    function metaMatch(key) {
      var vals = values(key);
      if (!vals.length) return true;
      var actual = String((d.meta && d.meta[key]) || '').toLowerCase();
      return vals.some(function (v) { return actual.indexOf(v) >= 0; });
    }
    if (!metaMatch('site') || !metaMatch('fabric') || !metaMatch('rack')) return false;
    var types = values('type');
    if (types.length && types.indexOf(String(d.type).toLowerCase()) < 0) return false;
    var layers = values('layer');
    if (layers.length && (d.type !== 'switch' || layers.indexOf(String(switchLayer(d))) < 0)) return false;
    var statuses = values('status');
    if (statuses.length) {
      var h = deviceHealth(d);
      var ok = statuses.some(function (v) {
        if (v === 'abnormal' || v === 'issue') return h === 'degraded' || h === 'down';
        if (v === 'up' || v === 'ok' || v === 'normal') return h === 'ok';
        if (v === 'down' || v === 'offline') return h === 'down' || h === 'degraded';
        return h === v;
      });
      if (!ok) return false;
    }
    if (d.type === 'storage') {
      var info = storageInfo(d);
      if (values('vendor').length && values('vendor').every(function (v) { return String(info.vendor).toLowerCase().indexOf(v) < 0; })) return false;
      if (values('model').length && values('model').every(function (v) { return String(info.model).toLowerCase().indexOf(v) < 0; })) return false;
    } else if (values('vendor').length || values('model').length) {
      return false;
    }
    var ips = values('ip');
    if (ips.length && !(d.ips || []).some(function (ip) { return ips.some(function (v) { return String(ip).toLowerCase().indexOf(v) >= 0; }); })) return false;
    var wwns = values('wwn');
    if (wwns.length && !wwns.some(function (v) { return String(d.wwn || '').toLowerCase().indexOf(v) >= 0; })) return false;
    var ports = values('port');
    if (ports.length && !(d.ports || []).some(function (p) {
      var s = (String(p.label || '') + ' ' + String(p.wwn || '')).toLowerCase();
      return ports.some(function (v) { return s.indexOf(v) >= 0; });
    })) return false;
    var names = values('name');
    if (names.length && !names.some(function (v) {
      return String(d.label || '').toLowerCase().indexOf(v) >= 0 ||
        (d.ips || []).some(function (ip) { return String(ip).toLowerCase().indexOf(v) >= 0; });
    })) return false;
    return true;
  }

  function deviceOnlyMatches(d, q) {
    var parsed = parseDeviceQuery(q);
    if (!deviceFilterMatch(d, parsed.filters)) return false;
    if (parsed.text) return deviceTextMatch(d, parsed.text);
    return Object.keys(parsed.filters).length > 0;
  }

  function deviceMatches(d, q) {
    var parsed = parseDeviceQuery(q);
    if (!deviceFilterMatch(d, parsed.filters)) return false;
    if (!parsed.text) return Object.keys(parsed.filters).length > 0;
    if (deviceTextMatch(d, parsed.text)) return true;
    for (var j = 0; j < d.ports.length; j++) {
      if (String(d.ports[j].label || '').toLowerCase().indexOf(parsed.text) >= 0) return true;
      if (String(d.ports[j].wwn || '').toLowerCase().indexOf(parsed.text) >= 0) return true;
    }
    return false;
  }

  function portMatchesQuery(p, q) {
    if (!q) return false;
    if (/[a-z_]+:/i.test(q)) return false;
    var text = String(q).toLowerCase();
    return String(p.label || '').toLowerCase().indexOf(text) >= 0 ||
      String(p.wwn || '').toLowerCase().indexOf(text) >= 0;
  }

  function switchLayer(d) {
    return (d.meta && d.meta.layer) || 1;
  }

  function storageInfo(d) {
    var meta = (d && d.meta) || {};
    var vendor = meta.vendor || 'Huawei';
    var model = meta.model || 'OceanStor';
    return { vendor: vendor, model: model, huawei: /huawei|华为/i.test(vendor) };
  }

  function storageSub(d) {
    var info = storageInfo(d);
    var ip = d.ips && d.ips.length ? ' · ' + d.ips[0] : '';
    return info.model + ip;
  }

  function storageIpText(d) {
    return d.ips && d.ips.length ? d.ips[0] : '未配置 IP';
  }

  function storageVendorLabel(d) {
    var info = storageInfo(d);
    return info.huawei ? 'HUAWEI' : String(info.vendor).toUpperCase();
  }

  function storageVendorColor(d) {
    var info = storageInfo(d);
    if (!info.huawei) return state.theme === 'dark' ? '#a1a1aa' : '#71717a';
    return state.theme === 'dark' ? '#ff5a5f' : '#c7000b';
  }

  function drawStorageVendor(ctx, d, x, y, neutral) {
    if (!d || d.type !== 'storage') return;
    var label = storageVendorLabel(d);
    var color = neutral ? (state.theme === 'dark' ? '#a1a1aa' : '#71717a') : storageVendorColor(d);
    ctx.save();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = '700 8px ' + FONT;
    ctx.fillStyle = color;
    ctx.fillText(label, x, y);
    var tw = ctx.measureText(label).width;
    ctx.beginPath();
    ctx.arc(x - tw - 6, y, 1.8, 0, 7);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  function deviceOn(d) {
    if (!d) return false;
    if (!state.types[d.type]) return false;
    if (state.offDevices.has(d.id)) return false;
    if (d.type === 'switch' && state.hiddenLayers.has(switchLayer(d))) return false;
    return true;
  }

  function linkPortsOn(l) {
    if (l.a.port && state.offPorts.has(l.a.port)) return false;
    if (l.b.port && state.offPorts.has(l.b.port)) return false;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* canvas 绘制：拟真设备卡片 / 端口                                     */
  /* ------------------------------------------------------------------ */

  function rrect(ctx, x, y, w, h, r) {
    var rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function rrectSides(ctx, x, y, w, h, tl, tr, br, bl) {
    tl = Math.min(tl, w / 2, h / 2);
    tr = Math.min(tr, w / 2, h / 2);
    br = Math.min(br, w / 2, h / 2);
    bl = Math.min(bl, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    ctx.arcTo(x + w, y, x + w, y + tr, tr);
    ctx.lineTo(x + w, y + h - br);
    ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
    ctx.lineTo(x + bl, y + h);
    ctx.arcTo(x, y + h, x, y + h - bl, bl);
    ctx.lineTo(x, y + tl);
    ctx.arcTo(x, y, x + tl, y, tl);
    ctx.closePath();
  }

  function clipText(ctx, text, maxW) {
    text = String(text == null ? '' : text);
    if (ctx.measureText(text).width <= maxW) return text;
    var s = text;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  function metalPanel(ctx, x, y, w, h) {
    var g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#3c4a5e');
    g.addColorStop(0.35, '#1f2b3d');
    g.addColorStop(1, '#0a1220');
    rrect(ctx, x, y, w, h, 5);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 1;
    ctx.stroke();
    rrect(ctx, x + 1, y + 1, w - 2, 3, 2);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fill();
  }

  function hardwareBezel(ctx, x, y, w, h) {
    var g = ctx.createLinearGradient(0, y - 3, 0, y + h + 3);
    if (state.theme === 'dark') {
      g.addColorStop(0, '#24334c');
      g.addColorStop(1, '#0d1728');
    } else {
      g.addColorStop(0, '#f8fafc');
      g.addColorStop(1, '#d9e2ee');
    }
    rrect(ctx, x - 3, y - 3, w + 6, h + 6, 7);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = state.theme === 'dark' ? 'rgba(148,163,184,0.2)' : 'rgba(100,116,139,0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();
    [[x + 1, y + 1], [x + w - 1, y + 1], [x + 1, y + h - 1], [x + w - 1, y + h - 1]].forEach(function (p) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], 1.4, 0, 7);
      ctx.fillStyle = state.theme === 'dark' ? 'rgba(0,0,0,0.5)' : 'rgba(100,116,139,0.4)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p[0] - 0.4, p[1] - 0.4, 0.65, 0, 7);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fill();
    });
  }

  function drawEar(ctx, x, y, w, h) {
    var g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, '#1e293b');
    g.addColorStop(1, '#0b1220');
    rrect(ctx, x, y, w, h, 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(148,163,184,0.35)';
    ctx.lineWidth = 0.7;
    ctx.stroke();
    ctx.fillStyle = 'rgba(148,163,184,0.55)';
    ctx.fillRect(x + w / 2 - 0.5, y + 3, 1, h - 6);
  }

  function drawCaddy(ctx, x, y, w, h, accent) {
    var g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#2b3648');
    g.addColorStop(0.5, '#141e2e');
    g.addColorStop(1, '#080f1a');
    rrect(ctx, x, y, w, h, 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(148,163,184,0.38)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.fillStyle = 'rgba(148,163,184,0.45)';
    ctx.fillRect(x + 3, y + h / 2 - 1, w - 12, 1.6);
    ctx.fillStyle = 'rgba(5,11,22,0.9)';
    ctx.fillRect(x + w - 6, y + h / 2 - 2.5, 3, 5);
    ctx.beginPath();
    ctx.arc(x + w - 4.5, y + 3.5, 1.2, 0, 7);
    ctx.fillStyle = accent;
    ctx.fill();
  }

  function drawHostHardware(ctx, x, y, w, h) {
    metalPanel(ctx, x, y, w, h);
    drawEar(ctx, x + 3, y + 9, 4, h - 18);
    drawEar(ctx, x + w - 7, y + 9, 4, h - 18);

    var bayW = Math.min(54, w * 0.235);
    var bayH = Math.max(18, h * 0.37);
    var bayY = y + (h - bayH) / 2;
    for (var i = 0; i < 2; i++) {
      var bx = x + 13 + i * (bayW + 5);
      drawCaddy(ctx, bx, bayY, bayW, bayH, i === 0 ? '#22c55e' : '#22d3ee');
      ctx.strokeStyle = 'rgba(148,163,184,0.5)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(bx + 6, bayY + 5);
      ctx.lineTo(bx + 9, bayY + bayH / 2);
      ctx.lineTo(bx + 6, bayY + bayH - 5);
      ctx.stroke();
    }

    var vx = x + 13 + 2 * (bayW + 5) + 6;
    var vRight = x + w - 38;
    for (var sx = vx; sx < vRight; sx += 5) {
      ctx.fillStyle = 'rgba(148,163,184,0.22)';
      ctx.fillRect(sx, y + 10, 1.5, h - 20);
    }

    var cx = x + w - 21;
    var cy = y + h / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 6.2, 0, 7);
    ctx.fillStyle = '#0a1220';
    ctx.fill();
    ctx.strokeStyle = 'rgba(148,163,184,0.55)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 2.1, 0, 7);
    ctx.fillStyle = '#22c55e';
    ctx.fill();

    ctx.font = '600 6.5px ' + MONO;
    ctx.fillStyle = 'rgba(226,232,240,0.32)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('1U', x + 9, y + h - 6);
  }

  function drawSwitchHardware(ctx, x, y, w, h) {
    metalPanel(ctx, x, y, w, h);
    drawEar(ctx, x + 3, y + 9, 4, h - 18);
    drawEar(ctx, x + w - 7, y + 9, 4, h - 18);

    var rows = 2, cols = 10, pitch = 10.4, pw = 7.2, ph = 7.2;
    var startX = x + 13, startY = y + 12;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var px = startX + c * pitch + (c >= 5 ? 4 : 0);
        var py = startY + r * 13;
        var pg = ctx.createLinearGradient(0, py, 0, py + ph);
        pg.addColorStop(0, '#0a1220');
        pg.addColorStop(1, '#020617');
        rrect(ctx, px, py, pw, ph, 1.2);
        ctx.fillStyle = pg;
        ctx.fill();
        ctx.strokeStyle = 'rgba(148,163,184,0.4)';
        ctx.lineWidth = 0.6;
        ctx.stroke();
        var lit = (r * cols + c) % 3 !== 0;
        ctx.beginPath();
        ctx.arc(px + 1.8, py + 1.8, 0.9, 0, 7);
        ctx.fillStyle = lit ? '#34d399' : '#22d3ee';
        ctx.fill();
      }
    }

    var sepX = startX + 5 * pitch + 1.5;
    ctx.strokeStyle = 'rgba(148,163,184,0.18)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(sepX, y + 8);
    ctx.lineTo(sepX, y + h - 8);
    ctx.stroke();

    // fan grilles
    for (var f = 0; f < 2; f++) {
      var fx = x + 128 + f * 17;
      var fy = y + h / 2;
      ctx.beginPath();
      ctx.arc(fx, fy, 6.4, 0, 7);
      ctx.strokeStyle = 'rgba(148,163,184,0.28)';
      ctx.lineWidth = 0.9;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(fx, fy, 1.6, 0, 7);
      ctx.fillStyle = 'rgba(148,163,184,0.3)';
      ctx.fill();
      for (var a = 0; a < 4; a++) {
        var ang = a * Math.PI / 2 + 0.5;
        ctx.beginPath();
        ctx.moveTo(fx + Math.cos(ang) * 2, fy + Math.sin(ang) * 2);
        ctx.lineTo(fx + Math.cos(ang) * 6, fy + Math.sin(ang) * 6);
        ctx.stroke();
      }
    }

    // SFP cages
    var sfpX = x + w - 53;
    for (var s = 0; s < 2; s++) {
      var sx = sfpX + s * 18;
      var sg = ctx.createLinearGradient(0, y + 10, 0, y + h - 10);
      sg.addColorStop(0, '#5b6b82');
      sg.addColorStop(0.5, '#2a3648');
      sg.addColorStop(1, '#111a28');
      rrect(ctx, sx, y + 10, 15, h - 20, 2);
      ctx.fillStyle = sg;
      ctx.fill();
      ctx.strokeStyle = 'rgba(203,213,225,0.55)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.fillStyle = '#050b16';
      ctx.fillRect(sx + 3, y + 14, 9, h - 28);
      ctx.fillStyle = 'rgba(226,232,240,0.35)';
      ctx.fillRect(sx + 4, y + h - 16, 7, 1.4);
    }

    for (var l = 0; l < 3; l++) {
      ctx.beginPath();
      ctx.arc(x + w - 13, y + 15 + l * 7, 1.4, 0, 7);
      ctx.fillStyle = l === 0 ? '#22c55e' : (l === 1 ? '#22d3ee' : '#f59e0b');
      ctx.fill();
    }

    ctx.font = '600 6.5px ' + MONO;
    ctx.fillStyle = 'rgba(226,232,240,0.32)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('1U', x + 9, y + h - 6);
  }

  function drawStorageHardware(ctx, x, y, w, h) {
    metalPanel(ctx, x, y, w, h);
    drawEar(ctx, x + 3, y + 9, 4, h - 18);
    drawEar(ctx, x + w - 7, y + 9, 4, h - 18);

    var cw = 22, ch = 15, gx = 2, gy = 5;
    var startX = x + 11, startY = y + 9;
    for (var r = 0; r < 2; r++) {
      for (var c = 0; c < 6; c++) {
        drawCaddy(ctx, startX + c * (cw + gx), startY + r * (ch + gy), cw, ch,
          (r + c) % 3 === 0 ? '#22d3ee' : '#22c55e');
      }
    }

    var cx = x + w - 52;
    var cg = ctx.createLinearGradient(0, y + 8, 0, y + h - 8);
    cg.addColorStop(0, '#2c3a4f');
    cg.addColorStop(1, '#0d1728');
    rrect(ctx, cx, y + 8, 40, h - 16, 3);
    ctx.fillStyle = cg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(148,163,184,0.4)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    for (var l = 0; l < 2; l++) {
      ctx.beginPath();
      ctx.arc(cx + 8, y + 18 + l * 9, 1.8, 0, 7);
      ctx.fillStyle = l === 0 ? '#22c55e' : '#22d3ee';
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(226,232,240,0.3)';
    ctx.fillRect(cx + 16, y + 14, 16, 1.4);
    ctx.fillRect(cx + 16, y + 20, 16, 1.4);

    ctx.font = '600 5.5px ' + MONO;
    ctx.fillStyle = 'rgba(226,232,240,0.35)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('CTRL', cx + 6, y + h - 9);
    ctx.fillStyle = '#c7000b';
    ctx.font = '700 5.5px ' + FONT;
    ctx.fillText('HUAWEI', x + 10, y + h - 6);
    ctx.fillStyle = 'rgba(226,232,240,0.45)';
    ctx.font = '600 5px ' + FONT;
    ctx.fillText('OceanStor', x + 36, y + h - 6);
  }

  function drawUnknownHardware(ctx, x, y, w, h) {
    ctx.save();
    ctx.setLineDash([5, 4]);
    rrect(ctx, x, y, w, h, 6);
    ctx.fillStyle = state.theme === 'dark' ? 'rgba(148,163,184,0.04)' : 'rgba(148,163,184,0.06)';
    ctx.fill();
    ctx.strokeStyle = state.theme === 'dark' ? 'rgba(148,163,184,0.3)' : 'rgba(100,116,139,0.32)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 24px ' + FONT;
    ctx.fillStyle = state.theme === 'dark' ? 'rgba(148,163,184,0.5)' : 'rgba(100,116,139,0.5)';
    ctx.fillText('?', x + w / 2, y + h / 2 - 3);
    ctx.font = '600 6px ' + FONT;
    ctx.fillStyle = state.theme === 'dark' ? 'rgba(148,163,184,0.4)' : 'rgba(100,116,139,0.4)';
    ctx.fillText('U N M A N A G E D', x + w / 2, y + h - 10);
    ctx.restore();
  }

  function drawHardware(ctx, type, x, y, w, h) {
    hardwareBezel(ctx, x, y, w, h);
    if (type === 'host') drawHostHardware(ctx, x, y, w, h);
    else if (type === 'switch') drawSwitchHardware(ctx, x, y, w, h);
    else if (type === 'storage') drawStorageHardware(ctx, x, y, w, h);
    else drawUnknownHardware(ctx, x, y, w, h);
  }

  function drawRackBody(ctx, node, l, t, w, h, pal) {
    var top = t + 42;
    var bottom = t + h - 10;
    if (bottom - top < 40) return;
    var dark = state.theme === 'dark';

    // 机身底纹
    var bg = ctx.createLinearGradient(0, top, 0, bottom);
    bg.addColorStop(0, dark ? 'rgba(148,163,184,0.02)' : 'rgba(15,23,42,0.015)');
    bg.addColorStop(1, dark ? 'rgba(0,0,0,0.16)' : 'rgba(15,23,42,0.055)');
    rrect(ctx, l + 6, top, w - 12, bottom - top, 8);
    ctx.fillStyle = bg;
    ctx.fill();

    // 竖向导轨
    [l + 8, l + w - 17].forEach(function (rx) {
      var rg = ctx.createLinearGradient(rx, 0, rx + 9, 0);
      if (dark) {
        rg.addColorStop(0, 'rgba(148,163,184,0.22)');
        rg.addColorStop(0.45, 'rgba(51,65,85,0.85)');
        rg.addColorStop(1, 'rgba(148,163,184,0.1)');
      } else {
        rg.addColorStop(0, 'rgba(148,163,184,0.55)');
        rg.addColorStop(0.45, 'rgba(241,245,249,0.95)');
        rg.addColorStop(1, 'rgba(148,163,184,0.38)');
      }
      rrect(ctx, rx, top + 8, 8, bottom - top - 16, 4);
      ctx.fillStyle = rg;
      ctx.fill();
      ctx.strokeStyle = dark ? 'rgba(0,0,0,0.35)' : 'rgba(100,116,139,0.25)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    });

    // 横向分缝
    for (var yy = top + 12; yy < bottom - 8; yy += 26) {
      ctx.strokeStyle = dark ? 'rgba(148,163,184,0.07)' : 'rgba(15,23,42,0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(l + 20, yy);
      ctx.lineTo(l + w - 20, yy);
      ctx.stroke();
    }

    // 空闲槽位（挡板），从指标行下方开始
    var plateTop = t + 146;
    for (var py = plateTop; py < bottom - 10; py += 29) {
      var ph = 24;
      if (py + ph > bottom - 8) ph = bottom - 8 - py;
      if (ph < 10) break;
      var pg = ctx.createLinearGradient(0, py, 0, py + ph);
      pg.addColorStop(0, dark ? 'rgba(148,163,184,0.07)' : 'rgba(15,23,42,0.035)');
      pg.addColorStop(1, dark ? 'rgba(0,0,0,0.16)' : 'rgba(15,23,42,0.07)');
      rrect(ctx, l + 22, py, w - 44, ph, 4);
      ctx.fillStyle = pg;
      ctx.fill();
      ctx.strokeStyle = dark ? 'rgba(148,163,184,0.1)' : 'rgba(15,23,42,0.07)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
      // 散热缝
      for (var vx2 = l + 34; vx2 < l + w - 52; vx2 += 6) {
        ctx.fillStyle = dark ? 'rgba(0,0,0,0.22)' : 'rgba(15,23,42,0.08)';
        ctx.fillRect(vx2, py + 9, 2, ph - 18);
      }
      ctx.beginPath();
      ctx.arc(l + w - 32, py + ph / 2, 1.2, 0, 7);
      ctx.fillStyle = alpha(pal.accent, 0.55);
      ctx.fill();
    }

    // 两侧端口槽
    ['L', 'R'].forEach(function (side) {
      var n = node._rows[side] || 0;
      for (var i = 0; i < n; i++) {
        var rowY = node.y + (i - (n - 1) / 2) * PORT_GAP;
        if (rowY < top + 6 || rowY > bottom - 6) continue;
        var sx = side === 'L' ? l - 2 : l + w - 8;
        rrect(ctx, sx, rowY - 7, 10, 14, 2);
        ctx.fillStyle = dark ? '#050b16' : '#b9c6d6';
        ctx.fill();
        ctx.strokeStyle = dark ? 'rgba(148,163,184,0.3)' : 'rgba(15,23,42,0.2)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(sx + 5, rowY, 1.2, 0, 7);
        ctx.fillStyle = alpha(pal.accent, 0.9);
        ctx.fill();
      }
    });

    // 螺丝
    for (var sy = top + 14; sy < bottom - 8; sy += 46) {
      [l + 12, l + w - 12].forEach(function (sx2) {
        ctx.beginPath();
        ctx.arc(sx2, sy, 1.4, 0, 7);
        ctx.fillStyle = dark ? 'rgba(0,0,0,0.5)' : 'rgba(100,116,139,0.38)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(sx2 - 0.3, sy - 0.3, 0.6, 0, 7);
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fill();
      });
    }
  }

  function drawSkeuoDeviceNode(info, node, flags) {
    var ctx = info.ctx, x = info.x, y = info.y;
    var w = node._w, h = node._h;
    var d = devById.get(node._device);
    if (!d) return { drawNode: function () {}, nodeDimensions: { width: w, height: h } };
    var pal = palette()[d.type] || palette().unknown;
    var compact = node._compact;
    var dim = !!flags.dim;
    var l = x - w / 2, t = y - h / 2;
    var dark = state.theme === 'dark';

    ctx.save();
    if (dim) ctx.globalAlpha = 0.24;

    // 卡片投影（悬停/选中时带类型色光晕）
    var hot = info.state.hover || info.state.selected;
    ctx.shadowColor = hot
      ? alpha(pal.accent, dark ? 0.45 : 0.35)
      : (dark ? 'rgba(0,0,0,0.6)' : 'rgba(15,23,42,0.18)');
    ctx.shadowBlur = hot ? 28 : (compact ? 8 : 22);
    ctx.shadowOffsetY = compact ? 3 : 8;
    var g = ctx.createLinearGradient(l, t, l, t + h);
    g.addColorStop(0, pal.top);
    g.addColorStop(0.62, pal.mid);
    g.addColorStop(1, pal.bottom);
    rrect(ctx, l, t, w, h, compact ? 10 : 16);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // 左上柔光 + 顶部高光
    var rg = ctx.createRadialGradient(l + w * 0.28, t + 6, 2, l + w * 0.28, t + 6, w * 0.85);
    rg.addColorStop(0, dark ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.65)');
    rg.addColorStop(0.55, 'rgba(255,255,255,0)');
    rrect(ctx, l + 1, t + 1, w - 2, h - 2, compact ? 9 : 15);
    ctx.fillStyle = rg;
    ctx.fill();

    // 内描边
    rrect(ctx, l + 1.2, t + 1.2, w - 2.4, h - 2.4, compact ? 9 : 15);
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 外边框
    var border = pal.line, bw = 1.3;
    if (info.state.hover || info.state.selected) { border = pal.accent; bw = 2.2; }
    if (flags.hit) { border = '#f59e0b'; bw = 3; }
    if (flags.path) { border = '#ef4444'; bw = 3; }
    if (flags.center) { border = pal.accent; bw = 2.6; }
    rrect(ctx, l + 0.7, t + 0.7, w - 1.4, h - 1.4, compact ? 10 : 16);
    ctx.strokeStyle = border;
    ctx.lineWidth = bw;
    ctx.stroke();

    // 顶部细色条
    var stripW = w - 44;
    var sg = ctx.createLinearGradient(l + 22, 0, l + 22 + stripW, 0);
    sg.addColorStop(0, alpha(pal.accent, 0));
    sg.addColorStop(0.18, alpha(pal.accent, 0.55));
    sg.addColorStop(0.82, alpha(pal.accent, 0.55));
    sg.addColorStop(1, alpha(pal.accent, 0));
    ctx.fillStyle = sg;
    ctx.fillRect(l + 22, t + 0.9, stripW, 2);

    if (compact) {
      var cs = 26, cix = l + 9, ciy = t + (h - cs) / 2;
      rrect(ctx, cix, ciy, cs, cs, 7);
      ctx.fillStyle = pal.badge;
      ctx.fill();
      ctx.strokeStyle = alpha(pal.accent, 0.22);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.font = '14px ' + FONT;
      ctx.fillStyle = pal.accent;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(TYPE_ICON[d.type], cix + cs / 2, ciy + cs / 2 + 1);

      ctx.textAlign = 'left';
      ctx.font = '600 12px ' + FONT;
      ctx.fillStyle = pal.ink;
      ctx.fillText(clipText(ctx, d.type === 'unknown' ? '未识别' : d.label, w - 118), l + 43, t + h / 2 + 1);

      ctx.textAlign = 'right';
      ctx.font = '600 9.5px ' + FONT;
      ctx.fillStyle = pal.muted;
      ctx.fillText(d._group ? d._groupCount + ' 台' : d.ports.length + ' 口', l + w - 11, t + h / 2 + 1);
    } else {
      // 长卡片：先铺机架机身
      if (h > 168) drawRackBody(ctx, node, l, t, w, h, pal);

      // 类型图标
      var is = 26, ix = l + 13, iy = t + 11;
      var ig = ctx.createLinearGradient(ix, iy, ix, iy + is);
      ig.addColorStop(0, alpha(pal.accent, 0.2));
      ig.addColorStop(1, alpha(pal.accent, 0.06));
      rrect(ctx, ix, iy, is, is, 8);
      ctx.fillStyle = ig;
      ctx.fill();
      ctx.strokeStyle = alpha(pal.accent, 0.28);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.font = '14px ' + FONT;
      ctx.fillStyle = pal.accent;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(TYPE_ICON[d.type], ix + is / 2, iy + is / 2 + 1);

      // 类型徽标
      ctx.font = '600 9.5px ' + FONT;
      var badgeText = d.type === 'unknown' ? '未识别' : (d.type === 'storage' ? storageVendorLabel(d) : (TYPE_LABEL[d.type] || '设备'));
      var badgeInk = d.type === 'storage' ? storageVendorColor(d) : pal.accent;
      var btw = ctx.measureText(badgeText).width + 16;
      var bx = l + w - 13 - btw;
      rrect(ctx, bx, t + 10, btw, 18, 9);
      ctx.fillStyle = d.type === 'storage' ? alpha(badgeInk, 0.1) : pal.badge;
      ctx.fill();
      ctx.strokeStyle = d.type === 'storage' ? alpha(badgeInk, 0.3) : alpha(pal.accent, 0.22);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = badgeInk;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(badgeText, bx + 8, t + 19.5);

      // 名称
      ctx.font = '700 15px ' + FONT;
      ctx.fillStyle = pal.ink;
      ctx.fillText(clipText(ctx, d.type === 'unknown' ? '未识别设备' : d.label, w - 50 - btw), l + 47, t + 25);

      // 副标题
      var sub;
      if (d.type === 'switch') {
        sub = '第 ' + switchLayer(d) + ' 层' + (d.ips && d.ips.length ? ' · ' + d.ips[0] : '');
      } else if (d.type === 'storage') {
        sub = storageSub(d);
      } else if (d.type === 'host') {
        sub = d.ips && d.ips.length ? d.ips[0] : '未配置 IP';
      } else {
        sub = '未纳管 · ' + shortWwn(d.wwn);
      }
      if (state.showWwn && d.wwn) sub = shortWwn(d.wwn);
      ctx.font = '500 9.5px ' + FONT;
      ctx.fillStyle = pal.muted;
      ctx.fillText(clipText(ctx, sub, w - 28), l + 14, t + 44);

      // 硬件面板
      var hwW = w - 26;
      drawHardware(ctx, d.type, l + 13, t + 55, hwW, 58);

      // 分隔线
      ctx.strokeStyle = dark ? 'rgba(148,163,184,0.1)' : 'rgba(15,23,42,0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(l + 14, t + 121);
      ctx.lineTo(l + w - 14, t + 121);
      ctx.stroke();

      // 底部指标
      var connected = d.ports.filter(function (p) { return p.connected; }).length;
      var shown = d.ports.filter(function (p) { return !state.offPorts.has(p.id); }).length;
      var fy = t + 133;
      var mx = l + 16;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = '600 10px ' + FONT;

      ctx.beginPath();
      ctx.arc(mx, fy - 0.5, 2.2, 0, 7);
      ctx.fillStyle = pal.accent;
      ctx.fill();
      var pt = (shown < d.ports.length ? shown + '/' : '') + d.ports.length + ' 网口';
      ctx.fillStyle = pal.muted;
      ctx.fillText(pt, mx + 7, fy);
      mx += 7 + ctx.measureText(pt).width + 13;

      ctx.beginPath();
      ctx.arc(mx, fy - 0.5, 2.2, 0, 7);
      ctx.fillStyle = '#10b981';
      ctx.fill();
      var ct = '已连 ' + connected;
      ctx.fillStyle = pal.muted;
      ctx.fillText(ct, mx + 7, fy);
      mx += 7 + ctx.measureText(ct).width;

      if (d.type === 'switch') {
        ctx.textAlign = 'right';
        ctx.font = '700 9px ' + MONO;
        ctx.fillStyle = alpha(pal.accent, 0.9);
        ctx.fillText('L' + switchLayer(d), l + w - 15, fy);
      }
    }

    ctx.restore();
    return { drawNode: function () {}, nodeDimensions: { width: w, height: h } };
  }

  function drawSkeuoPortNode(info, node, flags) {
    var ctx = info.ctx, x = info.x, y = info.y;
    var w = node._w, h = node._h;
    var d = devById.get(node._device);
    var p = portById.get(node._port);
    if (!d || !p) return { drawNode: function () {}, nodeDimensions: { width: w, height: h } };
    var pal = palette()[d.type] || palette().unknown;
    var on = !!p.connected;
    var dim = !!flags.dim;
    var l = x - w / 2, t = y - h / 2;
    var dark = state.theme === 'dark';
    var side = node._side;
    var rOut = 5, rIn = 1.2;
    var tl, tr, br, bl;
    if (side === 'L') { tl = bl = rOut; tr = br = rIn; }
    else if (side === 'R') { tl = bl = rIn; tr = br = rOut; }
    else { tl = tr = br = bl = rOut; }

    ctx.save();
    if (dim) ctx.globalAlpha = 0.24;
    var portHot = info.state.hover || info.state.selected;
    ctx.shadowColor = portHot
      ? alpha(pal.accent, dark ? 0.5 : 0.4)
      : (dark ? 'rgba(0,0,0,0.55)' : 'rgba(15,23,42,0.2)');
    ctx.shadowBlur = portHot ? 9 : 5;
    ctx.shadowOffsetY = 1.5;

    var g = ctx.createLinearGradient(0, t, 0, t + h);
    if (on) {
      g.addColorStop(0, '#4a5a72');
      g.addColorStop(0.45, '#243145');
      g.addColorStop(1, '#0c1524');
    } else {
      g.addColorStop(0, dark ? '#2a3950' : '#f1f5f9');
      g.addColorStop(1, dark ? '#172235' : '#d8e1ec');
    }
    rrectSides(ctx, l, t, w, h, tl, tr, br, bl);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    var bc = on ? pal.accent : (dark ? '#3b4a61' : '#bcc9da');
    var bw = on ? 1.4 : 1;
    if (info.state.hover || info.state.selected) { bc = pal.accent; bw = 2; }
    if (flags.hit) { bc = '#f59e0b'; bw = 2.6; }
    if (flags.path) { bc = '#ef4444'; bw = 2.6; }
    rrectSides(ctx, l + 0.5, t + 0.5, w - 1, h - 1, tl, tr, br, bl);
    ctx.strokeStyle = bc;
    ctx.lineWidth = bw;
    ctx.stroke();

    // 内槽
    rrectSides(ctx, l + 5, t + 4, w - 10, h - 8, 3, 3, 3, 3);
    ctx.fillStyle = on ? '#050b16' : (dark ? '#1b2739' : '#f8fafc');
    ctx.fill();
    ctx.strokeStyle = dark ? 'rgba(148,163,184,0.12)' : 'rgba(15,23,42,0.08)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // 外侧类型色条
    var stripX = side === 'R' ? l + w - 3.7 : l + 1.5;
    ctx.fillStyle = alpha(pal.accent, on ? 0.85 : 0.3);
    rrect(ctx, stripX, t + 6, 2.2, h - 12, 1);
    ctx.fill();

    // LED（放在外侧）
    var ledX = side === 'R' ? l + w - 11 : l + 11;
    ctx.beginPath();
    ctx.arc(ledX, t + 8, 1.9, 0, 7);
    ctx.fillStyle = on ? '#22c55e' : (dark ? '#475569' : '#cbd5e1');
    ctx.fill();

    // 底部卡扣
    ctx.fillStyle = alpha(pal.accent, on ? 0.35 : 0.15);
    rrect(ctx, l + w / 2 - 5, t + h - 4, 10, 1.6, 1);
    ctx.fill();

    ctx.font = '600 10px ' + MONO;
    if (ctx.measureText(p.label).width > w - 26) ctx.font = '600 9px ' + MONO;
    ctx.fillStyle = on ? '#e2e8f0' : (dark ? '#64748b' : '#64748b');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(clipText(ctx, p.label, w - 24), x + (side === 'R' ? -3 : 3), y + 1);

    ctx.restore();
    return { drawNode: function () {}, nodeDimensions: { width: w, height: h } };
  }

  function drawTypeGlyph(ctx, type, cx, cy, size, color, lw) {
    var s = size / 24;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lw || 1.7;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (type === 'host') {
      rrect(ctx, -10, -9, 20, 18, 3);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-5, -4); ctx.lineTo(5, -4);
      ctx.moveTo(-5, 1); ctx.lineTo(5, 1);
      ctx.moveTo(-5, 6); ctx.lineTo(2, 6);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(6.5, 6, 1.1, 0, 7);
      ctx.fill();
    } else if (type === 'switch') {
      rrect(ctx, -11, -7, 22, 14, 3);
      ctx.stroke();
      for (var r = 0; r < 2; r++) {
        for (var c = 0; c < 4; c++) {
          ctx.beginPath();
          ctx.arc(-6.6 + c * 4.4, -2.4 + r * 4.8, 1, 0, 7);
          ctx.fill();
        }
      }
    } else if (type === 'storage') {
      [-9, -1, 7].forEach(function (yy) {
        rrect(ctx, -10, yy, 20, 6, 2);
        ctx.stroke();
      });
      [-6, 2, 10].forEach(function (yy) {
        ctx.beginPath();
        ctx.arc(-5.5, yy, 1, 0, 7);
        ctx.fill();
      });
    } else {
      ctx.setLineDash([3, 3]);
      rrect(ctx, -10, -10, 20, 20, 5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '700 12px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', 0, 1);
    }
    ctx.restore();
  }

  function drawSoftBody(ctx, node, l, t, w, h, pal, isLine) {
    var railTop = t + 70;
    var railBottom = t + h - 12;
    if (railBottom - railTop < 36) return;
    var dark = state.theme === 'dark';

    ctx.save();
    [l + 11, l + w - 11].forEach(function (rx) {
      ctx.strokeStyle = alpha(pal.accent, isLine ? 0.3 : 0.18);
      ctx.lineWidth = 1;
      ctx.setLineDash(isLine ? [4, 4] : [3, 6]);
      ctx.beginPath();
      ctx.moveTo(rx, railTop);
      ctx.lineTo(rx, railBottom);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    var rows = Math.max(node._rows.L || 0, node._rows.R || 0);
    for (var i = 0; i < rows; i++) {
      var yy = node.y + (i - (rows - 1) / 2) * PORT_GAP;
      if (yy < railTop + 4 || yy > railBottom - 4) continue;
      ctx.strokeStyle = alpha(pal.accent, isLine ? 0.12 : 0.07);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(l + 20, yy);
      ctx.lineTo(l + w - 20, yy);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(l + 11, yy, 1.6, 0, 7);
      ctx.arc(l + w - 11, yy, 1.6, 0, 7);
      ctx.fillStyle = alpha(pal.accent, 0.55);
      ctx.fill();
    }

    if (h > 230) {
      ctx.globalAlpha = dark ? 0.05 : 0.045;
      drawTypeGlyph(ctx, node._type, l + w / 2, t + h - 44, 58, pal.accent, 1.4);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function drawLineDeviceNode(info, node, flags) {
    var ctx = info.ctx, x = info.x, y = info.y;
    var w = node._w, h = node._h;
    var d = devById.get(node._device);
    if (!d) return { drawNode: function () {}, nodeDimensions: { width: w, height: h } };
    var pal = palette()[d.type] || palette().unknown;
    var compact = node._compact;
    var dim = !!flags.dim;
    var dark = state.theme === 'dark';
    var l = x - w / 2, t = y - h / 2;
    var hot = info.state.hover || info.state.selected;
    var radius = compact ? 10 : 14;

    ctx.save();
    if (dim) ctx.globalAlpha = 0.3;
    ctx.shadowColor = dark ? 'rgba(0,0,0,0.5)' : 'rgba(15,23,42,0.08)';
    ctx.shadowBlur = hot ? 18 : 10;
    ctx.shadowOffsetY = 4;
    rrect(ctx, l, t, w, h, radius);
    ctx.fillStyle = dark ? 'rgba(14,25,44,0.95)' : 'rgba(255,255,255,0.98)';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    var border = alpha(pal.accent, hot ? 0.9 : 0.5);
    var bw = hot ? 2 : 1.3;
    if (flags.hit) { border = '#f59e0b'; bw = 2.6; }
    if (flags.path) { border = '#ef4444'; bw = 2.6; }
    if (flags.center) { border = pal.accent; bw = 2; }
    rrect(ctx, l + 0.65, t + 0.65, w - 1.3, h - 1.3, radius);
    ctx.strokeStyle = border;
    ctx.lineWidth = bw;
    ctx.stroke();

    if (h > 168) drawSoftBody(ctx, node, l, t, w, h, pal, true);

    // 左上角技术风短线
    ctx.strokeStyle = alpha(pal.accent, 0.65);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(l + 14, t + 0.8);
    ctx.lineTo(l + 52, t + 0.8);
    ctx.stroke();

    if (compact) {
      drawTypeGlyph(ctx, d.type, l + 23, t + h / 2, 18, pal.accent, 1.6);
      ctx.textAlign = 'left';
      ctx.font = '600 12.5px ' + FONT;
      ctx.fillStyle = dark ? pal.ink : '#0f172a';
      ctx.fillText(clipText(ctx, d.type === 'unknown' ? '未识别' : d.label, w - 110), l + 42, t + h / 2 + 1);
      ctx.textAlign = 'right';
      ctx.font = '600 9.5px ' + MONO;
      ctx.fillStyle = pal.muted;
      ctx.fillText(d._group ? d._groupCount + ' 台' : d.ports.length + ' 口', l + w - 12, t + h / 2 + 1);
    } else {
      drawTypeGlyph(ctx, d.type, l + 29, t + 28, 22, pal.accent, 1.7);

      ctx.textAlign = 'left';
      ctx.font = '700 14.5px ' + FONT;
      ctx.fillStyle = dark ? pal.ink : '#0f172a';
      ctx.fillText(clipText(ctx, d.type === 'unknown' ? '未识别' : d.label, w - 96), l + 50, t + 31);

      ctx.font = '600 8.5px ' + FONT;
      ctx.fillStyle = alpha(pal.accent, 0.9);
      ctx.fillText(d.type === 'storage' ? storageInfo(d).model : TYPE_LABEL[d.type], l + 50, t + 47);
      if (d.type === 'storage') drawStorageVendor(ctx, d, l + w - 14, t + 20);

      var sub;
      if (d.type === 'switch') sub = '第 ' + switchLayer(d) + ' 层' + (d.ips && d.ips.length ? ' · ' + d.ips[0] : '');
      else if (d.type === 'storage') sub = storageIpText(d);
      else if (d.type === 'host') sub = (d.ips && d.ips.length ? d.ips[0] : '未配置 IP');
      else sub = '未纳管 · ' + shortWwn(d.wwn);
      if (state.showWwn && d.wwn) sub = shortWwn(d.wwn);
      ctx.font = '500 10px ' + FONT;
      ctx.fillStyle = pal.muted;
      ctx.fillText(clipText(ctx, sub, w - 30), l + 15, t + 67);

      // 端口点阵
      var py = t + 90;
      var maxDots = Math.min(d.ports.length, 20);
      var gap = Math.min(11, (w - 44) / Math.max(1, maxDots));
      for (var i = 0; i < maxDots; i++) {
        var p = d.ports[i];
        var on = p.connected && !state.offPorts.has(p.id);
        ctx.beginPath();
        ctx.arc(l + 18 + i * gap, py, 2.6, 0, 7);
        if (on) {
          ctx.fillStyle = alpha(pal.accent, 0.9);
          ctx.fill();
        } else {
          ctx.strokeStyle = alpha(pal.accent, 0.3);
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      if (d.ports.length > maxDots) {
        ctx.font = '600 8.5px ' + FONT;
        ctx.fillStyle = pal.muted;
        ctx.fillText('+' + (d.ports.length - maxDots), l + 18 + maxDots * gap + 2, py + 3);
      }

      ctx.strokeStyle = dark ? 'rgba(148,163,184,0.14)' : 'rgba(15,23,42,0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(l + 15, t + 118);
      ctx.lineTo(l + w - 15, t + 118);
      ctx.stroke();

      var connected = d.ports.filter(function (p2) { return p2.connected; }).length;
      var shown = d.ports.filter(function (p2) { return !state.offPorts.has(p2.id); }).length;
      var pt = (shown < d.ports.length ? shown + '/' : '') + d.ports.length + ' 网口 · 已连 ' + connected;
      ctx.font = '500 10px ' + FONT;
      ctx.fillStyle = pal.muted;
      ctx.fillText(pt, l + 15, t + 135);

      if (d.type === 'switch') {
        ctx.textAlign = 'right';
        ctx.font = '700 8.5px ' + MONO;
        ctx.fillStyle = alpha(pal.accent, 0.9);
        ctx.fillText('L' + switchLayer(d), l + w - 15, t + 135);
      }
    }

    ctx.restore();
    return { drawNode: function () {}, nodeDimensions: { width: w, height: h } };
  }

  function drawLinePortNode(info, node, flags) {
    var ctx = info.ctx, x = info.x, y = info.y;
    var w = node._w, h = node._h;
    var d = devById.get(node._device);
    var p = portById.get(node._port);
    if (!d || !p) return { drawNode: function () {}, nodeDimensions: { width: w, height: h } };
    var pal = palette()[d.type] || palette().unknown;
    var on = !!p.connected;
    var dim = !!flags.dim;
    var dark = state.theme === 'dark';
    var l = x - w / 2, t = y - h / 2;
    var side = node._side;
    var tl, tr, br, bl;
    if (side === 'L') { tl = bl = 7; tr = br = 1.5; }
    else if (side === 'R') { tl = bl = 1.5; tr = br = 7; }
    else { tl = tr = br = bl = 7; }
    var hot = info.state.hover || info.state.selected;

    ctx.save();
    if (dim) ctx.globalAlpha = 0.3;
    rrectSides(ctx, l, t, w, h, tl, tr, br, bl);
    ctx.fillStyle = dark ? 'rgba(16,27,46,0.96)' : 'rgba(255,255,255,0.98)';
    ctx.fill();
    var bc = on ? alpha(pal.accent, hot ? 0.95 : 0.7) : (dark ? 'rgba(148,163,184,0.3)' : 'rgba(100,116,139,0.35)');
    var bw = hot ? 2 : 1.3;
    if (flags.hit) { bc = '#f59e0b'; bw = 2.6; }
    if (flags.path) { bc = '#ef4444'; bw = 2.6; }
    rrectSides(ctx, l + 0.5, t + 0.5, w - 1, h - 1, tl, tr, br, bl);
    ctx.strokeStyle = bc;
    ctx.lineWidth = bw;
    ctx.stroke();

    var ledX = side === 'R' ? l + w - 10 : l + 10;
    ctx.beginPath();
    ctx.arc(ledX, t + 8, 1.9, 0, 7);
    ctx.fillStyle = on ? alpha(pal.accent, 0.9) : (dark ? 'rgba(148,163,184,0.35)' : 'rgba(100,116,139,0.3)');
    ctx.fill();

    ctx.font = '600 9.5px ' + MONO;
    if (ctx.measureText(p.label).width > w - 24) ctx.font = '600 9px ' + MONO;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = on ? (dark ? '#eaf2ff' : '#0f172a') : pal.muted;
    ctx.fillText(clipText(ctx, p.label, w - 22), x + (side === 'R' ? -2 : 2), y + 1);

    ctx.restore();
    return { drawNode: function () {}, nodeDimensions: { width: w, height: h } };
  }

  function scColors() {
    var dark = state.theme === 'dark';
    return {
      card: dark ? '#18181b' : '#ffffff',
      border: dark ? '#27272a' : '#e4e4e7',
      strong: dark ? '#3f3f46' : '#d4d4d8',
      ink: dark ? '#fafafa' : '#09090b',
      muted: dark ? '#a1a1aa' : '#71717a',
      faint: dark ? '#71717a' : '#a1a1aa',
      primary: dark ? '#fafafa' : '#18181b',
      primaryFg: dark ? '#18181b' : '#fafafa',
      soft: dark ? '#27272a' : '#f4f4f5'
    };
  }

  function scColors() {
    var dark = state.theme === 'dark';
    return {
      card: dark ? '#18181b' : '#ffffff',
      border: dark ? '#27272a' : '#e4e4e7',
      strong: dark ? '#3f3f46' : '#d4d4d8',
      ink: dark ? '#fafafa' : '#09090b',
      muted: dark ? '#a1a1aa' : '#71717a',
      faint: dark ? '#71717a' : '#a1a1aa',
      primary: dark ? '#fafafa' : '#18181b',
      primaryFg: dark ? '#18181b' : '#fafafa',
      soft: dark ? '#27272a' : '#f4f4f5'
    };
  }

  function drawShadcnDeviceNode(info, node, flags) {
    var ctx = info.ctx, x = info.x, y = info.y;
    var w = node._w, h = node._h;
    var d = devById.get(node._device);
    if (!d) return { drawNode: function () {}, nodeDimensions: { width: w, height: h } };
    var sc = scColors();
    var compact = node._compact;
    var dim = !!flags.dim;
    var dark = state.theme === 'dark';
    var l = x - w / 2, t = y - h / 2;
    var hot = info.state.hover || info.state.selected;
    var radius = compact ? 8 : 10;

    ctx.save();
    if (dim) ctx.globalAlpha = 0.3;
    ctx.shadowColor = 'rgba(0,0,0,' + (dark ? 0.5 : 0.06) + ')';
    ctx.shadowBlur = hot ? 12 : 6;
    ctx.shadowOffsetY = hot ? 3 : 2;
    rrect(ctx, l, t, w, h, radius);
    ctx.fillStyle = sc.card;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    var border = sc.border;
    var bw = 1;
    if (hot) { border = sc.primary; bw = 1.6; }
    if (flags.hit) { border = '#f59e0b'; bw = 2; }
    if (flags.path) { border = '#ef4444'; bw = 2; }
    if (flags.center) { border = sc.primary; bw = 1.6; }
    rrect(ctx, l + 0.5, t + 0.5, w - 1, h - 1, radius);
    ctx.strokeStyle = border;
    ctx.lineWidth = bw;
    if (d.type === 'unknown') ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (!compact && h > 168) drawSoftBody(ctx, node, l, t, w, h, { accent: sc.muted }, true);

    if (compact) {
      rrect(ctx, l + 10, t + 11, 24, 24, 6);
      ctx.fillStyle = sc.soft;
      ctx.fill();
      drawTypeGlyph(ctx, d.type, l + 22, t + 23, 14, sc.ink, 1.5);
      ctx.textAlign = 'left';
      ctx.font = '600 12.5px ' + FONT;
      ctx.fillStyle = sc.ink;
      ctx.fillText(clipText(ctx, d.type === 'unknown' ? '未识别' : d.label, w - 118), l + 42, t + h / 2 + 1);
      ctx.textAlign = 'right';
      ctx.font = '500 10.5px ' + FONT;
      ctx.fillStyle = sc.muted;
      ctx.fillText(d._group ? d._groupCount + ' 台' : d.ports.length + ' 口', l + w - 12, t + h / 2 + 1);
      ctx.restore();
      return { drawNode: function () {}, nodeDimensions: { width: w, height: h } };
    }

    // 中性图标容器
    rrect(ctx, l + 14, t + 13, 30, 30, 6);
    ctx.fillStyle = sc.soft;
    ctx.fill();
    ctx.strokeStyle = sc.border;
    ctx.lineWidth = 1;
    ctx.stroke();
    drawTypeGlyph(ctx, d.type, l + 29, t + 28, 17, sc.ink, 1.6);

    // 名称
    ctx.textAlign = 'left';
    ctx.font = '600 14px ' + FONT;
    ctx.fillStyle = sc.ink;
    ctx.fillText(clipText(ctx, d.type === 'unknown' ? '未识别' : d.label, w - 82), l + 52, t + 29);

    // 品牌与型号都用中性色
    if (d.type === 'storage') drawStorageVendor(ctx, d, l + w - 14, t + 18, true);
    var badge = d.type === 'storage' ? storageInfo(d).model : TYPE_LABEL[d.type];
    ctx.font = '600 9.5px ' + FONT;
    var badgeW = ctx.measureText(badge).width + 18;
    rrect(ctx, l + 52, t + 36, badgeW, 17, 4);
    ctx.fillStyle = sc.soft;
    ctx.fill();
    ctx.strokeStyle = sc.border;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = sc.muted;
    ctx.fillText(badge, l + 61, t + 45.5);

    // 副标题
    var sub;
    if (d.type === 'switch') sub = '第 ' + switchLayer(d) + ' 层' + (d.ips && d.ips.length ? ' · ' + d.ips[0] : '');
    else if (d.type === 'storage') sub = storageIpText(d);
    else if (d.type === 'host') sub = (d.ips && d.ips.length ? d.ips[0] : '未配置 IP');
    else sub = '未纳管 · ' + shortWwn(d.wwn);
    if (state.showWwn && d.wwn) sub = shortWwn(d.wwn);
    ctx.font = '400 11px ' + FONT;
    ctx.fillStyle = sc.muted;
    ctx.fillText(clipText(ctx, sub, w - 28), l + 14, t + 66);

    // 端口点阵：已连接用前景色，未使用用边框色
    var py = t + 90;
    var maxDots = Math.min(d.ports.length, 20);
    var gap = Math.min(11, (w - 40) / Math.max(1, maxDots));
    for (var i = 0; i < maxDots; i++) {
      var p = d.ports[i];
      var on = p.connected && !state.offPorts.has(p.id);
      ctx.beginPath();
      ctx.arc(l + 17 + i * gap, py, 2.7, 0, 7);
      ctx.fillStyle = on ? sc.ink : sc.border;
      ctx.fill();
    }
    if (d.ports.length > maxDots) {
      ctx.font = '500 10px ' + FONT;
      ctx.fillStyle = sc.faint;
      ctx.fillText('+' + (d.ports.length - maxDots), l + 17 + maxDots * gap + 1, py + 3);
    }

    ctx.strokeStyle = sc.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(l + 14, t + 112);
    ctx.lineTo(l + w - 14, t + 112);
    ctx.stroke();

    var connected = d.ports.filter(function (p2) { return p2.connected; }).length;
    var shown = d.ports.filter(function (p2) { return !state.offPorts.has(p2.id); }).length;
    var pt = (shown < d.ports.length ? shown + '/' : '') + d.ports.length + ' 网口 · 已连 ' + connected;
    ctx.font = '400 11px ' + FONT;
    ctx.fillStyle = sc.muted;
    ctx.fillText(pt, l + 14, t + 132);

    if (d.type === 'switch') {
      var label = 'L' + switchLayer(d);
      ctx.font = '500 9.5px ' + MONO;
      var tw = ctx.measureText(label).width + 10;
      rrect(ctx, l + w - 14 - tw, t + 123, tw, 16, 4);
      ctx.strokeStyle = sc.border;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillStyle = sc.muted;
      ctx.fillText(label, l + w - 14 - tw / 2, t + 131);
    }

    ctx.restore();
    return { drawNode: function () {}, nodeDimensions: { width: w, height: h } };
  }

  function drawShadcnPortNode(info, node, flags) {
    var ctx = info.ctx, x = info.x, y = info.y;
    var w = node._w, h = node._h;
    var d = devById.get(node._device);
    var p = portById.get(node._port);
    if (!d || !p) return { drawNode: function () {}, nodeDimensions: { width: w, height: h } };
    var sc = scColors();
    var on = !!p.connected;
    var dim = !!flags.dim;
    var l = x - w / 2, t = y - h / 2;
    var side = node._side;
    var tl, tr, br, bl;
    if (side === 'L') { tl = bl = 6; tr = br = 1.5; }
    else if (side === 'R') { tl = bl = 1.5; tr = br = 6; }
    else { tl = tr = br = bl = 6; }
    var hot = info.state.hover || info.state.selected;

    ctx.save();
    if (dim) ctx.globalAlpha = 0.3;
    ctx.shadowColor = 'rgba(0,0,0,' + (state.theme === 'dark' ? 0.45 : 0.05) + ')';
    ctx.shadowBlur = hot ? 8 : 3;
    ctx.shadowOffsetY = 1;
    rrectSides(ctx, l, t, w, h, tl, tr, br, bl);
    ctx.fillStyle = sc.card;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    var bc = on ? sc.strong : sc.border;
    var bw = 1;
    if (hot) { bc = sc.primary; bw = 1.8; }
    if (flags.hit) { bc = '#f59e0b'; bw = 2; }
    if (flags.path) { bc = '#ef4444'; bw = 2; }
    rrectSides(ctx, l + 0.5, t + 0.5, w - 1, h - 1, tl, tr, br, bl);
    ctx.strokeStyle = bc;
    ctx.lineWidth = bw;
    ctx.stroke();

    var ledX = side === 'R' ? l + w - 9 : l + 9;
    ctx.beginPath();
    ctx.arc(ledX, t + 8, 2, 0, 7);
    ctx.fillStyle = on ? sc.ink : sc.border;
    ctx.fill();

    ctx.font = '500 9.5px ' + MONO;
    if (ctx.measureText(p.label).width > w - 24) ctx.font = '500 9px ' + MONO;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = on ? sc.ink : sc.faint;
    ctx.fillText(clipText(ctx, p.label, w - 22), x + (side === 'R' ? -2 : 2), y + 1);

    ctx.restore();
    return { drawNode: function () {}, nodeDimensions: { width: w, height: h } };
  }

  function drawDeviceNode(info, node, flags) {
    if (state.style === 'shadcn') return drawShadcnDeviceNode(info, node, flags);
    if (state.style === 'skeuo') return drawSkeuoDeviceNode(info, node, flags);
    return drawLineDeviceNode(info, node, flags);
  }

  function drawPortNode(info, node, flags) {
    if (state.style === 'shadcn') return drawShadcnPortNode(info, node, flags);
    if (state.style === 'skeuo') return drawSkeuoPortNode(info, node, flags);
    return drawLinePortNode(info, node, flags);
  }

  function drawGroupStack(ctx, node, x, y) {
    var l = x - node._w / 2, t = y - node._h / 2, w = node._w, h = node._h;
    var dark = state.theme === 'dark';
    ctx.save();
    ctx.fillStyle = dark ? 'rgba(255,255,255,.035)' : 'rgba(15,23,42,.035)';
    ctx.strokeStyle = dark ? 'rgba(255,255,255,.12)' : 'rgba(15,23,42,.10)';
    ctx.lineWidth = 1;
    rrect(ctx, l + 7, t + 7, w, h, 10);
    ctx.fill();
    ctx.stroke();
    rrect(ctx, l + 3.5, t + 3.5, w, h, 10);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function drawPlaneBadge(ctx, node, x, y) {
    if (!state._planeMode || !node._ghost || !node._plane) return;
    var color = planeAccent(node._plane);
    var text = String(node._plane);
    var pw = Math.max(18, 10 + ctx.measureText(text).width);
    var ph = 13;
    var px = x + node._w / 2 - pw / 2;
    var py = y - node._h / 2 - 7;
    ctx.save();
    ctx.font = '700 8.5px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif';
    ctx.beginPath();
    ctx.fillStyle = color;
    rrect(ctx, px, py, pw, ph, 6);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, px + pw / 2, py + ph / 2 + 0.4);
    ctx.restore();
  }

  function renderNode(info) {
    var node = state.nodeById.get(info.id);
    if (!node) return { drawNode: function () {}, nodeDimensions: { width: 10, height: 10 } };
    var flags = nodeFlags.get(info.id) || {};
    if (node._kind === 'device') {
      var nd = devById.get(node._device);
      if (nd && nd._group) drawGroupStack(info.ctx, node, info.x, info.y);
    }
    var result = node._kind === 'device' ? drawDeviceNode(info, node, flags) : drawPortNode(info, node, flags);
    if (node._kind === 'device') {
      drawHealthDot(info.ctx, node, info.x, info.y);
      drawPlaneBadge(info.ctx, node, info.x, info.y);
    }
    return result;
  }

  /* ------------------------------------------------------------------ */
  /* 分层布局                                                            */
  /* ------------------------------------------------------------------ */

  function computeRanks(devices, links) {
    var rank = new Map();
    var inView = new Set(devices.map(function (d) { return d.id; }));
    var swAdj = new Map();
    var anchors = new Set();

    links.forEach(function (l) {
      var a = devById.get(l.a.device);
      var b = devById.get(l.b.device);
      if (!a || !b) return;
      if (a.type === 'switch' && b.type === 'switch') {
        if (!swAdj.has(a.id)) swAdj.set(a.id, new Set());
        if (!swAdj.has(b.id)) swAdj.set(b.id, new Set());
        swAdj.get(a.id).add(b.id);
        swAdj.get(b.id).add(a.id);
      } else if (a.type === 'switch' || b.type === 'switch') {
        if (a.type === 'host' || b.type === 'host') {
          anchors.add(a.type === 'switch' ? a.id : b.id);
        }
      }
    });

    var queue = [];
    anchors.forEach(function (id) {
      if (inView.has(id)) { rank.set(id, 1); queue.push(id); }
    });
    var head = 0;
    function bfs() {
      while (head < queue.length) {
        var cur = queue[head++];
        var r = rank.get(cur);
        (swAdj.get(cur) || new Set()).forEach(function (nb) {
          if (inView.has(nb) && !rank.has(nb)) { rank.set(nb, r + 1); queue.push(nb); }
        });
      }
    }
    bfs();
    devices.forEach(function (d) {
      if (d.type === 'switch' && !rank.has(d.id)) { rank.set(d.id, 1); queue.push(d.id); }
    });
    bfs();

    devices.forEach(function (d) { if (d.type === 'host') rank.set(d.id, 0); });

    devices.forEach(function (d) {
      if (d.type !== 'storage') return;
      var best = 1;
      links.forEach(function (l) {
        var otherId = l.a.device === d.id ? l.b.device : (l.b.device === d.id ? l.a.device : null);
        if (!otherId) return;
        var o = devById.get(otherId);
        if (o && o.type === 'switch') best = Math.max(best, rank.get(o.id) || 1);
      });
      rank.set(d.id, best + 1);
    });

    var maxRank = 1;
    rank.forEach(function (v) { if (v > maxRank) maxRank = v; });
    devices.forEach(function (d) {
      if (d.type !== 'unknown') return;
      var best = 0;
      links.forEach(function (l) {
        var otherId = l.a.device === d.id ? l.b.device : (l.b.device === d.id ? l.a.device : null);
        if (!otherId) return;
        best = Math.max(best, rank.get(otherId) || 0);
      });
      rank.set(d.id, best ? Math.min(maxRank, best + 1) : 1);
    });

    return rank;
  }

  function orderColumns(cols, adj) {
    var idx = new Map();
    var rankOf = new Map();
    cols.forEach(function (col, r) {
      col.forEach(function (d, i) { idx.set(d.id, i); rankOf.set(d.id, r); });
    });

    for (var iter = 0; iter < 8; iter++) {
      var order = Array.from(cols.keys()).sort(function (a, b) { return a - b; });
      if (iter % 2 === 1) order.reverse();
      order.forEach(function (r) {
        var col = cols.get(r);
        var score = new Map();
        col.forEach(function (d) {
          var nbrs = adj.get(d.id) || [];
          var sum = 0, cnt = 0;
          nbrs.forEach(function (n) {
            if (rankOf.get(n) === r || !idx.has(n)) return;
            sum += idx.get(n); cnt++;
          });
          score.set(d.id, cnt ? sum / cnt : idx.get(d.id));
        });
        col.sort(function (a, b) {
          return (score.get(a.id) - score.get(b.id)) || (idx.get(a.id) - idx.get(b.id));
        });
        col.forEach(function (d, i) { idx.set(d.id, i); });
      });
    }
  }

  function layout(devices, links, rank, rankListOverride) {
    var rankList = rankListOverride || Array.from(new Set(devices.map(function (d) { return rank.get(d.id); }))).sort(function (a, b) { return a - b; });
    var rIndex = new Map(rankList.map(function (r, i) { return [r, i]; }));
    var cols = new Map();
    devices.forEach(function (d) {
      var ri = rIndex.get(rank.get(d.id));
      if (!cols.has(ri)) cols.set(ri, []);
      cols.get(ri).push(d);
    });

    var adj = new Map();
    links.forEach(function (l) {
      if (l.a.device === l.b.device) return;
      if (!adj.has(l.a.device)) adj.set(l.a.device, []);
      if (!adj.has(l.b.device)) adj.set(l.b.device, []);
      adj.get(l.a.device).push(l.b.device);
      adj.get(l.b.device).push(l.a.device);
    });

    cols.forEach(function (col) {
      col.sort(function (a, b) {
        return (TYPE_ORDER[a.type] - TYPE_ORDER[b.type]) || a.label.localeCompare(b.label, 'zh-Hans-CN');
      });
    });
    orderColumns(cols, adj);

    var portLinks = new Map();
    links.forEach(function (l) {
      if (l.a.port) { if (!portLinks.has(l.a.port)) portLinks.set(l.a.port, []); portLinks.get(l.a.port).push(l); }
      if (l.b.port) { if (!portLinks.has(l.b.port)) portLinks.set(l.b.port, []); portLinks.get(l.b.port).push(l); }
    });

    var sides = new Map();
    var heights = new Map();
    var compactRanks = new Map();
    cols.forEach(function (col, ri) {
      compactRanks.set(ri, state.gran === 'device' && col.length > 12);
    });

    devices.forEach(function (d) {
      if (d._group) {
        sides.set(d.id, { L: [], R: [] });
        heights.set(d.id, COMPACT_H);
        return;
      }
      var L = [], R = [];
      var myRank = rank.get(d.id) || 0;
      (d.ports || []).forEach(function (p) {
        if (state.offPorts.has(p.id)) return;
        var pl = portLinks.get(p.id) || [];
        var visible = pl.length > 0 || (state.showUnused && !p.connected);
        if (!visible) return;
        var side = 'R';
        if (pl.length) {
          var sum = 0;
          pl.forEach(function (l) {
            var otherId = l.a.device === d.id ? l.b.device : l.a.device;
            sum += (rank.get(otherId) != null ? rank.get(otherId) : myRank);
          });
          side = (sum / pl.length) >= myRank ? 'R' : 'L';
        }
        (side === 'L' ? L : R).push({ port: p, links: pl });
      });
      sides.set(d.id, { L: L, R: R });
      var maxN = Math.max(L.length, R.length);
      var compact = compactRanks.get(rIndex.get(rank.get(d.id)));
      if (state.gran === 'port') heights.set(d.id, Math.max(150, maxN * PORT_GAP + 56));
      else heights.set(d.id, compact ? COMPACT_H : CARD_H);
    });

    var pos = new Map();
    var colGap = (state.gran === 'port' ? 50 : 44) * state.spacing;
    var colW = state.gran === 'port'
      ? Math.max(390, 410 * state.spacing)
      : Math.max(304, 336 * state.spacing);

    cols.forEach(function (col, ri) {
      var compact = compactRanks.get(ri);
      var gap = compact ? 12 * state.spacing : colGap;
      var total = 0;
      col.forEach(function (d) { total += heights.get(d.id); });
      total += gap * Math.max(0, col.length - 1);
      var y = -total / 2;
      col.forEach(function (d) {
        var h = heights.get(d.id);
        pos.set(d.id, { x: ri * colW, y: y + h / 2, h: h, compact: compact });
        y += h + gap;
      });
    });

    var portPos = new Map();
    function avgPeerY(item) {
      if (!item.links.length) return 0;
      var sum = 0;
      item.links.forEach(function (l) {
        var otherId = l.a.device === item.port.device ? l.b.device : l.a.device;
        var op = pos.get(otherId);
        sum += op ? op.y : 0;
      });
      return sum / item.links.length;
    }

    devices.forEach(function (d) {
      var s = sides.get(d.id);
      var base = pos.get(d.id);
      var off = PORT_OFFSET;
      ['L', 'R'].forEach(function (sideKey) {
        var arr = s[sideKey];
        arr.sort(function (a, b) {
          var ua = a.links.length ? 0 : 1;
          var ub = b.links.length ? 0 : 1;
          if (ua !== ub) return ua - ub;
          return avgPeerY(a) - avgPeerY(b);
        });
        var n = arr.length;
        arr.forEach(function (item, i) {
          var y = base.y + (i - (n - 1) / 2) * PORT_GAP;
          portPos.set(item.port.id, { x: base.x + (sideKey === 'L' ? -off : off), y: y, side: sideKey });
        });
      });
    });

    return { pos: pos, portPos: portPos, sides: sides, heights: heights, cols: cols, compactRanks: compactRanks };
  }

  /* ------------------------------------------------------------------ */
  /* 视图计算                                                            */
  /* ------------------------------------------------------------------ */

  function collapseHostGroups(devices, links) {
    var hostToSwitches = new Map();
    links.forEach(function (l) {
      var a = devById.get(l.a.device);
      var b = devById.get(l.b.device);
      if (!a || !b) return;
      if (a.type === 'host' && b.type === 'switch') {
        if (!hostToSwitches.has(a.id)) hostToSwitches.set(a.id, []);
        hostToSwitches.get(a.id).push(b.id);
      } else if (b.type === 'host' && a.type === 'switch') {
        if (!hostToSwitches.has(b.id)) hostToSwitches.set(b.id, []);
        hostToSwitches.get(b.id).push(a.id);
      }
    });

    var byPrimary = new Map();
    devices.forEach(function (d) {
      if (d.type !== 'host' || d._group) return;
      var sws = (hostToSwitches.get(d.id) || []).slice().sort(function (x, y) {
        var dx = devById.get(x), dy = devById.get(y);
        return String(dx ? dx.label : x).localeCompare(String(dy ? dy.label : y), 'zh-Hans-CN');
      });
      if (!sws.length) return;
      var primary = sws[0];
      if (!byPrimary.has(primary)) byPrimary.set(primary, []);
      byPrimary.get(primary).push(d);
    });

    var groupMap = new Map();
    var groups = [];
    byPrimary.forEach(function (members, primaryId) {
      if (members.length < 2) return;
      var gid = 'hgroup:' + primaryId;
      if (state.expandedGroups.has(gid)) return;
      var primary = devById.get(primaryId);
      var g = {
        id: gid, type: 'host', label: '主机组', wwn: null, ips: [], ports: [],
        meta: { layer: 0, group: primary ? primary.label : '', count: members.length },
        _group: true,
        _groupCount: members.length,
        _groupSwitch: primaryId,
        _groupSwitchLabel: primary ? primary.label : '',
        _groupHosts: members.map(function (m) { return m.id; }),
        _plane: primary && primary._plane ? primary._plane : '',
        _planeLabel: primary && primary._planeLabel ? primary._planeLabel : '',
        _health: worstHealth(members.map(function (m) { return deviceHealth(m); }))
      };
      devById.set(gid, g);
      state._groupIds.push(gid);
      groups.push(g);
      members.forEach(function (m) { groupMap.set(m.id, gid); });
    });

    if (!groups.length) return { devices: devices, links: links };

    var outDevices = devices.filter(function (d) { return !groupMap.has(d.id); }).concat(groups);
    var outLinks = [];
    links.forEach(function (l) {
      var ga = groupMap.get(l.a.device);
      var gb = groupMap.get(l.b.device);
      if (ga && gb && ga === gb) return;
      outLinks.push({
        a: ga ? { device: ga, port: null, wwn: l.a.wwn } : l.a,
        b: gb ? { device: gb, port: null, wwn: l.b.wwn } : l.b,
        kind: l.kind, status: l.status, speed: l.speed, source: l.source, meta: l.meta
      });
    });
    return { devices: outDevices, links: outLinks };
  }

  function scopeFields() {
    return [['site', '站点'], ['fabric', '网络平面'], ['rack', '机房']];
  }

  function parseScope(value) {
    if (!value || value === 'all') return null;
    var i = value.indexOf('|');
    if (i < 0) return null;
    return { field: value.slice(0, i), value: decodeURIComponent(value.slice(i + 1)) };
  }

  function scopeMatch(d) {
    var scope = parseScope(state.scope);
    if (!scope) return true;
    var actual = d.meta && d.meta[scope.field];
    // 没有该字段的设备视为共享设备，保留；有字段的才参与范围过滤
    if (actual == null || actual === '') return true;
    return String(actual) === scope.value;
  }

  function scopeLabel() {
    var scope = parseScope(state.scope);
    if (!scope) return '全部';
    var label = scope.field;
    scopeFields().forEach(function (f) { if (f[0] === scope.field) label = f[1]; });
    return label + ' · ' + scope.value;
  }

  function renderScopeSelector() {
    var row = $('#scope-row');
    var sel = $('#scope-select');
    if (!row || !sel) return;
    var groups = [];
    scopeFields().forEach(function (f) {
      var values = Array.from(new Set(G.devices.map(function (d) {
        return d.meta && d.meta[f[0]] != null ? String(d.meta[f[0]]) : '';
      }).filter(Boolean))).sort(function (a, b) { return a.localeCompare(b, 'zh-Hans-CN'); });
      if (values.length) groups.push({ field: f[0], label: f[1], values: values });
    });
    if (!groups.length) {
      row.hidden = true;
      state.scope = 'all';
      return;
    }
    row.hidden = false;
    var html = '<option value="all">全部</option>';
    groups.forEach(function (g) {
      html += '<optgroup label="' + esc(g.label) + '">';
      g.values.forEach(function (v) {
        html += '<option value="' + esc(g.field + '|' + encodeURIComponent(v)) + '">' + esc(v) + '</option>';
      });
      html += '</optgroup>';
    });
    sel.innerHTML = html;
    var valid = state.scope === 'all' || Array.prototype.some.call(sel.options, function (o) { return o.value === state.scope; });
    if (!valid) state.scope = 'all';
    sel.value = state.scope;
  }

  var PLANE_UNGROUPED = '__ungrouped__';

  function normalizePlaneValue(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return '';
    s = s.replace(/^(fabric|plane|网络平面|交换网络|网络)\s*[:：\-]?\s*/i, '');
    return s.trim();
  }

  function planeLabelFor(key) {
    return key === PLANE_UNGROUPED ? '未分组' : '网络平面 ' + key;
  }

  function planeSort(a, b) {
    if (a === PLANE_UNGROUPED) return 1;
    if (b === PLANE_UNGROUPED) return -1;
    return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true });
  }

  function deviceOwnPlanes(d) {
    var raw = d.meta && d.meta.fabric;
    if (raw == null || raw === '') return [];
    var arr = Array.isArray(raw) ? raw : String(raw).split(/[,\/|+;]+/);
    var seen = {};
    return arr.map(normalizePlaneValue).filter(function (p) {
      if (!p || seen[p]) return false;
      seen[p] = true;
      return true;
    });
  }

  function buildPlaneView(devices, links) {
    var explicit = new Map();
    var neighbors = new Map();
    devices.forEach(function (d) {
      explicit.set(d.id, deviceOwnPlanes(d));
      neighbors.set(d.id, new Set());
    });
    links.forEach(function (l) {
      if (l.a.device === l.b.device) return;
      if (neighbors.has(l.a.device)) neighbors.get(l.a.device).add(l.b.device);
      if (neighbors.has(l.b.device)) neighbors.get(l.b.device).add(l.a.device);
    });

    // Switches without an explicit fabric learn the planes of adjacent devices.
    // This handles a CMDB that only tags hosts/storage, or a shared core switch.
    var switchPlanes = new Map();
    devices.forEach(function (d) {
      if (d.type === 'switch') switchPlanes.set(d.id, new Set(explicit.get(d.id) || []));
    });
    for (var pass = 0; pass < 6; pass++) {
      var changed = false;
      devices.forEach(function (d) {
        if (d.type !== 'switch' || explicit.get(d.id).length) return;
        var set = switchPlanes.get(d.id);
        (neighbors.get(d.id) || new Set()).forEach(function (id) {
          var other = devById.get(id);
          if (!other) return;
          var ps = other.type === 'switch' ? switchPlanes.get(id) : new Set(explicit.get(id) || []);
          (ps || new Set()).forEach(function (p) {
            if (!set.has(p)) { set.add(p); changed = true; }
          });
        });
      });
      if (!changed) break;
    }

    var devicePlanes = new Map();
    devices.forEach(function (d) {
      var ps = new Set(explicit.get(d.id) || []);
      if (d.type === 'switch') {
        if (!ps.size) ps = new Set(switchPlanes.get(d.id) || []);
      } else {
        (neighbors.get(d.id) || new Set()).forEach(function (id) {
          var other = devById.get(id);
          if (!other || other.type !== 'switch') return;
          var swPlanes = explicit.get(id).length ? explicit.get(id) : Array.from(switchPlanes.get(id) || []);
          // A device with its own fabric only picks up a switch's explicit fabric;
          // shared switches are used to place untagged storage/hosts.
          if (!ps.size || explicit.get(id).length) {
            swPlanes.forEach(function (p) { ps.add(p); });
          }
        });
      }
      if (!ps.size) ps.add(PLANE_UNGROUPED);
      devicePlanes.set(d.id, Array.from(ps).sort(planeSort));
    });

    var lanes = new Map();
    function ensureLane(key) {
      if (!lanes.has(key)) {
        lanes.set(key, { key: key, label: planeLabelFor(key), devices: [], links: [], hostCount: 0 });
      }
      return lanes.get(key);
    }
    var clones = new Map();
    var allDevices = [];
    devices.forEach(function (d) {
      devicePlanes.get(d.id).forEach(function (plane) {
        var lane = ensureLane(plane);
        var gid = 'plane:' + encodeURIComponent(plane) + ':' + d.id;
        var clone = Object.assign({}, d);
        clone.id = gid;
        clone._realId = d.id;
        clone._plane = plane;
        clone._planeLabel = lane.label;
        clone._health = deviceHealth(d);
        clone._group = false;
        clone.ips = (d.ips || []).slice();
        clone.meta = Object.assign({}, d.meta || {});
        clone.ports = (d.ports || []).map(function (p) {
          return Object.assign({}, p, { device: gid });
        });
        clones.set(plane + '|' + d.id, clone);
        devById.set(gid, clone);
        state._planeIds.push(gid);
        lane.devices.push(clone);
        allDevices.push(clone);
        if (d.type === 'host') lane.hostCount++;
      });
    });

    var allLinks = [];
    var skipped = 0;
    links.forEach(function (l) {
      if (l.a.device === l.b.device) return;
      var pa = devicePlanes.get(l.a.device) || [];
      var pb = devicePlanes.get(l.b.device) || [];
      var common = pa.filter(function (p) { return pb.indexOf(p) >= 0; });
      if (!common.length) { skipped++; return; }
      common.forEach(function (plane) {
        var a = clones.get(plane + '|' + l.a.device);
        var b = clones.get(plane + '|' + l.b.device);
        if (!a || !b) return;
        var lane = ensureLane(plane);
        var clone = {
          a: { device: a.id, port: l.a.port, wwn: l.a.wwn },
          b: { device: b.id, port: l.b.port, wwn: l.b.wwn },
          kind: l.kind, status: l.status, speed: l.speed, source: l.source, meta: l.meta
        };
        lane.links.push(clone);
        allLinks.push(clone);
      });
    });

    var laneList = Array.from(lanes.values())
      .filter(function (lane) { return lane.devices.length > 0; })
      .sort(function (a, b) { return planeSort(a.key, b.key); });
    return { devices: allDevices, links: allLinks, lanes: laneList, skipped: skipped };
  }

  function buildDisplayLanes(devices, links, planeOrder) {
    var map = new Map();
    var order = [];
    (planeOrder || []).forEach(function (key) {
      map.set(key, { key: key, label: planeLabelFor(key), devices: [], links: [], hostCount: 0 });
      order.push(key);
    });
    devices.forEach(function (d) {
      var key = d._plane || PLANE_UNGROUPED;
      if (!map.has(key)) {
        map.set(key, { key: key, label: planeLabelFor(key), devices: [], links: [], hostCount: 0 });
        order.push(key);
      }
      var lane = map.get(key);
      lane.devices.push(d);
      if (d.type === 'host') lane.hostCount++;
    });
    links.forEach(function (l) {
      var a = devById.get(l.a.device);
      var b = devById.get(l.b.device);
      if (!a || !b) return;
      var key = a._plane || b._plane || PLANE_UNGROUPED;
      if (map.has(key)) map.get(key).links.push(l);
    });
    return order.map(function (key) { return map.get(key); })
      .filter(function (lane) { return lane.devices.length > 0; });
  }

  function layoutLanes(lanes, ranks, rankList) {
    var out = {
      pos: new Map(), portPos: new Map(), sides: new Map(),
      heights: new Map(), cols: new Map(), compactRanks: new Map(), lanes: []
    };
    var cursor = 0;
    lanes.forEach(function (lane) {
      var L = layout(lane.devices, lane.links, ranks, rankList);
      var minY = Infinity, maxY = -Infinity;
      L.pos.forEach(function (p) {
        minY = Math.min(minY, p.y - p.h / 2);
        maxY = Math.max(maxY, p.y + p.h / 2);
      });
      if (!isFinite(minY) || !isFinite(maxY)) return;
      var top = cursor + 58;
      var offset = top - minY;
      L.pos.forEach(function (p, id) {
        out.pos.set(id, { x: p.x, y: p.y + offset, h: p.h, compact: p.compact });
      });
      L.portPos.forEach(function (p, id) {
        out.portPos.set(id, { x: p.x, y: p.y + offset, side: p.side });
      });
      L.sides.forEach(function (v, id) { out.sides.set(id, v); });
      L.heights.forEach(function (v, id) { out.heights.set(id, v); });
      var bandTop = top - 50;
      var bandBottom = top + (maxY - minY) + 12;
      out.lanes.push({
        key: lane.key,
        label: lane.label,
        count: lane.devices.length,
        hostCount: lane.hostCount,
        minY: bandTop,
        maxY: bandBottom,
        devices: lane.devices
      });
      cursor = bandBottom + 44;
    });
    return out;
  }

  function computeView() {
    var q = state.query.trim().toLowerCase();
    var hits = new Set();
    if (q) {
      G.devices.forEach(function (d) { if (deviceMatches(d, q)) hits.add(d.id); });
    }
    state.searchHits = hits;

    var visible = new Set();
    G.devices.forEach(function (d) {
      if (!state.types[d.type]) return;
      if (state.offDevices.has(d.id)) return;
      if (!scopeMatch(d)) return;
      if (d.type === 'switch' && state.hiddenLayers.has(switchLayer(d))) return;
      if (q && state.isolateQuery && !hits.has(d.id)) return;
      visible.add(d.id);
    });

    var links = allLinks.filter(function (l) {
      if (!visible.has(l.a.device) || !visible.has(l.b.device)) return false;
      if (state.kinds[l.kind] === false) return false;
      if (state.onlyUp && l.status === 'down') return false;
      if (!linkPortsOn(l)) return false;
      return true;
    });

    var deg = new Map();
    links.forEach(function (l) {
      deg.set(l.a.device, (deg.get(l.a.device) || 0) + 1);
      deg.set(l.b.device, (deg.get(l.b.device) || 0) + 1);
    });

    if (state.hideIsolated) {
      Array.from(visible).forEach(function (id) {
        if (!deg.has(id) && !hits.has(id) && !state.pinned.has(id)) visible.delete(id);
      });
      links = links.filter(function (l) {
        return visible.has(l.a.device) && visible.has(l.b.device);
      });
    }

    var devices = Array.from(visible).map(function (id) { return devById.get(id); });

    (state._groupIds || []).forEach(function (id) { devById.delete(id); });
    (state._planeIds || []).forEach(function (id) { devById.delete(id); });
    state._groupIds = [];
    state._planeIds = [];
    state._planeMode = false;
    var planeLanes = null;
    var displayDevices = devices;
    var displayLinks = links;
    state._planeSkipped = 0;
    if (state.layout === 'plane' && state.gran === 'device' && hasPlaneMeta()) {
      var planeView = buildPlaneView(devices, links);
      state._planeSkipped = planeView.skipped || 0;
      var visiblePlanes = planeView.lanes.filter(function (lane) {
        return !state.collapsedPlanes.has(lane.key);
      });
      if (visiblePlanes.length) {
        var laneKeys = new Set(visiblePlanes.map(function (lane) { return lane.key; }));
        displayDevices = planeView.devices.filter(function (d) { return laneKeys.has(d._plane); });
        displayLinks = planeView.links.filter(function (l) {
          var a = devById.get(l.a.device), b = devById.get(l.b.device);
          return a && b && laneKeys.has(a._plane) && laneKeys.has(b._plane);
        });
        planeLanes = visiblePlanes;
        state._planeMode = true;
      } else {
        displayDevices = [];
        displayLinks = [];
        planeLanes = [];
        state._planeMode = true;
      }
    }

    var hostCount = displayDevices.filter(function (d) { return d.type === 'host'; }).length;
    var autoBundled = !!state.autoBundle && !state.collapseHosts && state.gran === 'device' &&
      displayLinks.length >= AUTO_BUNDLE_MIN_LINKS && hostCount >= 20;
    state._autoBundled = autoBundled;
    if ((state.collapseHosts || autoBundled) && state.gran === 'device') {
      var collapsed = collapseHostGroups(displayDevices, displayLinks);
      displayDevices = collapsed.devices;
      displayLinks = collapsed.links;
    }

    var ranks = computeRanks(displayDevices, displayLinks);
    var L;
    if (state._planeMode) {
      var planeOrder = planeLanes.map(function (lane) { return lane.key; });
      planeLanes = buildDisplayLanes(displayDevices, displayLinks, planeOrder);
      var rankList = Array.from(new Set(Array.from(ranks.values()))).sort(function (a, b) { return a - b; });
      L = layoutLanes(planeLanes, ranks, rankList);
    } else {
      L = layout(displayDevices, displayLinks, ranks);
    }

    var nodes = [];
    displayDevices.forEach(function (d) {
      var p = L.pos.get(d.id);
      if (!p) return;
      var sides = L.sides.get(d.id) || { L: [], R: [] };
      var isGroup = !!d._group;
      nodes.push({
        id: d.id,
        x: p.x,
        y: p.y,
        title: deviceTitle(d),
        _kind: 'device',
        _device: isGroup ? d.id : (d._realId || d.id),
        _plane: d._plane || null,
        _ghost: !!(d._realId && !isGroup),
        _type: d.type,
        _w: isGroup ? COMPACT_W : (p.compact ? COMPACT_W : CARD_W),
        _h: isGroup ? COMPACT_H : p.h,
        _compact: isGroup ? true : !!p.compact,
        _rows: { L: sides.L.length, R: sides.R.length }
      });
    });

    var portNodeIds = new Set();
    if (state.gran === 'port') {
      displayDevices.forEach(function (d) {
        var s = L.sides.get(d.id);
        if (!s) return;
        ['L', 'R'].forEach(function (sideKey) {
          s[sideKey].forEach(function (item) {
            var pp = L.portPos.get(item.port.id);
            if (!pp) return;
            var pnodeId = 'p:' + item.port.id;
            nodes.push({
              id: pnodeId,
              x: pp.x,
              y: pp.y,
              title: portTitle(d, item.port),
              _kind: 'port',
              _device: d.id,
              _port: item.port.id,
              _type: d.type,
              _side: sideKey,
              _w: PORT_W,
              _h: PORT_H
            });
            portNodeIds.add(pnodeId);
          });
        });
      });
    }

    function nodeOf(ep) {
      if (ep.port && portNodeIds.has('p:' + ep.port)) return 'p:' + ep.port;
      return ep.device;
    }

    function pairKey(a, b) {
      return a < b ? a + '|' + b : b + '|' + a;
    }

    function realDeviceId(id) {
      var d = devById.get(id);
      return d && d._realId ? d._realId : id;
    }

    var edges = [];
    var madePairs = new Set();

    if (state.gran === 'port') {
      displayLinks.forEach(function (l) {
        var from = nodeOf(l.a);
        var to = nodeOf(l.b);
        if (from === to) return;
        var pk = (from < to ? from + '>' + to : to + '>' + from);
        if (madePairs.has(pk)) return;
        madePairs.add(pk);
        var lh = linkHealth(l);
        var color = lh === 'down' ? healthColors().down : (edgeColors()[l.kind] || edgeColors().other);
        edges.push({
          id: 'e:' + pk,
          from: from,
          to: to,
          width: lh === 'down' ? 2.2 : 1.6,
          dashes: lh === 'down' ? [6, 4] : (l.kind === 'unknown' ? [4, 4] : false),
          smooth: false,
          color: { color: color, highlight: color, hover: color },
          title: edgeTitle([l]),
          _links: [l],
          _pair: pairKey(realDeviceId(l.a.device), realDeviceId(l.b.device)),
          _baseColor: color,
          _baseWidth: lh === 'down' ? 2.2 : 1.6,
          _health: lh
        });
      });
    } else {
      var agg = new Map();
      displayLinks.forEach(function (l) {
        if (l.a.device === l.b.device) return;
        var key = pairKey(l.a.device, l.b.device);
        if (!agg.has(key)) agg.set(key, { a: l.a.device, b: l.b.device, links: [] });
        agg.get(key).links.push(l);
      });
      agg.forEach(function (item, key) {
        var kinds = new Set(item.links.map(function (l) { return l.kind; }));
        var kind = kinds.has('unknown') ? 'unknown'
          : kinds.has('switch') ? 'switch'
          : kinds.has('storage') ? 'storage'
          : kinds.has('host') ? 'host' : 'other';
        var aggHealth = worstHealth(item.links.map(function (l) { return linkHealth(l) === 'down' ? 'down' : (linkHealth(l) === 'up' ? 'ok' : 'unknown'); }));
        var color = aggHealth === 'down' ? healthColors().down : (edgeColors()[kind] || edgeColors().other);
        var count = item.links.length;
        var width = (aggHealth === 'down' ? 2.2 : 1.5) + Math.min(2.6, (count - 1) * 0.6);
        edges.push({
          id: 'e:' + key,
          from: item.a,
          to: item.b,
          width: width,
          dashes: aggHealth === 'down' ? [6, 4] : (kind === 'unknown' ? [4, 4] : false),
          smooth: { enabled: true, type: 'cubicBezier', forceDirection: 'horizontal', roundness: 0.3 },
          color: { color: color, highlight: color, hover: color },
          label: '',
          title: edgeTitle(item.links),
          _links: item.links,
          _pair: pairKey(realDeviceId(item.a), realDeviceId(item.b)),
          _baseColor: color,
          _baseWidth: width,
          _health: aggHealth
        });
      });
    }

    return { devices: visible, links: links, displayDevices: displayDevices, displayLinks: displayLinks, nodes: nodes, edges: edges, ranks: ranks, layout: L };
  }

  function deviceTitle(d) {
    if (d._group) {
      var members = (d._groupHosts || []).map(function (id) { return devById.get(id); }).filter(Boolean);
      var names = members.slice(0, 10).map(function (m) { return m.label; });
      var lines = ['主机组', d._groupCount + ' 台主机'];
      if (d._planeLabel) lines.push('网络平面: ' + d._planeLabel);
      if (d._groupSwitchLabel) lines.push('接入: ' + d._groupSwitchLabel);
      lines.push('健康: ' + (HEALTH_LABEL[d._health] || '未知'));
      lines.push('成员: ' + names.join('、') + (members.length > names.length ? ' …' : ''));
      return lines.join('\n');
    }
    var lines = [];
    lines.push(d.type === 'unknown' ? '未识别设备' : d.label);
    lines.push(TYPE_LABEL[d.type] + (d.type === 'switch' ? ' · 第 ' + switchLayer(d) + ' 层' : ''));
    if (d._planeLabel) lines.push('网络平面: ' + d._planeLabel);
    if (d.wwn) lines.push('WWN: ' + d.wwn);
    (d.ips || []).forEach(function (ip) { lines.push('IP: ' + ip); });
    lines.push('端口: ' + d.ports.length + ' 个，已连接 ' +
      d.ports.filter(function (p) { return p.connected; }).length);
    lines.push('健康: ' + (HEALTH_LABEL[deviceHealth(d)] || '未知'));
    if (d.meta && d.meta.model) lines.push('型号: ' + d.meta.model);
    return lines.join('\n');
  }

  function portTitle(d, p) {
    return [d.label + ' : ' + p.label,
      p.wwn ? 'WWN: ' + p.wwn : '',
      '状态: ' + (p.connected ? '已连接' : (p.unused ? '未使用' : '未连接'))].filter(Boolean).join('\n');
  }

  function edgeTitle(links) {
    var rows = links.slice(0, 10).map(function (l) {
      var s = endpointText(l.a) + ' → ' + endpointText(l.b);
      if (l.status) s += '  [' + l.status + ']';
      return s;
    });
    if (links.length > 10) rows.push('… 共 ' + links.length + ' 条链路');
    var health = worstHealth(links.map(function (l) { return linkHealth(l) === 'down' ? 'down' : (linkHealth(l) === 'up' ? 'ok' : 'unknown'); }));
    if (health === 'down') rows.push('健康: 存在异常链路');
    return rows.join('\n');
  }

  /* ------------------------------------------------------------------ */
  /* 渲染                                                                */
  /* ------------------------------------------------------------------ */

  function networkOptions() {
    return {
      autoResize: true,
      physics: { enabled: false },
      layout: { improvedLayout: false },
      interaction: {
        hover: true,
        tooltipDelay: 160,
        hideEdgesOnDrag: false,
        multiselect: false,
        keyboard: false,
        navigationButtons: false,
        dragNodes: true,
        zoomView: true,
        dragView: true
      },
      nodes: {
        shape: 'custom',
        ctxRenderer: renderNode
      },
      edges: {
        width: 1.5,
        selectionWidth: 2,
        smooth: { enabled: true, type: 'cubicBezier', forceDirection: 'horizontal', roundness: 0.3 }
      }
    };
  }

  function fitGraph(animate) {
    if (!network || !state.nodes.length) return;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    state.nodes.forEach(function (n) {
      minX = Math.min(minX, n.x - n._w / 2);
      maxX = Math.max(maxX, n.x + n._w / 2);
      minY = Math.min(minY, n.y - n._h / 2);
      maxY = Math.max(maxY, n.y + n._h / 2);
    });
    var pad = 56;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    var el = $('#network');
    var cw = el.clientWidth || 1200;
    var ch = el.clientHeight || 800;
    var scale = Math.min(cw / Math.max(1, maxX - minX), ch / Math.max(1, maxY - minY));
    scale = Math.max(0.05, Math.min(scale, 1.4));
    network.moveTo({
      position: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
      scale: scale,
      animation: animate ? { duration: 280 } : false
    });
  }

  function rankColumnMeta(devices) {
    var groups = 0, hosts = 0, switches = 0, storages = 0, unknowns = 0;
    var layers = new Set();
    devices.forEach(function (d) {
      if (d._group) groups++;
      else if (d.type === 'host') hosts++;
      else if (d.type === 'switch') { switches++; layers.add(switchLayer(d)); }
      else if (d.type === 'storage') storages++;
      else unknowns++;
    });
    if (groups + hosts === devices.length) {
      return groups
        ? { cls: 'host', label: '主机组', count: groups + ' 组' }
        : { cls: 'host', label: '主机', count: hosts + ' 台' };
    }
    if (switches > 0 && hosts === 0 && storages === 0) {
      var ls = Array.from(layers).sort(function (a, b) { return a - b; });
      var label = '交换机';
      if (ls.length === 1) label = ls[0] === 1 ? '接入层 L1' : (ls[0] === 2 ? '核心层 L2' : '交换机 L' + ls[0]);
      var scount = switches + ' 台' + (unknowns ? ' + ' + unknowns + ' 未识别' : '');
      return { cls: 'switch', label: label, count: scount };
    }
    if (storages > 0 && hosts === 0 && switches === 0) {
      return { cls: 'storage', label: '存储 SAN/NAS',
        count: storages + ' 套' + (unknowns ? ' + ' + unknowns + ' 未识别' : '') };
    }
    if (unknowns === devices.length) return { cls: 'unknown', label: '未识别', count: unknowns + ' 个' };
    return { cls: 'mixed', label: '混合', count: devices.length + ' 台' };
  }

  function planeAccent(key) {
    if (key === PLANE_UNGROUPED) return healthColors().unknown;
    var s = String(key).toLowerCase();
    if (s.indexOf('a') === 0) return '#3b82f6';
    if (s.indexOf('b') === 0) return '#f59e0b';
    return '#64748b';
  }

  function planeClass(key) {
    if (key === PLANE_UNGROUPED) return 'plane-other';
    var s = String(key).toLowerCase();
    if (s.indexOf('a') === 0) return 'plane-a';
    if (s.indexOf('b') === 0) return 'plane-b';
    return 'plane-other';
  }

  function setupPlaneOverlay(view) {
    var overlay = $('#rank-overlay');
    if (!overlay) return;
    overlay.innerHTML = '';
    rankCols = [];
    planeCols = [];
    var nodeByDisplay = new Map();
    state.nodes.forEach(function (n) { nodeByDisplay.set(n.id, n); });
    view.layout.lanes.forEach(function (lane) {
      var nodes = state.nodes.filter(function (n) { return n._plane === lane.key; });
      if (!nodes.length) return;
      var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      nodes.forEach(function (n) {
        minX = Math.min(minX, n.x - n._w / 2);
        maxX = Math.max(maxX, n.x + n._w / 2);
        minY = Math.min(minY, n.y - n._h / 2);
        maxY = Math.max(maxY, n.y + n._h / 2);
      });
      var groupCount = lane.devices.filter(function (d) { return !!d._group; }).length;
      var count = groupCount ? groupCount + ' 组主机' : (lane.hostCount ? lane.hostCount + ' 台主机' : lane.count + ' 个节点');
      var warn = lane.devices.filter(function (d) {
        var h = deviceHealth(d);
        return h === 'degraded' || h === 'down';
      }).length;
      if (warn) count += ' · ' + warn + ' 异常';
      var band = document.createElement('div');
      band.className = 'rank-band plane ' + planeClass(lane.key);
      var label = document.createElement('div');
      label.className = 'rank-label plane-label ' + planeClass(lane.key);
      label.setAttribute('data-plane', lane.key);
      label.setAttribute('title', '点击折叠' + lane.label);
      label.innerHTML = '<i class="dot"></i>' + esc(lane.label) + ' <span>' + esc(count) + '</span><span class="plane-collapse">−</span>';
      overlay.appendChild(band);
      overlay.appendChild(label);
      rankCols.push({
        kind: 'lane',
        planeKey: lane.key,
        accent: planeAccent(lane.key),
        band: band,
        label: label,
        meta: { label: lane.label, count: count },
        minX: minX - 18, maxX: maxX + 18,
        minY: lane.minY, maxY: lane.maxY
      });

      var colMap = new Map();
      lane.devices.forEach(function (d) {
        var n = nodeByDisplay.get(d.id);
        if (!n) return;
        var r = view.ranks && view.ranks.get(d.id);
        if (r == null) r = Math.round(n.x);
        if (!colMap.has(r)) colMap.set(r, []);
        colMap.get(r).push({ d: d, n: n });
      });
      colMap.forEach(function (items) {
        if (!items.length) return;
        var devices = items.map(function (x) { return x.d; });
        var meta = rankColumnMeta(devices);
        var cx = items.reduce(function (sum, x) { return sum + x.n.x; }, 0) / items.length;
        var el = document.createElement('div');
        el.className = 'rank-label plane-col ' + meta.cls;
        el.textContent = meta.label;
        el.title = meta.label + ' · ' + meta.count;
        overlay.appendChild(el);
        planeCols.push({
          label: el,
          x: cx,
          y: lane.minY + 26,
          laneKey: lane.key
        });
      });
    });
    updateRankOverlay();
  }

  function setupRankOverlay(view) {
    var overlay = $('#rank-overlay');
    if (!overlay) return;
    overlay.innerHTML = '';
    rankCols = [];
    planeCols = [];
    if (!view || !view.layout || !state.nodes.length) return;
    if (view.layout.lanes && view.layout.lanes.length) {
      setupPlaneOverlay(view);
      return;
    }
    if (!view.layout.cols) return;
    var nodeByDev = new Map();
    state.nodes.forEach(function (n) { nodeByDev.set(n._device, n); });
    view.layout.cols.forEach(function (devices) {
      var nodes = devices.map(function (d) { return nodeByDev.get(d.id); }).filter(Boolean);
      if (!nodes.length) return;
      var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      nodes.forEach(function (n) {
        minX = Math.min(minX, n.x - n._w / 2);
        maxX = Math.max(maxX, n.x + n._w / 2);
        minY = Math.min(minY, n.y - n._h / 2);
        maxY = Math.max(maxY, n.y + n._h / 2);
      });
      var meta = rankColumnMeta(devices);
      var band = document.createElement('div');
      band.className = 'rank-band ' + meta.cls;
      var label = document.createElement('div');
      label.className = 'rank-label ' + meta.cls;
      label.innerHTML = '<i class="dot"></i>' + esc(meta.label) + ' <span>' + esc(meta.count) + '</span>';
      overlay.appendChild(band);
      overlay.appendChild(label);
      rankCols.push({
        band: band, label: label,
        meta: meta,
        minX: minX - 16, maxX: maxX + 16,
        minY: minY - 10, maxY: maxY + 10
      });
    });
  }

  function drawRankOverlayOnCanvas(ctx, net, cssWidth, baseWidth) {
    if (!net || !rankCols.length || !cssWidth) return;
    var k = ctx.canvas.width / cssWidth;
    var u = ctx.canvas.width / (baseWidth || cssWidth);
    var pal = palette();
    var shadcn = state.shell === 'shadcn';
    var panel = state.theme === 'dark' ? '#18181b' : '#ffffff';
    var border = state.theme === 'dark' ? '#27272a' : '#e4e4e7';
    var ink = state.theme === 'dark' ? '#fafafa' : '#18181b';
    var faint = state.theme === 'dark' ? '#a1a1aa' : '#71717a';
    rankCols.forEach(function (c) {
      var a = net.canvasToDOM({ x: c.minX, y: c.minY });
      var b = net.canvasToDOM({ x: c.maxX, y: c.maxY });
      var x = Math.min(a.x, b.x) * k;
      var y = Math.min(a.y, b.y) * k;
      var w = Math.abs(b.x - a.x) * k;
      var h = Math.abs(b.y - a.y) * k;
      var base = pal[c.meta.cls === 'mixed' ? 'unknown' : c.meta.cls] || pal.unknown;
      var accent = c.accent || base.accent;
      ctx.save();
      ctx.beginPath();
      if (shadcn) {
        ctx.fillStyle = state.theme === 'dark' ? 'rgba(250,250,250,.022)' : 'rgba(113,113,122,.025)';
        ctx.strokeStyle = state.theme === 'dark' ? 'rgba(250,250,250,.07)' : 'rgba(113,113,122,.08)';
      } else {
        ctx.fillStyle = alpha(accent, state.theme === 'dark' ? 0.055 : 0.045);
        ctx.strokeStyle = alpha(accent, state.theme === 'dark' ? 0.13 : 0.10);
      }
      rrect(ctx, x, y, w, h, 16 * u);
      ctx.fill();
      ctx.lineWidth = Math.max(1, u);
      ctx.stroke();

      if ((c.kind === 'lane' ? w / u < 120 : w / u < 64) || window.innerWidth <= 760) { ctx.restore(); return; }
      var fontSize = 10 * u;
      ctx.font = '600 ' + fontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif';
      var tw = ctx.measureText(c.meta.label).width;
      var cw = ctx.measureText(c.meta.count).width;
      var pad = 8 * u;
      var dot = 5 * u;
      var gap = 5 * u;
      var lw = pad * 2 + dot + gap + tw + gap + cw;
      var lh = 18 * u;
      var lx = c.kind === 'lane' ? x + 12 * u : x + w / 2 - lw / 2;
      var ly = c.kind === 'lane' ? y + 5 * u : Math.max(4 * u, y - 23 * u);
      ctx.beginPath();
      ctx.fillStyle = panel;
      ctx.strokeStyle = border;
      rrect(ctx, lx, ly, lw, lh, 999);
      ctx.fill();
      ctx.lineWidth = Math.max(1, u);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(lx + pad + dot / 2, ly + lh / 2, 2.5 * u, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = '600 ' + fontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif';
      ctx.fillStyle = ink;
      var tx = lx + pad + dot + gap;
      ctx.fillText(c.meta.label, tx, ly + lh / 2 + 0.5 * u);
      ctx.font = '400 ' + fontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif';
      ctx.fillStyle = faint;
      ctx.fillText(c.meta.count, tx + tw + gap, ly + lh / 2 + 0.5 * u);
      ctx.restore();
    });
    planeCols.forEach(function (c) {
      var p = net.canvasToDOM({ x: c.x, y: c.y });
      var x = p.x * k, y = p.y * k;
      ctx.save();
      ctx.font = '500 ' + (9 * u) + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif';
      ctx.fillStyle = state.theme === 'dark' ? '#a1a1aa' : '#71717a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.label.textContent, x, y);
      ctx.restore();
    });
  }

  function updateRankOverlay() {
    if (!network || !rankCols.length) return;
    function local(p) { return p; }
    rankCols.forEach(function (c) {
      var a = local(network.canvasToDOM({ x: c.minX, y: c.minY }));
      var b = local(network.canvasToDOM({ x: c.maxX, y: c.maxY }));
      var left = Math.min(a.x, b.x);
      var top = Math.min(a.y, b.y);
      var w = Math.abs(b.x - a.x);
      var h = Math.abs(b.y - a.y);
      c.band.style.left = left + 'px';
      c.band.style.top = top + 'px';
      c.band.style.width = Math.max(10, w) + 'px';
      c.band.style.height = Math.max(10, h) + 'px';
      var show = c.kind === 'lane' ? w >= 120 : w >= 64;
      c.label.style.display = show ? 'flex' : 'none';
      if (show) {
        if (c.kind === 'lane') {
          c.label.style.transform = 'none';
          c.label.style.left = (left + 12) + 'px';
          c.label.style.top = (top + 6) + 'px';
        } else {
          c.label.style.transform = 'translateX(-50%)';
          c.label.style.left = (left + w / 2) + 'px';
          c.label.style.top = Math.max(6, top - 23) + 'px';
        }
      }
    });
    planeCols.forEach(function (c) {
      var p = local(network.canvasToDOM({ x: c.x, y: c.y }));
      c.label.style.left = p.x + 'px';
      c.label.style.top = p.y + 'px';
    });
  }

  function rebuild(opts) {
    opts = opts || {};
    var view = computeView();
    state.view = view;
    state.nodes = view.nodes;
    state.edges = view.edges;
    state.nodeById = new Map(view.nodes.map(function (n) { return [n.id, n]; }));
    state.focus = null;
    state.focusCenter = null;
    state.pathNodes = null;
    state.pathPairs = null;
    state.pathSel = [];
    state.current = null;
    hideDetail();

    var empty = $('#empty');
    if (!view.nodes.length) empty.classList.remove('hidden');
    else empty.classList.add('hidden');

    if (!network) {
      nodesDS = new vis.DataSet(view.nodes);
      edgesDS = new vis.DataSet(view.edges);
      network = new vis.Network($('#network'), { nodes: nodesDS, edges: edgesDS }, networkOptions());
      network.on('click', onNetworkClick);
      network.on('afterDrawing', updateRankOverlay);
      requestAnimationFrame(function () { fitGraph(false); });
      setTimeout(function () { fitGraph(false); }, 180);
    } else {
      var cam = opts.keepCamera ? { position: network.getViewPosition(), scale: network.getScale() } : null;
      nodesDS.clear();
      edgesDS.clear();
      nodesDS.add(view.nodes);
      edgesDS.add(view.edges);
      if (cam) {
        network.moveTo({ position: cam.position, scale: cam.scale, animation: false });
      } else {
        requestAnimationFrame(function () { fitGraph(true); });
      }
    }

    renderChrome();
    applyStyles();
    setupRankOverlay(view);
    updateRankOverlay();
  }

  function applyStyles() {
    if (!network) return;
    var focus = state.focus;
    var path = state.pathNodes;
    var hits = state.searchHits;

    nodeFlags.clear();
    state.nodes.forEach(function (n) {
      var dim = false;
      if (path) dim = !path.has(n.id);
      else if (focus) dim = !focus.has(n.id);
      var nd = devById.get(n._device);
      function idHit(id) {
        if (hits.has(id)) return true;
        var hd = devById.get(id);
        return !!(hd && hd._realId && hits.has(hd._realId));
      }
      var hit = !!hits && hits.size > 0 && (hits.has(n._device) ||
        !!(nd && nd._group && nd._groupHosts && nd._groupHosts.some(idHit)));
      nodeFlags.set(n.id, {
        dim: dim,
        hit: !dim && hit,
        path: !!path && path.has(n.id),
        center: !!focus && n.id === state.focusCenter && !dim
      });
    });

    state.edges.forEach(function (e) {
      var dim = false;
      if (path && state.pathPairs) dim = !state.pathPairs.has(e._pair);
      else if (focus) dim = !(focus.has(e.from) || focus.has(e.to));
      var inPath = path && state.pathPairs && state.pathPairs.has(e._pair);
      var color = inPath ? '#ef4444' : e._baseColor;
      edgesDS.update({
        id: e.id,
        color: {
          color: dim ? alpha(color, 0.1) : color,
          highlight: color,
          hover: color
        },
        width: dim ? 1 : (inPath ? 2.8 : e._baseWidth)
      });
    });

    network.redraw();
  }

  /* ------------------------------------------------------------------ */
  /* 统计 / 侧栏 / 筛选条                                                */
  /* ------------------------------------------------------------------ */

  function updateStats() {
    var counts = { host: 0, switch: 0, storage: 0, unknown: 0 };
    var ports = 0;
    state.view.devices.forEach(function (id) {
      var d = devById.get(id);
      if (!d) return;
      counts[d.type]++;
      ports += d.ports.length;
    });

    var total = state.view.devices.size;
    var links = state.view.links.length;
    var health = { ok: 0, degraded: 0, down: 0, unknown: 0 };
    state.view.devices.forEach(function (id) {
      var d = devById.get(id);
      if (d) health[deviceHealth(d)]++;
    });
    var totalLogs = (G.sources && G.sources.logs) ? G.sources.logs.length : 0;
    var filtered = total !== G.devices.length;

    var trig = $('#summary-trigger');
    if (trig) {
      trig.setAttribute('aria-label', '设备与链路概览：' + total + ' 台设备，' + links + ' 条链路');
      trig.setAttribute('data-tip', '设备概览：' + total + ' 台设备 · ' + links + ' 条链路');
    }
    $('#summary-total').textContent = total;
    $('#summary-total-card').textContent = total + ' 台';
    $('#summary-sub').textContent = filtered ? '当前视图 · 已筛选' : '当前视图 · 全部设备';

    var segs = [
      ['host', counts.host], ['switch', counts.switch],
      ['storage', counts.storage], ['unknown', counts.unknown]
    ].filter(function (x) { return x[1] > 0; });
    var deviceSum = segs.reduce(function (n, x) { return n + x[1]; }, 0);
    $('#summary-bar').innerHTML = deviceSum
      ? segs.map(function (x) {
          return '<span class="' + x[0] + '" style="width:' + (x[1] / deviceSum * 100).toFixed(2) + '%"></span>';
        }).join('')
      : '';

    var entries = [
      ['host', '主机', counts.host, 'dot host', ''],
      ['switch', '交换机', counts.switch, 'dot switch', ''],
      ['storage', '存储', counts.storage, 'dot storage', ''],
      ['unknown', '未识别', counts.unknown, 'dot unknown', ''],
      ['link', '链路', links, 'sum-ico', '⇄'],
      ['port', '端口', ports, 'sum-ico', '◫']
    ];
    $('#summary-stats').innerHTML = entries.map(function (e) {
      var icon = e[3].indexOf('dot') === 0
        ? '<i class="' + e[3] + '"></i>'
        : '<i class="' + e[3] + '">' + e[4] + '</i>';
      return '<div class="summary-stat" data-type="' + e[0] + '">' + icon +
        '<span>' + e[1] + '</span><b>' + e[2] + '</b></div>';
    }).join('');

    var rows = [
      ['数据来源', totalLogs + ' 个交换机日志'],
      ['生成时间', G.generated_at || '—'],
      ['健康状态', '正常 ' + health.ok + ' · 降级 ' + health.degraded + ' · 离线 ' + health.down +
        (health.unknown ? ' · 未知 ' + health.unknown : '')],
      ['筛选状态', filtered ? '已筛选 · ' + total + ' / ' + G.devices.length + ' 台' : '全部设备']
    ];
    $('#summary-extra').innerHTML = rows.map(function (r) {
      return '<div class="summary-row"><span>' + r[0] + '</span><b>' + esc(r[1]) + '</b></div>';
    }).join('');

    $('#meta-line').textContent = '生成于 ' + (G.generated_at || '—');
  }

  function renderTypeFilters() {
    var counts = { host: 0, switch: 0, storage: 0, unknown: 0 };
    G.devices.forEach(function (d) { counts[d.type]++; });
    var html = ['host', 'switch', 'storage', 'unknown'].map(function (t) {
      return '<label class="switch-row"><input type="checkbox" data-type="' + t + '"' +
        (state.types[t] ? ' checked' : '') + '/>' +
        '<span class="check-label"><i class="dot ' + t + '"></i>' + TYPE_LABEL[t] + '</span>' +
        '<span class="count">' + (counts[t] || 0) + '</span></label>';
    }).join('');
    $('#type-filters').innerHTML = html;
  }

  function renderKindFilters() {
    var counts = {};
    allLinks.forEach(function (l) { counts[l.kind] = (counts[l.kind] || 0) + 1; });
    var html = KIND_ORDER.map(function (k) {
      return '<label class="switch-row"><input type="checkbox" data-kind="' + k + '"' +
        (state.kinds[k] !== false ? ' checked' : '') + '/>' +
        '<span class="check-label"><i class="line ' + (k === 'other' ? 'unknown' : k) + '"></i>' + KIND_LABEL[k] + '</span>' +
        '<span class="count">' + (counts[k] || 0) + '</span></label>';
    }).join('');
    $('#kind-filters').innerHTML = html;
  }

  function renderLayerChips() {
    var layers = Array.from(new Set(G.devices.filter(function (d) { return d.type === 'switch'; })
      .map(function (d) { return switchLayer(d); }))).sort(function (a, b) { return a - b; });
    var box = $('#layer-filter');
    if (!layers.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    var html = '<button class="chip-toggle' + (state.hiddenLayers.size === 0 ? ' active' : '') + '" data-layer="all">全部</button>';
    html += layers.map(function (l) {
      var off = state.hiddenLayers.has(l);
      return '<button class="chip-toggle' + (off ? ' off' : ' active') + '" data-layer="' + l + '">L' + l + '</button>';
    }).join('');
    $('#layer-chips').innerHTML = html;
  }

  function deviceStats() {
    var out = { host: { on: 0, total: 0 }, switch: { on: 0, total: 0 }, storage: { on: 0, total: 0 } };
    G.devices.forEach(function (d) {
      if (!out[d.type]) return;
      out[d.type].total++;
      if (deviceOn(d)) out[d.type].on++;
    });
    return out;
  }

  function portStats() {
    var on = 0, total = 0;
    G.devices.forEach(function (d) {
      d.ports.forEach(function (p) {
        total++;
        if (deviceOn(d) && !state.offPorts.has(p.id)) on++;
      });
    });
    return { on: on, total: total };
  }

  function updateScopeCounts() {
    var s = deviceStats();
    var p = portStats();
    $('#scope-host').textContent = s.host.on + '/' + s.host.total;
    $('#scope-switch').textContent = s.switch.on + '/' + s.switch.total;
    $('#scope-storage').textContent = s.storage.on + '/' + s.storage.total;
    $('#scope-port').textContent = p.on + '/' + p.total;
    ['host', 'switch', 'storage'].forEach(function (t) {
      var tile = $('.scope-tile[data-scope="' + t + '"]');
      if (tile) tile.classList.toggle('filtered', s[t].on < s[t].total);
    });
    var portTile = $('.scope-tile[data-scope="port"]');
    if (portTile) portTile.classList.toggle('filtered', p.on < p.total);
  }

  function renderFilterBar() {
    var s = deviceStats();
    var p = portStats();
    var chips = [];
    ['host', 'switch', 'storage'].forEach(function (t) {
      if (!state.types[t]) {
        chips.push({ key: 'type:' + t, html: TYPE_LABEL[t] + ' 已隐藏' });
      } else if (s[t].on < s[t].total) {
        chips.push({ key: 'devices:' + t, html: TYPE_LABEL[t] + ' <b>' + s[t].on + '/' + s[t].total + '</b>' });
      }
    });
    if (state.offPorts.size > 0) {
      chips.push({ key: 'ports', html: '网口 <b>' + p.on + '/' + p.total + '</b>' });
    }
    if (state.hiddenLayers.size > 0) {
      chips.push({ key: 'layers', html: '层级 <b>' + Array.from(state.hiddenLayers).sort().map(function (l) { return 'L' + l; }).join('、') + '</b> 已隐藏' });
    }
    if (state.hiddenLayers.size === 0 && state.offDevices.size === 0 && state.offPorts.size === 0 &&
      state.types.host && state.types.switch && state.types.storage) {
      // 仅剩显示类条件时不显示筛选条
    }
    if (state.onlyUp) chips.push({ key: 'onlyup', html: '仅在线链路' });
    if (state.scope !== 'all') chips.push({ key: 'scope', html: '范围 <b>' + esc(scopeLabel()) + '</b>' });
    if (state.layout === 'plane' && hasPlaneMeta()) {
      state.collapsedPlanes.forEach(function (key) {
        chips.push({ key: 'plane:' + key, html: '<b>' + esc(planeLabelFor(key)) + '</b> 已折叠' });
      });
    }
    if (state.collapseHosts && state.gran === 'device') chips.push({ key: 'collapse', html: '主机已折叠' });
    if (state.gran === 'device' && state._autoBundled) chips.push({ key: 'auto-bundle', html: '链路过多 · 已自动聚合' });
    if (state.collapseHosts && state.gran === 'device' && state.expandedGroups.size) {
      chips.push({ key: 'expanded-groups', html: '已展开 <b>' + state.expandedGroups.size + '</b> 组' });
    }
    if (state.isolateQuery && state.query.trim()) chips.push({ key: 'query', html: '搜索 “' + esc(truncate(state.query.trim(), 16)) + '”' });

    var bar = $('#filterbar');
    if (!chips.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
    bar.classList.remove('hidden');
    bar.innerHTML = chips.map(function (c) {
      return '<span class="fchip">' + c.html + '<span class="x" data-fclear="' + esc(c.key) + '" title="移除该筛选">×</span></span>';
    }).join('') + '<button class="fchip-clear" data-fclear="all">清除全部筛选</button>';
  }

  function renderWarnings() {
    var ws = G.warnings || [];
    var panel = $('#warning-panel');
    var badge = $('#side-info-badge');
    if (badge) {
      badge.hidden = !ws.length;
      badge.textContent = ws.length;
    }
    if (!ws.length) { panel.hidden = true; return; }
    panel.hidden = false;
    $('#warning-count').textContent = ws.length;
    $('#warnings').innerHTML = ws.slice(0, 100).map(function (w) {
      var dev = w.device && devById.has(w.device) ? ' data-device="' + esc(w.device) + '"' : '';
      var level = ['info', 'warn', 'error'].indexOf(w.level) >= 0 ? w.level : 'info';
      return '<div class="warn-item ' + level + '"' + dev + '>' + esc(w.msg) + '</div>';
    }).join('');
  }

  function hasPlaneMeta() {
    return G.devices.some(function (d) {
      return d.meta && d.meta.fabric != null && String(d.meta.fabric).trim() !== '';
    });
  }

  function syncLayoutButtons() {
    var planeAvailable = state.gran === 'device' && hasPlaneMeta();
    $$('#layout-switch [data-layout]').forEach(function (btn) {
      var on = btn.getAttribute('data-layout') === state.layout;
      btn.classList.toggle('active', on);
      btn.disabled = btn.getAttribute('data-layout') === 'plane' && !planeAvailable;
    });
    var planeBtn = $('#layout-switch [data-layout="plane"]');
    if (planeBtn) {
      planeBtn.title = !hasPlaneMeta()
        ? '当前数据没有 meta.fabric'
        : (state.gran !== 'device' ? '网络平面布局仅设备视图可用' : '按网络平面分带');
    }
    var hint = $('#layout-hint');
    if (hint) {
      hint.textContent = !hasPlaneMeta()
        ? '当前数据没有 meta.fabric，网络平面布局不可用。'
        : (state.gran !== 'device'
          ? '网络平面布局仅设备视图可用。'
          : '按 meta.fabric 分带；共享设备会复制到多个平面。' +
          (state._planeSkipped ? '；' + state._planeSkipped + ' 条跨平面链路未显示' : ''));
    }
  }

  function setLayout(name) {
    if (name !== 'plane' && name !== 'layered') return;
    if (name === 'plane' && (state.gran !== 'device' || !hasPlaneMeta())) {
      toast(!hasPlaneMeta() ? '当前数据没有 meta.fabric' : '网络平面布局仅设备视图可用');
      return;
    }
    if (state.layout === name) return;
    state.layout = name;
    try { localStorage.setItem('topo-layout', state.layout); } catch (e) { /* ignore */ }
    syncLayoutButtons();
    rebuild();
  }

  var PRESET_KEY = 'topo-view-presets-v1';
  var presets = [];

  function loadPresets() {
    try {
      var raw = localStorage.getItem(PRESET_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      presets = Array.isArray(parsed) ? parsed : [];
    } catch (e) { presets = []; }
  }

  function persistPresets() {
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(presets.slice(0, 8))); } catch (e) { /* ignore */ }
  }

  function presetSnapshot(name) {
    return {
      id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 6),
      name: name,
      savedAt: new Date().toISOString(),
      types: Object.assign({}, state.types),
      kinds: Object.assign({}, state.kinds),
      offDevices: Array.from(state.offDevices),
      offPorts: Array.from(state.offPorts),
      hiddenLayers: Array.from(state.hiddenLayers),
      scope: state.scope,
      onlyUp: state.onlyUp,
      hideIsolated: state.hideIsolated,
      collapseHosts: state.collapseHosts,
      autoBundle: state.autoBundle,
      layout: state.layout,
      gran: state.gran,
      spacing: state.spacing,
      showUnused: state.showUnused,
      showWwn: state.showWwn,
      query: state.query,
      isolateQuery: state.isolateQuery,
      style: state.style,
      shell: state.shell,
      theme: state.theme,
      collapsedPlanes: Array.from(state.collapsedPlanes)
    };
  }

  function savePreset() {
    var input = $('#preset-name');
    var name = (input && input.value || '').trim();
    if (!name) name = '视图 ' + (presets.length + 1);
    presets = presets.filter(function (p) { return p.name !== name; });
    presets.unshift(presetSnapshot(name));
    presets = presets.slice(0, 8);
    persistPresets();
    renderPresets();
    if (input) input.value = '';
    toast('已保存视图预设：' + name);
  }

  function applyPreset(id) {
    var p = presets.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    state.types = Object.assign({ host: true, switch: true, storage: true, unknown: true }, p.types || {});
    state.kinds = Object.assign({ host: true, switch: true, storage: true, unknown: true, other: true }, p.kinds || {});
    state.offDevices = new Set(p.offDevices || []);
    state.offPorts = new Set(p.offPorts || []);
    state.hiddenLayers = new Set(p.hiddenLayers || []);
    state.scope = p.scope || 'all';
    state.onlyUp = !!p.onlyUp;
    state.hideIsolated = p.hideIsolated !== false;
    state.collapseHosts = !!p.collapseHosts;
    state.autoBundle = p.autoBundle !== false;
    state.gran = p.gran === 'port' ? 'port' : 'device';
    state.layout = p.layout === 'plane' && state.gran === 'device' && hasPlaneMeta() ? 'plane' : 'layered';
    state.spacing = Number(p.spacing) || 1;
    state.showUnused = !!p.showUnused;
    state.showWwn = !!p.showWwn;
    state.query = p.query || '';
    state.isolateQuery = !!p.isolateQuery;
    state.style = ['line', 'shadcn', 'skeuo'].indexOf(p.style) >= 0 ? p.style : 'line';
    state.shell = p.shell === 'shadcn' ? 'shadcn' : 'classic';
    state.theme = p.theme === 'dark' ? 'dark' : 'light';
    state.collapsedPlanes = new Set(p.collapsedPlanes || []);
    state.expandedGroups.clear();
    state.pathMode = false;
    state.pathSel = [];
    state.current = null;
    document.body.classList.toggle('dark', state.theme === 'dark');
    applyShell(state.shell);
    $('#search').value = state.query;
    $('#isolate-search').checked = state.isolateQuery;
    $('#only-up').checked = state.onlyUp;
    $('#hide-isolated').checked = state.hideIsolated;
    $('#show-unused').checked = state.showUnused;
    $('#show-wwn').checked = state.showWwn;
    $('#collapse-hosts').checked = state.collapseHosts;
    $('#auto-bundle').checked = state.autoBundle;
    $('#spacing').value = String(state.spacing);
    $('#scope-select').value = state.scope;
    syncTypeCheckboxes();
    $$('#kind-filters input').forEach(function (cb) { cb.checked = !!state.kinds[cb.value]; });
    $$('#gran button').forEach(function (b) { b.classList.toggle('active', b.dataset.gran === state.gran); });
    $('#gran-hint').textContent = state.gran === 'port'
      ? '展开每台设备的每个网口，连线表示端口之间的实际链路。'
      : '按设备查看结构，多网口聚合为一条链路。';
    syncStyleButtons();
    syncLayoutButtons();
    updatePathUI();
    rebuild();
    toast('已应用视图预设：' + p.name);
  }

  function deletePreset(id) {
    presets = presets.filter(function (p) { return p.id !== id; });
    persistPresets();
    renderPresets();
  }

  function renderPresets() {
    var list = $('#preset-list');
    if (!list) return;
    if (!presets.length) {
      list.innerHTML = '<div class="preset-row"><span class="preset-empty">还没有保存的视图预设</span></div>';
      return;
    }
    list.innerHTML = presets.map(function (p) {
      return '<div class="preset-row" data-preset-id="' + esc(p.id) + '">' +
        '<span class="preset-name" title="' + esc(p.name) + '">' + esc(p.name) + '</span>' +
        '<button type="button" data-preset-apply="' + esc(p.id) + '">应用</button>' +
        '<button type="button" data-preset-delete="' + esc(p.id) + '" aria-label="删除">×</button></div>';
    }).join('');
  }

  function setSideTab(name, focus) {
    if (['filter', 'display', 'info'].indexOf(name) < 0) name = 'filter';
    state.sideTab = name;
    $$('#sidebar [data-side-group]').forEach(function (group) {
      group.hidden = group.getAttribute('data-side-group') !== name;
    });
    $$('#side-tabs [data-side-tab]').forEach(function (btn) {
      var on = btn.getAttribute('data-side-tab') === name;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
      if (on && focus) btn.focus();
    });
    var sidebar = $('#sidebar');
    if (sidebar) sidebar.scrollTop = 0;
  }

  function renderChrome() {
    updateStats();
    renderLayerChips();
    updateScopeCounts();
    renderFilterBar();
    var unusedRow = $('#unused-row');
    if (unusedRow) unusedRow.classList.toggle('hidden', state.gran !== 'port');
    var collapseCb = $('#collapse-hosts');
    var collapseRow = $('#collapse-row');
    if (collapseCb) collapseCb.disabled = state.gran !== 'device';
    if (collapseRow) collapseRow.classList.toggle('disabled', state.gran !== 'device');
    var autoCb = $('#auto-bundle');
    var autoRow = $('#autobundle-row');
    if (autoCb) autoCb.disabled = state.gran !== 'device';
    if (autoRow) autoRow.classList.toggle('disabled', state.gran !== 'device');
    syncLayoutButtons();
  }

  /* ------------------------------------------------------------------ */
  /* 筛选选择器                                                          */
  /* ------------------------------------------------------------------ */

  function pickerDeviceOn(d) {
    var draft = picker.draft;
    if (!draft.types[d.type]) return false;
    if (draft.offDevices.has(d.id)) return false;
    if (d.type === 'switch' && state.hiddenLayers.has(switchLayer(d))) return false;
    return true;
  }

  function deviceTriState(d) {
    var draft = picker.draft;
    if (!draft.types[d.type] || draft.offDevices.has(d.id)) return 'none';
    if (!d.ports.length) return 'all';
    var on = d.ports.filter(function (p) { return !draft.offPorts.has(p.id); }).length;
    if (on === 0) return 'none';
    return on === d.ports.length ? 'all' : 'some';
  }

  function countDraft() {
    var draft = picker.draft;
    var deviceCount = 0, portCount = 0;
    G.devices.forEach(function (d) {
      if (!draft.types[d.type] || draft.offDevices.has(d.id)) return;
      if (d.type === 'switch' && state.hiddenLayers.has(switchLayer(d))) return;
      deviceCount++;
      d.ports.forEach(function (p) {
        if (!draft.offPorts.has(p.id)) portCount++;
      });
    });
    var linkCount = 0;
    allLinks.forEach(function (l) {
      var da = devById.get(l.a.device), db = devById.get(l.b.device);
      if (!da || !db) return;
      if (!draft.types[da.type] || !draft.types[db.type]) return;
      if (draft.offDevices.has(da.id) || draft.offDevices.has(db.id)) return;
      if (da.type === 'switch' && state.hiddenLayers.has(switchLayer(da))) return;
      if (db.type === 'switch' && state.hiddenLayers.has(switchLayer(db))) return;
      if (state.kinds[l.kind] === false) return;
      if (state.onlyUp && l.status === 'down') return;
      if (l.a.port && draft.offPorts.has(l.a.port)) return;
      if (l.b.port && draft.offPorts.has(l.b.port)) return;
      linkCount++;
    });
    return { devices: deviceCount, ports: portCount, links: linkCount };
  }

  function openPicker(tab, expandAll) {
    picker.open = true;
    picker.tab = tab || 'all';
    picker.query = '';
    picker.expanded = new Set();
    picker.expandedHostGroups = new Set();
    if (expandAll) {
      G.devices.forEach(function (d) { if (d.ports.length) picker.expanded.add(d.id); });
    }
    picker.draft = {
      types: { host: state.types.host, switch: state.types.switch, storage: state.types.storage, unknown: state.types.unknown },
      offDevices: new Set(state.offDevices),
      offPorts: new Set(state.offPorts)
    };
    $('#pick-search').value = '';
    $$('#pick-tabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === picker.tab); });
    renderPicker();
    $('#picker').classList.remove('hidden');
    setTimeout(function () { $('#pick-search').focus(); }, 50);
  }

  function closePicker() {
    picker.open = false;
    $('#picker').classList.add('hidden');
  }

  function applyPicker() {
    state.types = {
      host: picker.draft.types.host,
      switch: picker.draft.types.switch,
      storage: picker.draft.types.storage,
      unknown: picker.draft.types.unknown
    };
    state.offDevices = new Set(picker.draft.offDevices);
    state.offPorts = new Set(picker.draft.offPorts);
    state.pinned.clear();
    syncTypeCheckboxes();
    closePicker();
    rebuild();
  }

  function syncTypeCheckboxes() {
    $$('#type-filters input[data-type]').forEach(function (cb) {
      cb.checked = !!state.types[cb.dataset.type];
    });
  }

  function pickerDeviceList(type) {
    var q = picker.query.trim().toLowerCase();
    var list = [];
    G.devices.forEach(function (d) {
      if (d.type !== type) return;
      var devHit = !q || deviceOnlyMatches(d, q);
      var portHits = q ? d.ports.filter(function (p) { return portMatchesQuery(p, q); }) : d.ports;
      if (q && !devHit && !portHits.length) return;
      list.push({ d: d, devHit: devHit, portHits: portHits });
    });
    list.sort(function (a, b) {
      if (type === 'switch') {
        var la = switchLayer(a.d), lb = switchLayer(b.d);
        if (la !== lb) return la - lb;
      }
      return a.d.label.localeCompare(b.d.label, 'zh-Hans-CN');
    });
    return list;
  }

  function pickerResultDevices() {
    var types = picker.tab === 'all' ? ['host', 'switch', 'storage'] : [picker.tab];
    var out = [];
    types.forEach(function (t) {
      pickerDeviceList(t).forEach(function (x) { out.push(x.d); });
    });
    return out;
  }

  function pickerResultAll(on) {
    pickerResultDevices().forEach(function (d) {
      if (on) {
        picker.draft.types[d.type] = true;
        picker.draft.offDevices.delete(d.id);
        d.ports.forEach(function (p) { picker.draft.offPorts.delete(p.id); });
      } else {
        picker.draft.offDevices.add(d.id);
      }
    });
    renderPicker();
  }

  function pickerHostPrimaryMap() {
    var hostSwitches = new Map();
    allLinks.forEach(function (l) {
      var a = devById.get(l.a.device), b = devById.get(l.b.device);
      if (!a || !b) return;
      if (a.type === 'host' && b.type === 'switch') {
        if (!hostSwitches.has(a.id)) hostSwitches.set(a.id, []);
        hostSwitches.get(a.id).push(b);
      } else if (b.type === 'host' && a.type === 'switch') {
        if (!hostSwitches.has(b.id)) hostSwitches.set(b.id, []);
        hostSwitches.get(b.id).push(a);
      }
    });
    var out = new Map();
    hostSwitches.forEach(function (sws, hostId) {
      sws = sws.slice().sort(function (a, b) { return a.label.localeCompare(b.label, 'zh-Hans-CN'); });
      if (sws.length) out.set(hostId, sws[0].id);
    });
    return out;
  }

  function pickerHostGroupsFor(list) {
    var primary = pickerHostPrimaryMap();
    var map = new Map();
    var flat = [];
    list.forEach(function (x) {
      var sw = x.d.type === 'host' ? primary.get(x.d.id) : null;
      if (!sw) { flat.push(x); return; }
      if (!map.has(sw)) map.set(sw, []);
      map.get(sw).push(x);
    });
    var groups = [];
    map.forEach(function (members, swId) {
      if (members.length < 2) {
        members.forEach(function (x) { flat.push(x); });
        return;
      }
      var sw = devById.get(swId);
      groups.push({
        key: 'host:' + swId,
        label: sw ? sw.label : swId,
        members: members
      });
    });
    groups.sort(function (a, b) { return a.label.localeCompare(b.label, 'zh-Hans-CN'); });
    flat.sort(function (a, b) { return a.d.label.localeCompare(b.d.label, 'zh-Hans-CN'); });
    return { groups: groups, flat: flat };
  }

  function pickerRowHtml(x, q, draft) {
    var d = x.d;
    var st = deviceTriState(d);
    var open = picker.expanded.has(d.id) || (q && x.portHits.length && !x.devHit);
    var ports = d.ports;
    var shownPorts = (q && !x.devHit) ? x.portHits : ports;
    if (q && x.devHit) shownPorts = ports;
    var onPorts = ports.filter(function (p) { return !draft.offPorts.has(p.id); }).length;
    var countText = ports.length ? onPorts + '/' + ports.length : '—';
    var meta;
    if (d.type === 'switch') meta = 'L' + switchLayer(d) + ' · ' + d.ports.length + ' 口' + (d.ips && d.ips.length ? ' · ' + d.ips[0] : '');
    else if (d.type === 'storage') meta = storageInfo(d).model + ' · ' + d.ports.length + ' 个网口';
    else meta = d.ports.length + ' 个网口' + (d.ips && d.ips.length ? ' · ' + d.ips[0] : '');
    if (d.type === 'unknown') meta = shortWwn(d.wwn) + ' · config.txt 中无记录';

    var ariaState = st === 'all' ? 'true' : (st === 'some' ? 'mixed' : 'false');
    var html = '<div class="pick-dev' + (st === 'none' ? ' off' : '') + '" data-dev-row="' + esc(d.id) + '">' +
      '<button class="caret' + (open ? ' open' : '') + '" data-caret="' + esc(d.id) + '" aria-label="展开">▶</button>' +
      '<span class="cb ' + st + '" role="checkbox" tabindex="0" aria-checked="' + ariaState + '" data-dev-toggle="' + esc(d.id) + '"></span>' +
      '<span class="dev-ico ' + d.type + '">' + TYPE_ICON[d.type] + '</span>' +
      '<div class="dev-info"><div class="dev-name">' + esc(d.type === 'unknown' ? '未识别设备' : d.label) + '</div>' +
      '<div class="dev-meta">' + esc(meta) + '</div></div>' +
      '<span class="dev-count">' + countText + '</span></div>';

    if (open && shownPorts.length) {
      html += '<div class="pick-ports">' + shownPorts.map(function (p) {
        var pon = !draft.offDevices.has(d.id) && draft.types[d.type] && !draft.offPorts.has(p.id);
        return '<div class="pick-port" role="checkbox" tabindex="0" aria-checked="' + (pon ? 'true' : 'false') + '" data-port-toggle="' + esc(p.id) + '">' +
          '<span class="cb mini ' + (pon ? 'all' : 'none') + '"></span>' +
          '<span class="p-name">' + esc(p.label) + '</span>' +
          '<span class="p-wwn">' + esc(p.wwn || '') + '</span>' +
          '<span class="p-dot' + (p.connected ? ' on' : '') + '" title="' + (p.connected ? '已连接' : '未连接') + '"></span></div>';
      }).join('') + '</div>';
    }
    return html;
  }

  function pickerHostGroupAll(key, on) {
    var swId = key.slice(5);
    var primary = pickerHostPrimaryMap();
    G.devices.forEach(function (d) {
      if (d.type !== 'host' || primary.get(d.id) !== swId) return;
      if (on) {
        picker.draft.types.host = true;
        picker.draft.offDevices.delete(d.id);
        d.ports.forEach(function (p) { picker.draft.offPorts.delete(p.id); });
      } else {
        picker.draft.offDevices.add(d.id);
      }
    });
    renderPicker();
  }

  function pickerGroupHtml(type) {
    var draft = picker.draft;
    var q = picker.query.trim().toLowerCase();
    var list = pickerDeviceList(type);
    if (!list.length) return '';
    var batchAll = q ? '全选结果' : '全选';
    var batchNone = q ? '清空结果' : '清空';

    var onCount = 0;
    list.forEach(function (x) { if (!draft.offDevices.has(x.d.id) && draft.types[type]) onCount++; });
    var html = '<div class="pick-group">';
    html += '<div class="pick-group-head">' + TYPE_LABEL[type] +
      '<span>' + onCount + '/' + list.length + ' 台</span>' +
      (draft.types[type] ? '' : '<span class="off-note">类型已关闭</span>') +
      '<span class="grow"></span>' +
      '<button class="link-btn" data-group-all="' + type + '" title="' + (q ? '选中匹配设备的全部网口' : '选中该类型全部设备') + '">' + batchAll + '</button>' +
      '<span class="sep">·</span>' +
      '<button class="link-btn" data-group-none="' + type + '" title="' + (q ? '隐藏匹配的设备' : '隐藏该类型全部设备') + '">' + batchNone + '</button></div>';

    var grouping = type === 'host' && G.devices.filter(function (d) { return d.type === 'host'; }).length >= 20;
    var grouped = grouping ? pickerHostGroupsFor(list) : null;
    if (grouped && grouped.groups.length) {
      grouped.groups.forEach(function (g) {
        var open = picker.expandedHostGroups.has(g.key) || !!q;
        var on = g.members.filter(function (x) { return !draft.offDevices.has(x.d.id) && draft.types.host; }).length;
        html += '<div class="pick-host-group">' +
          '<div class="pick-host-head" data-host-group="' + esc(g.key) + '">' +
          '<button class="caret' + (open ? ' open' : '') + '" data-host-caret="' + esc(g.key) + '" aria-label="展开主机组">▶</button>' +
          '<span class="host-group-name">按接入交换机 · ' + esc(g.label) + '</span>' +
          '<span class="host-group-count">' + on + '/' + g.members.length + '</span>' +
          '<span class="grow"></span>' +
          '<button class="link-btn" data-host-group-all="' + esc(g.key) + '">全选</button>' +
          '<span class="sep">·</span>' +
          '<button class="link-btn" data-host-group-none="' + esc(g.key) + '">清空</button></div>';
        if (open) {
          html += '<div class="pick-host-members">' + g.members.map(function (x) {
            return pickerRowHtml(x, q, draft);
          }).join('') + '</div>';
        }
        html += '</div>';
      });
    }
    (grouped ? grouped.flat : list).forEach(function (x) {
      html += pickerRowHtml(x, q, draft);
    });

    html += '</div>';
    return html;
  }

  function renderPicker() {
    var q = picker.query.trim().toLowerCase();
    var types = picker.tab === 'all' ? ['host', 'switch', 'storage'] : [picker.tab];
    var html = '';
    types.forEach(function (t) { html += pickerGroupHtml(t); });
    if (!html) html = '<div class="pick-empty">没有匹配的设备或网口</div>';
    var list = $('#pick-list');
    var top = q ? 0 : list.scrollTop;
    list.innerHTML = html;
    list.scrollTop = top;

    var resultDevices = q ? pickerResultDevices() : [];
    var resultBar = $('#pick-result-bar');
    if (q) {
      resultBar.classList.remove('hidden');
      $('#pick-result-count').innerHTML = '搜索结果 <b>' + resultDevices.length + '</b> 台设备';
      var noResult = resultDevices.length === 0;
      $('#pick-result-all').disabled = noResult;
      $('#pick-result-none').disabled = noResult;
    } else {
      resultBar.classList.add('hidden');
    }

    var draft = picker.draft;
    var impact = countDraft();
    var s = { host: { on: 0, total: 0 }, switch: { on: 0, total: 0 }, storage: { on: 0, total: 0 } };
    G.devices.forEach(function (d) {
      if (!s[d.type]) return;
      s[d.type].total++;
      if (draft.types[d.type] && !draft.offDevices.has(d.id)) s[d.type].on++;
    });
    var portTotal = 0, portOn = 0;
    G.devices.forEach(function (d) {
      d.ports.forEach(function (p) {
        portTotal++;
        if (draft.types[d.type] && !draft.offDevices.has(d.id) && !draft.offPorts.has(p.id)) portOn++;
      });
    });

    $('#pick-summary').innerHTML = ['host', 'switch', 'storage'].map(function (t) {
      return '<div class="psum-row"><i class="dot ' + t + '"></i><span>' + TYPE_LABEL[t] + '</span>' +
        (draft.types[t] ? '' : '<span class="off-note">已关闭</span>') +
        '<b>' + s[t].on + '/' + s[t].total + '</b></div>';
    }).join('') +
      '<div class="psum-row"><i class="line unknown"></i><span>网口</span><b>' + portOn + '/' + portTotal + '</b></div>';

    $('#pick-impact').innerHTML = '<b>' + impact.links + ' 条链路</b>' +
      '<div class="sub">' + impact.devices + ' 台设备 · ' + impact.ports + ' 个网口</div>' +
      '<div style="margin-top:6px">应用后画布将只保留这些设备和链路。</div>';
  }

  function togglePickerDevice(d) {
    var draft = picker.draft;
    var st = deviceTriState(d);
    if (st === 'all') {
      draft.offDevices.add(d.id);
    } else {
      draft.offDevices.delete(d.id);
      draft.types[d.type] = true;
      d.ports.forEach(function (p) { draft.offPorts.delete(p.id); });
    }
    renderPicker();
  }

  function togglePickerPort(d, p) {
    var draft = picker.draft;
    var deviceWasOff = !draft.types[d.type] || draft.offDevices.has(d.id);
    var portWasOff = draft.offPorts.has(p.id);
    if (deviceWasOff || portWasOff) {
      draft.types[d.type] = true;
      draft.offDevices.delete(d.id);
      if (deviceWasOff) {
        // 整台设备被隐藏时勾选某个网口：只保留这个网口
        d.ports.forEach(function (other) {
          if (other.id !== p.id) draft.offPorts.add(other.id);
        });
      }
      draft.offPorts.delete(p.id);
    } else {
      draft.offPorts.add(p.id);
    }
    renderPicker();
  }

  function groupAll(type, on) {
    var draft = picker.draft;
    pickerDeviceList(type).forEach(function (x) {
      var d = x.d;
      if (on) {
        draft.offDevices.delete(d.id);
        d.ports.forEach(function (p) { draft.offPorts.delete(p.id); });
        draft.types[type] = true;
      } else {
        draft.offDevices.add(d.id);
      }
    });
    renderPicker();
  }

  function refocusPick(attr, value) {
    requestAnimationFrame(function () {
      var nodes = document.querySelectorAll('[' + attr + ']');
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].getAttribute(attr) === value) {
          try { nodes[i].focus({ preventScroll: true }); } catch (err) { nodes[i].focus(); }
          return;
        }
      }
    });
  }

  function pickerEvent(e) {
    var t = e.target;
    var hga = t.closest('[data-host-group-all]');
    if (hga) { pickerHostGroupAll(hga.getAttribute('data-host-group-all'), true); return; }
    var hgn = t.closest('[data-host-group-none]');
    if (hgn) { pickerHostGroupAll(hgn.getAttribute('data-host-group-none'), false); return; }
    var hgc = t.closest('[data-host-caret]');
    if (hgc) {
      var hk = hgc.getAttribute('data-host-caret');
      if (picker.expandedHostGroups.has(hk)) picker.expandedHostGroups.delete(hk);
      else picker.expandedHostGroups.add(hk);
      renderPicker();
      refocusPick('data-host-caret', hk);
      return;
    }
    var hgh = t.closest('[data-host-group]');
    if (hgh) {
      var hgk = hgh.getAttribute('data-host-group');
      if (picker.expandedHostGroups.has(hgk)) picker.expandedHostGroups.delete(hgk);
      else picker.expandedHostGroups.add(hgk);
      renderPicker();
      refocusPick('data-host-caret', hgk);
      return;
    }
    var caret = t.closest('[data-caret]');
    if (caret) {
      var cid = caret.getAttribute('data-caret');
      if (picker.expanded.has(cid)) picker.expanded.delete(cid);
      else picker.expanded.add(cid);
      renderPicker();
      refocusPick('data-caret', cid);
      return;
    }
    var devToggle = t.closest('[data-dev-toggle]');
    if (devToggle) {
      var did = devToggle.getAttribute('data-dev-toggle');
      togglePickerDevice(devById.get(did));
      refocusPick('data-dev-toggle', did);
      return;
    }
    var portToggle = t.closest('[data-port-toggle]');
    if (portToggle) {
      var pid = portToggle.getAttribute('data-port-toggle');
      var p = portById.get(pid);
      if (p) togglePickerPort(devById.get(p.device), p);
      refocusPick('data-port-toggle', pid);
      return;
    }
    var row = t.closest('[data-dev-row]');
    if (row) {
      var rid = row.getAttribute('data-dev-row');
      if (picker.expanded.has(rid)) picker.expanded.delete(rid);
      else picker.expanded.add(rid);
      renderPicker();
      refocusPick('data-caret', rid);
      return;
    }
    var ga = t.closest('[data-group-all]');
    if (ga) { groupAll(ga.getAttribute('data-group-all'), true); return; }
    var gn = t.closest('[data-group-none]');
    if (gn) { groupAll(gn.getAttribute('data-group-none'), false); return; }
  }

  /* ------------------------------------------------------------------ */
  /* 详情面板                                                            */
  /* ------------------------------------------------------------------ */

  function connectionsFor(deviceId, portId) {
    var out = [];
    state.view.links.forEach(function (l) {
      if (l.a.device === deviceId && (!portId || l.a.port === portId)) out.push({ mine: l.a, other: l.b, link: l });
      else if (l.b.device === deviceId && (!portId || l.b.port === portId)) out.push({ mine: l.b, other: l.a, link: l });
    });
    return out;
  }

  function renderConnections(rows, limit) {
    var groups = new Map();
    rows.forEach(function (r) {
      var key = r.other.device;
      if (!groups.has(key)) groups.set(key, { id: key, ports: [], links: [] });
      groups.get(key).ports.push(portLabel(r.mine.port) + '→' + portLabel(r.other.port));
      groups.get(key).links.push(r.link);
    });
    var arr = Array.from(groups.values()).slice(0, limit || 30);
    if (!arr.length) return '<div class="warn-empty">没有可见链路</div>';
    return arr.map(function (g) {
      var peer = devById.get(g.id);
      if (!peer) return '';
      var pal = palette()[peer.type] || palette().unknown;
      return '<div class="conn" data-goto="' + esc(peer.id) + '">' +
        '<i class="c-dot" style="background:' + pal.accent + '"></i>' +
        '<div class="c-main"><div class="c-name">' + esc(displayName(peer)) + '</div>' +
        '<div class="c-sub">' + TYPE_LABEL[peer.type] + ' · ' + g.links.length + ' 条链路' +
        (peer.type === 'switch' ? ' · L' + switchLayer(peer) : '') + '</div></div>' +
        '<div class="c-ports">' + esc(g.ports.slice(0, 2).join(', ')) + (g.ports.length > 2 ? '…' : '') + '</div>' +
        '</div>';
    }).join('');
  }

  function showHostGroupDetail(d) {
    var members = (d._groupHosts || []).map(function (id) { return devById.get(id); }).filter(Boolean);
    var switchDev = devById.get(d._groupSwitch);
    var switchLabel = switchDev ? switchDev.label : (d._groupSwitchLabel || '—');
    var ports = members.reduce(function (n, m) { return n + (m.ports ? m.ports.length : 0); }, 0);

    var rows = [];
    rows.push('<div class="kv">');
    rows.push('<dt>类型</dt><dd>主机组</dd>');
    if (d._planeLabel) rows.push('<dt>网络平面</dt><dd>' + esc(d._planeLabel) + '</dd>');
    rows.push('<dt>健康</dt><dd><span class="status-dot ' + (d._health || 'unknown') + '"></span>' + (HEALTH_LABEL[d._health] || '未知') + '</dd>');
    rows.push('<dt>接入交换机</dt><dd>' + esc(switchLabel) + '</dd>');
    rows.push('<dt>主机数量</dt><dd>' + members.length + ' 台</dd>');
    rows.push('<dt>端口数量</dt><dd>' + ports + ' 个</dd>');
    rows.push('</div>');
    rows.push('<div class="h-section"><span>成员</span><span>' + members.length + '</span></div>');
    rows.push('<div class="port-list">' + members.slice(0, 80).map(function (m) {
      var ip = (m.ips && m.ips.length) ? m.ips[0] : '';
      return '<div class="port-row">' +
        '<span class="p-name">' + esc(m.label) + '</span>' +
        '<span class="p-wwn wwn">' + esc(ip) + '</span>' +
        '<span class="p-state on"></span></div>';
    }).join('') + '</div>');
    if (members.length > 80) {
      rows.push('<div class="warn-empty" style="margin-top:6px">还有 ' + (members.length - 80) + ' 台未展示</div>');
    }
    var actions = '<div class="detail-actions">' +
      '<button class="btn primary" data-action="expand-group" data-group="' + esc(d.id) + '">仅展开此组</button>' +
      '<button class="btn" data-action="expand-hosts">展开全部主机</button>' +
      '</div>';

    var head = '<div class="detail-head">' +
      '<div class="detail-icon" style="color:var(--host);background:var(--accent-soft)">' + TYPE_ICON.host + '</div>' +
      '<div class="detail-title"><h3>主机组</h3>' +
      '<p>' + members.length + ' 台主机 · 接入 ' + esc(switchLabel) + '</p></div>' +
      '<button class="close-btn" data-action="close" title="关闭">×</button>' +
      '</div>';

    var detail = $('#detail');
    detail.innerHTML = head + '<div class="detail-body">' + rows.join('') + actions + '</div>';
    detail.classList.remove('hidden');
  }

  function matrixRowsFor(d) {
    var rows = [];
    d.ports.slice().sort(function (a, b) {
      var na = parseInt(String(a.label).replace(/\D/g, ''), 10) || 0;
      var nb = parseInt(String(b.label).replace(/\D/g, ''), 10) || 0;
      return (na - nb) || String(a.label).localeCompare(String(b.label));
    }).forEach(function (p) {
      var links = allLinks.filter(function (l) { return l.a.port === p.id || l.b.port === p.id; });
      if (!links.length) {
        rows.push({ p: p, peerDev: null, peerPort: null, kind: null, status: null });
        return;
      }
      links.forEach(function (l) {
        var peer = l.a.port === p.id ? l.b : l.a;
        rows.push({
          p: p,
          peerDev: devById.get(peer.device) || null,
          peerPort: peer.port ? portById.get(peer.port) : null,
          kind: l.kind,
          status: l.status
        });
      });
    });
    return rows;
  }

  function renderMatrix() {
    var d = matrix.device;
    if (!d) return;
    var q = matrix.query.trim().toLowerCase();
    var rows = matrixRowsFor(d);
    matrix.rows = rows.filter(function (r) {
      if (matrix.onlyUsed && !r.p.connected) return false;
      if (!q) return true;
      return String(r.p.label || '').toLowerCase().indexOf(q) >= 0 ||
        String(r.p.wwn || '').toLowerCase().indexOf(q) >= 0 ||
        (r.peerDev && String(r.peerDev.label).toLowerCase().indexOf(q) >= 0) ||
        (r.peerPort && String(r.peerPort.label).toLowerCase().indexOf(q) >= 0);
    });
    var html = matrix.rows.map(function (r) {
      var p = r.p;
      var down = r.status && linkHealth({ status: r.status }) === 'down';
      var stateText = down ? '异常' : (p.connected ? '已连接' : (p.unused ? '未使用' : '未连接'));
      var dotClass = down ? 'bad' : (p.connected ? 'on' : (p.unused ? 'unused' : 'off'));
      var peer = r.peerDev ? esc(r.peerDev.label) : '—';
      var peerPort = r.peerPort ? esc(r.peerPort.label) : '—';
      var kind = r.kind ? esc(KIND_LABEL[r.kind] || r.kind) : '—';
      var linkStatus = r.status ? esc(r.status) : '—';
      return '<tr>' +
        '<td class="m-port">' + esc(p.label) + '</td>' +
        '<td class="m-wwn">' + esc(p.wwn || '') + '</td>' +
        '<td><span class="matrix-dot ' + dotClass + '"></span>' + stateText + '</td>' +
        '<td class="m-peer">' + peer + '</td>' +
        '<td>' + peerPort + '</td>' +
        '<td>' + kind + '</td>' +
        '<td>' + linkStatus + '</td>' +
        '</tr>';
    }).join('');
    if (!html) html = '<tr><td colspan="7" class="m-empty">没有匹配的端口</td></tr>';
    $('#matrix-body').innerHTML = html;
    $('#matrix-count').textContent = matrix.rows.length + ' 行';
  }

  function populateRedFail() {
    var sel = $('#red-fail');
    if (!sel) return;
    var switches = Array.from(state.view.devices).map(function (id) { return devById.get(id); })
      .filter(function (d) { return d && d.type === 'switch'; })
      .sort(function (a, b) { return a.label.localeCompare(b.label, 'zh-Hans-CN'); });
    sel.innerHTML = '<option value="">模拟故障：无</option>' + switches.map(function (d) {
      return '<option value="' + esc(d.id) + '">移除 ' + esc(d.label) + '</option>';
    }).join('');
    sel.disabled = !switches.length;
    sel.value = '';
  }

  function openRedundancy() {
    closeSummary(false);
    redundancy.query = '';
    redundancy.base = null;
    redundancy.exclude = null;
    $('#red-search').value = '';
    $('#red-title').textContent = '冗余分析';
    $('#red-sub').textContent = '正在计算…';
    $('#red-head').innerHTML = '';
    $('#red-body').innerHTML = '<tr><td colspan="2" class="red-empty">正在计算主机到存储的独立路径…</td></tr>';
    $('#red-summary').textContent = '';
    $('#red-count').textContent = '';
    $('#red-impact').classList.add('hidden');
    $('#red-detail').classList.add('hidden');
    populateRedFail();
    $('#redundancy').classList.remove('hidden');
    setTimeout(function () { computeRedundancy(null); }, 30);
  }

  function computeRedundancy(excludeId) {
    excludeId = excludeId || null;
    redundancy.exclude = excludeId;
    var devices = Array.from(state.view.devices).map(function (id) { return devById.get(id); })
      .filter(function (d) { return d && d.id !== excludeId; });
    var hosts = devices.filter(function (d) { return d.type === 'host'; })
      .sort(function (a, b) { return a.label.localeCompare(b.label, 'zh-Hans-CN'); });
    var storages = devices.filter(function (d) { return d.type === 'storage'; })
      .sort(function (a, b) { return a.label.localeCompare(b.label, 'zh-Hans-CN'); });
    var all = devices.filter(function (d) {
      return d.type === 'host' || d.type === 'switch' || d.type === 'storage';
    });
    if (!hosts.length || !storages.length) {
      redundancy.data = { hosts: hosts, storages: storages, paths: [], p2: 0, p1: 0, p0: 0 };
      $('#red-sub').textContent = '当前视图没有主机或存储';
      $('#red-summary').textContent = '';
      $('#red-count').textContent = '';
      $('#red-body').innerHTML = '<tr><td class="red-empty" colspan="2">当前视图缺少主机或存储，无法做冗余分析。</td></tr>';
      return;
    }

    var idx = new Map();
    all.forEach(function (d, i) { idx.set(d.id, i); });
    var n = all.length;
    var nodeCount = n * 2;
    var adj = [];
    for (var i = 0; i < nodeCount; i++) adj.push([]);
    var to = [], rev = [], cap = [];
    function addEdge(u, v, c) {
      var e = to.length;
      to.push(v); cap.push(c); rev.push(e + 1); adj[u].push(e);
      to.push(u); cap.push(0); rev.push(e); adj[v].push(e + 1);
    }
    all.forEach(function (d, i) {
      // 节点容量：交换机 1，主机/存储 2；节点分裂后限制经过同一台交换机的路径数
      addEdge(i * 2, i * 2 + 1, d.type === 'switch' ? 1 : 2);
    });
    state.view.links.forEach(function (l) {
      if (l.a.device === l.b.device) return;
      if (!idx.has(l.a.device) || !idx.has(l.b.device)) return;
      if (excludeId && (l.a.device === excludeId || l.b.device === excludeId)) return;
      if (linkHealth(l) === 'down') return;
      var ia = idx.get(l.a.device), ib = idx.get(l.b.device);
      addEdge(ia * 2 + 1, ib * 2, 1);
      addEdge(ib * 2 + 1, ia * 2, 1);
    });
    var baseCap = cap.slice();

    function maxTwo(src, sink) {
      var flow = 0;
      var work = baseCap.slice();
      while (flow < 2) {
        var prevNode = new Array(nodeCount).fill(-1);
        var prevEdge = new Array(nodeCount).fill(-1);
        var queue = [src];
        prevNode[src] = src;
        for (var qi = 0; qi < queue.length && prevNode[sink] === -1; qi++) {
          var u = queue[qi];
          var edges = adj[u];
          for (var ei = 0; ei < edges.length; ei++) {
            var e = edges[ei];
            var v = to[e];
            if (work[e] > 0 && prevNode[v] === -1) {
              prevNode[v] = u;
              prevEdge[v] = e;
              queue.push(v);
              if (v === sink) break;
            }
          }
        }
        if (prevNode[sink] === -1) break;
        var add = 2 - flow;
        for (var v = sink; v !== src; v = prevNode[v]) {
          add = Math.min(add, work[prevEdge[v]]);
        }
        for (var v2 = sink; v2 !== src; v2 = prevNode[v2]) {
          var e2 = prevEdge[v2];
          work[e2] -= add;
          work[e2 ^ 1] += add;
        }
        flow += add;
      }
      return flow;
    }

    var hIdx = hosts.map(function (d) { return idx.get(d.id); });
    var sIdx = storages.map(function (d) { return idx.get(d.id); });
    var paths = [];
    var p2 = 0, p1 = 0, p0 = 0;
    hosts.forEach(function (h, hi) {
      var row = [];
      sIdx.forEach(function (si) {
        var count = maxTwo(hIdx[hi] * 2, si * 2);
        row.push(count);
        if (count >= 2) p2++;
        else if (count === 1) p1++;
        else p0++;
      });
      paths.push(row);
    });
    redundancy.data = { hosts: hosts, storages: storages, paths: paths, p2: p2, p1: p1, p0: p0 };
    if (!excludeId) redundancy.base = redundancy.data;
    var failDev = excludeId ? devById.get(excludeId) : null;
    $('#red-sub').textContent = hosts.length + ' 台主机 × ' + storages.length + ' 套存储（SAN/NAS）' +
      (failDev ? ' · 已模拟移除 ' + failDev.label : '');
    $('#red-summary').innerHTML = '双路径 <b>' + p2 + '</b> 对 · 单路径 <b>' + p1 + '</b> 对 · 无路径 <b>' + p0 + '</b> 对';
    var impact = $('#red-impact');
    if (impact) {
      if (excludeId && redundancy.base) {
        var base = redundancy.base;
        var reduced = 0, lost = 0;
        for (var hi = 0; hi < paths.length; hi++) {
          for (var si = 0; si < paths[hi].length; si++) {
            if (paths[hi][si] < base.paths[hi][si]) reduced++;
            if (base.paths[hi][si] > 0 && paths[hi][si] === 0) lost++;
          }
        }
        impact.innerHTML = '模拟移除 <b>' + esc(failDev ? failDev.label : excludeId) + '</b>：' +
          '<b>' + reduced + '</b> 对路径减少，<b>' + lost + '</b> 对中断';
        impact.classList.remove('hidden');
      } else {
        impact.classList.add('hidden');
      }
    }
    $('#red-detail').classList.add('hidden');
    renderRedundancy();
  }

  function renderRedundancy() {
    var data = redundancy.data;
    if (!data) return;
    var q = redundancy.query.trim().toLowerCase();
    var rows = [];
    data.hosts.forEach(function (h, hi) {
      if (q && String(h.label).toLowerCase().indexOf(q) < 0 &&
          !(h.ips || []).some(function (ip) { return String(ip).toLowerCase().indexOf(q) >= 0; })) return;
      rows.push({ h: h, hi: hi });
    });
    var head = '<tr><th class="red-host-head">主机 / 存储</th>' +
      data.storages.map(function (s) { return '<th title="' + esc(s.label) + '">' + esc(s.label) + '</th>'; }).join('') + '</tr>';
    $('#red-head').innerHTML = head;
    var html = rows.map(function (row) {
      var h = row.h, hi = row.hi;
      var cells = data.paths[hi].map(function (count, si) {
        var cls = count >= 2 ? 'p2' : (count === 1 ? 'p1' : 'p0');
        var label = count >= 2 ? '2' : (count === 1 ? '1' : '—');
        return '<td class="red-cell ' + cls + '" data-red-cell="1" data-hi="' + hi + '" data-si="' + si + '" title="' + esc(h.label + ' → ' + data.storages[si].label + '：' + count + ' 条节点不交路径；点击查看路径') + '">' + label + '</td>';
      }).join('');
      var ip = h.ips && h.ips.length ? '<small>' + esc(h.ips[0]) + '</small>' : '';
      return '<tr><td class="red-host" title="' + esc(h.label) + '">' + esc(h.label) + ip + '</td>' + cells + '</tr>';
    }).join('');
    if (!html) html = '<tr><td class="red-empty" colspan="' + (data.storages.length + 1) + '">没有匹配的主机</td></tr>';
    $('#red-body').innerHTML = html;
    $('#red-count').textContent = rows.length + ' / ' + data.hosts.length + ' 台主机 · ' + data.storages.length + ' 套存储';
  }

  function redundancyPaths(host, storage, excludeId) {
    var adj = new Map();
    state.view.links.forEach(function (l) {
      if (excludeId && (l.a.device === excludeId || l.b.device === excludeId)) return;
      if (linkHealth(l) === 'down') return;
      if (!adj.has(l.a.device)) adj.set(l.a.device, []);
      if (!adj.has(l.b.device)) adj.set(l.b.device, []);
      adj.get(l.a.device).push(l.b.device);
      adj.get(l.b.device).push(l.a.device);
    });
    function bfs(avoid) {
      var prev = new Map([[host.id, null]]);
      var queue = [host.id];
      for (var qi = 0; qi < queue.length; qi++) {
        var cur = queue[qi];
        if (cur === storage.id) break;
        var nbrs = adj.get(cur) || [];
        for (var i = 0; i < nbrs.length; i++) {
          var nb = nbrs[i];
          if (prev.has(nb)) continue;
          if (avoid.has(nb)) continue;
          prev.set(nb, cur);
          queue.push(nb);
        }
      }
      if (!prev.has(storage.id)) return null;
      var out = [];
      var cur2 = storage.id;
      while (cur2 != null) { out.unshift(cur2); cur2 = prev.get(cur2); }
      return out;
    }
    var p1 = bfs(new Set());
    if (!p1) return [];
    var used = new Set();
    p1.forEach(function (id) {
      var d = devById.get(id);
      if (d && d.type === 'switch') used.add(id);
    });
    var p2 = bfs(used);
    var out = [p1];
    if (p2) out.push(p2);
    return out;
  }

  function renderRedDetail(hi, si) {
    var data = redundancy.data;
    if (!data || !data.hosts[hi] || !data.storages[si]) return;
    var host = data.hosts[hi], storage = data.storages[si];
    var paths = redundancyPaths(host, storage, redundancy.exclude);
    var box = $('#red-detail');
    var rows = paths.map(function (path, i) {
      return '<div class="red-path"><span>路径 ' + (i + 1) + '：</span>' +
        path.map(function (id) {
          var d = devById.get(id);
          return '<span class="rp-node">' + esc(d ? d.label : id) + '</span>';
        }).join('<span class="rp-arrow">→</span>') + '</div>';
    }).join('');
    if (!paths.length) rows = '<div class="red-path"><span class="rp-no">无可用路径</span></div>';
    box.innerHTML = '<div class="red-detail-head">' +
      '<b>' + esc(host.label) + ' → ' + esc(storage.label) + '</b>' +
      '<span>' + paths.length + ' 条节点不交路径</span>' +
      '<button class="close-btn" data-red-detail-close="1" aria-label="关闭路径详情">×</button></div>' + rows;
    box.classList.remove('hidden');
  }

  function closeRedundancy() {
    $('#redundancy').classList.add('hidden');
  }

  function exportRedundancyCsv() {
    var data = redundancy.data;
    if (!data) return;
    var q = redundancy.query.trim().toLowerCase();
    var header = ['主机', 'IP'].concat(data.storages.map(function (s) { return s.label; }));
    var rows = [];
    data.hosts.forEach(function (h, hi) {
      if (q && String(h.label).toLowerCase().indexOf(q) < 0 && !(h.ips || []).some(function (ip) { return String(ip).toLowerCase().indexOf(q) >= 0; })) return;
      rows.push([h.label, (h.ips || []).join('; ')].concat(data.paths[hi].map(function (n) { return n; })));
    });
    downloadCsv('redundancy-' + new Date().toISOString().slice(0, 10) + '.csv', header, rows);
  }

  function openPortMatrix(d) {
    if (!d) return;
    matrix.device = d;
    matrix.query = '';
    matrix.onlyUsed = false;
    $('#matrix-search').value = '';
    $('#matrix-only-used').checked = false;
    $('#matrix-title').textContent = d.label + ' · 端口矩阵';
    $('#matrix-sub').textContent = TYPE_LABEL[d.type] + ' · ' + d.ports.length + ' 个端口';
    renderMatrix();
    $('#matrix').classList.remove('hidden');
    setTimeout(function () { $('#matrix-search').focus(); }, 50);
  }

  function closePortMatrix() {
    $('#matrix').classList.add('hidden');
    matrix.device = null;
  }

  function exportMatrixCsv() {
    if (!matrix.device) return;
    var header = ['端口', 'WWN', '状态', '对端设备', '对端端口', '链路', '链路状态'];
    var lines = [header.map(csvCell).join(',')];
    matrix.rows.forEach(function (r) {
      lines.push([
        r.p.label,
        r.p.wwn || '',
        r.p.connected ? '已连接' : (r.p.unused ? '未使用' : '未连接'),
        r.peerDev ? r.peerDev.label : '',
        r.peerPort ? r.peerPort.label : '',
        r.kind ? (KIND_LABEL[r.kind] || r.kind) : '',
        r.status || ''
      ].map(csvCell).join(','));
    });
    var blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = safeDownloadName('port-matrix-' + matrix.device.label + '-' + new Date().toISOString().slice(0, 10) + '.csv');
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast('已导出 CSV');
  }

  function showDetail(nodeId) {
    var node = state.nodeById.get(nodeId);
    if (!node) return;
    var d = devById.get(node._device);
    if (!d) return;
    if (d._group) { showHostGroupDetail(d); return; }
    var isPort = node._kind === 'port';
    var port = isPort ? portById.get(node._port) : null;
    var pal = palette()[d.type] || palette().unknown;
    var rows = [];

    rows.push('<div class="kv">');
    rows.push('<dt>类型</dt><dd>' + TYPE_LABEL[d.type] +
      (d.type === 'switch' ? ' · 第 ' + switchLayer(d) + ' 层' : '') + '</dd>');
    var dh = deviceHealth(d);
    rows.push('<dt>健康</dt><dd><span class="status-dot ' + dh + '"></span>' + (HEALTH_LABEL[dh] || '未知') + '</dd>');
    if (node._plane) rows.push('<dt>网络平面</dt><dd>' + esc(node._plane) + '</dd>');
    if (isPort) {
      rows.push('<dt>所属设备</dt><dd>' + esc(d.label) + '</dd>');
      rows.push('<dt>端口</dt><dd>' + esc(port.label) + '</dd>');
      if (port.wwn) rows.push('<dt>WWN</dt><dd class="wwn">' + esc(port.wwn) + '</dd>');
      rows.push('<dt>状态</dt><dd>' + (state.offPorts.has(port.id) ? '已被筛选' : (port.connected ? '已连接' : (port.unused ? '未使用' : '未连接'))) + '</dd>');
    } else {
      if (d.wwn) rows.push('<dt>WWN</dt><dd class="wwn">' + esc(d.wwn) + '</dd>');
      (d.ips || []).forEach(function (ip) { rows.push('<dt>IP</dt><dd class="wwn">' + esc(ip) + '</dd>'); });
      if (d.meta && d.meta.vendor) rows.push('<dt>厂商</dt><dd>' + esc(d.meta.vendor) + '</dd>');
      if (d.meta && d.meta.model) rows.push('<dt>型号</dt><dd>' + esc(d.meta.model) + '</dd>');
      rows.push('<dt>端口</dt><dd>' + d.ports.length + ' 个（已连接 ' +
        d.ports.filter(function (p) { return p.connected; }).length + '）</dd>');
    }
    rows.push('</div>');

    if (d.type === 'unknown') {
      rows.push('<div class="unknown-note">该 WWN 不在 config.txt 中，可能是未纳管设备、其他厂商设备，或 config.txt 缺少该网口记录。</div>');
    }

    if (isPort) {
      var conns = connectionsFor(d.id, port.id);
      rows.push('<div class="h-section"><span>链路</span><span>' + conns.length + '</span></div>');
      rows.push(renderConnections(conns, 20));
    } else {
      var visiblePorts = d.ports.filter(function (p) { return !state.offPorts.has(p.id) && (p.connected || state.showUnused); });
      visiblePorts.sort(function (a, b) {
        if (a.connected !== b.connected) return a.connected ? -1 : 1;
        var na = parseInt(String(a.label).replace(/\D/g, ''), 10) || 0;
        var nb = parseInt(String(b.label).replace(/\D/g, ''), 10) || 0;
        return (na - nb) || String(a.label).localeCompare(String(b.label));
      });
      if (visiblePorts.length) {
        rows.push('<div class="h-section"><span>端口</span><span>' + visiblePorts.length + '</span></div>');
        rows.push('<div class="port-list">' + visiblePorts.slice(0, 40).map(function (p) {
          var on = p.connected;
          return '<div class="port-row">' +
            '<span class="p-name">' + esc(p.label) + '</span>' +
            '<span class="p-wwn wwn">' + esc(p.wwn || '') + '</span>' +
            '<span class="p-state' + (on ? ' on' : '') + '" title="' + (on ? '已连接' : '未连接') + '"></span>' +
            '</div>';
        }).join('') + '</div>');
        if (visiblePorts.length > 40) rows.push('<div class="warn-empty" style="margin-top:6px">还有 ' + (visiblePorts.length - 40) + ' 个端口未展示</div>');
      }
      var conns2 = connectionsFor(d.id, null);
      rows.push('<div class="h-section"><span>相邻设备</span><span>' + new Set(conns2.map(function (c) { return c.other.device; })).size + '</span></div>');
      rows.push(renderConnections(conns2, 24));
    }

    var wwnForCopy = isPort ? (port.wwn || '') : (d.wwn || '');
    var actions = '<div class="detail-actions">';
    if (!isPort) actions += '<button class="btn" data-action="focus">聚焦邻居</button>';
    if (!isPort) actions += '<button class="btn" data-action="matrix">端口矩阵</button>';
    if (wwnForCopy) actions += '<button class="btn" data-action="copy" data-wwn="' + esc(wwnForCopy) + '">复制 WWN</button>';
    actions += '<button class="btn" data-action="filter">只显示此设备</button>';
    actions += '<button class="btn" data-action="path">路径分析</button>';
    actions += '</div>';

    var head = '<div class="detail-head">' +
      '<div class="detail-icon" style="color:' + pal.accent + ';background:' + pal.badge + '">' + TYPE_ICON[d.type] + '</div>' +
      '<div class="detail-title"><h3>' + esc(isPort ? port.label + ' · ' + d.label : displayName(d)) + '</h3>' +
      '<p>' + (isPort ? (port.connected ? '端口已连接' : '端口未连接') :
        (d.type === 'storage' ? esc(storageVendorLabel(d)) + ' ' + esc(storageInfo(d).model) + ' · ' + d.ports.length + ' 个端口'
          : TYPE_LABEL[d.type] + ' · ' + d.ports.length + ' 个端口')) + '</p></div>' +
      '<button class="close-btn" data-action="close" title="关闭">×</button>' +
      '</div>';

    var detail = $('#detail');
    detail.innerHTML = head + '<div class="detail-body">' + rows.join('') + actions + '</div>';
    detail.classList.remove('hidden');
  }

  function hideDetail() {
    $('#detail').classList.add('hidden');
  }

  /* ------------------------------------------------------------------ */
  /* 选择 / 聚焦 / 路径                                                   */
  /* ------------------------------------------------------------------ */

  function selectNode(id, opts) {
    opts = opts || {};
    var node = state.nodeById.get(id);
    if (!node) { toast('该设备已被当前筛选隐藏'); return; }
    state.current = id;
    var focus = new Set([id]);
    state.view.edges.forEach(function (e) {
      if (e.from === id) focus.add(e.to);
      else if (e.to === id) focus.add(e.from);
    });
    if (state.gran === 'port') {
      if (node._kind === 'device') {
        state.nodes.forEach(function (n) { if (n._device === id && n.id !== id) focus.add(n.id); });
      } else if (node._kind === 'port') {
        focus.add(node._device);
      }
      state.view.edges.forEach(function (e) {
        if (focus.has(e.from)) focus.add(e.to);
        else if (focus.has(e.to)) focus.add(e.from);
      });
    }
    state.focus = focus;
    state.focusCenter = id;
    state.pathNodes = null;
    state.pathPairs = null;
    applyStyles();
    if (opts.detail === false) hideDetail();
    else showDetail(id);
    if (opts.center && network) {
      network.focus(id, { scale: Math.max(network.getScale(), 0.55), animation: { duration: 300 } });
    }
  }

  function clearSelection() {
    state.focus = null;
    state.focusCenter = null;
    state.current = null;
    state.pathNodes = null;
    state.pathPairs = null;
    if (network) network.unselectAll();
    applyStyles();
    hideDetail();
    if (state.pathMode) {
      state.pathSel = [];
      updatePathUI();
    }
  }

  function findPath(start, end) {
    var adj = new Map();
    state.view.links.forEach(function (l) {
      if (!adj.has(l.a.device)) adj.set(l.a.device, []);
      if (!adj.has(l.b.device)) adj.set(l.b.device, []);
      adj.get(l.a.device).push(l.b.device);
      adj.get(l.b.device).push(l.a.device);
    });
    var prev = new Map();
    prev.set(start, null);
    var q = [start];
    var head = 0;
    while (head < q.length) {
      var cur = q[head++];
      if (cur === end) break;
      var nbrs = adj.get(cur) || [];
      for (var i = 0; i < nbrs.length; i++) {
        if (!prev.has(nbrs[i])) { prev.set(nbrs[i], cur); q.push(nbrs[i]); }
      }
    }
    if (!prev.has(end)) return null;
    var path = [];
    var cur2 = end;
    while (cur2) { path.unshift(cur2); cur2 = prev.get(cur2); }
    return path;
  }

  function applyPath(path) {
    var devices = new Set(path);
    var nodeIds = new Set();
    state.nodes.forEach(function (n) { if (devices.has(n._device)) nodeIds.add(n.id); });
    var pairs = new Set();
    for (var i = 0; i < path.length - 1; i++) {
      pairs.add(path[i] < path[i + 1] ? path[i] + '|' + path[i + 1] : path[i + 1] + '|' + path[i]);
    }
    state.pathNodes = nodeIds;
    state.pathPairs = pairs;
    state.focus = null;
    state.focusCenter = null;
    applyStyles();
  }

  function updatePathUI() {
    var btn = $('#btn-path');
    var hint = $('#path-hint');
    if (btn) btn.classList.toggle('active', state.pathMode);
    if (!state.pathMode) { hint.classList.add('hidden'); hint.innerHTML = ''; return; }
    hint.classList.remove('hidden');
    if (!state.pathSel.length) {
      hint.innerHTML = '<span>路径分析：依次点击两台设备，高亮最短路径</span><span class="ph-close" data-clear="1">✕</span>';
    } else if (state.pathSel.length === 1) {
      var d1 = devById.get(state.pathSel[0]);
      hint.innerHTML = '<span>起点 <b>' + esc(d1 ? d1.label : '') + '</b>，请点击终点设备</span><span class="ph-close" data-clear="1">✕</span>';
    }
  }

  function showPathResult(path) {
    var names = path.map(function (id) {
      var d = devById.get(id);
      return '<span class="hop">' + esc(d ? d.label : id) + '</span>';
    });
    $('#path-hint').classList.remove('hidden');
    $('#path-hint').innerHTML = names.join('<span class="arrow">→</span>') +
      '<span style="opacity:.65;margin-left:8px">' + (path.length - 1) + ' 跳</span>' +
      '<span class="ph-close" data-clear="1">✕</span>';
  }

  function handlePathClick(deviceId) {
    if (!state.pathMode) return;
    if (state.pathSel.length === 0) {
      state.pathSel = [deviceId];
      selectNode(deviceId, { detail: false });
      updatePathUI();
      return;
    }
    if (state.pathSel.length === 1) {
      if (state.pathSel[0] === deviceId) return;
      var path = findPath(state.pathSel[0], deviceId);
      if (!path) {
        toast('这两台设备之间没有可见路径');
        state.pathSel = [];
        state.pathNodes = null;
        state.pathPairs = null;
        applyStyles();
        updatePathUI();
        return;
      }
      state.pathSel = [state.pathSel[0], deviceId];
      applyPath(path);
      showPathResult(path);
      hideDetail();
      state.current = null;
      return;
    }
    state.pathSel = [deviceId];
    state.pathNodes = null;
    state.pathPairs = null;
    applyStyles();
    selectNode(deviceId, { detail: false });
    updatePathUI();
  }

  function togglePathMode() {
    state.pathMode = !state.pathMode;
    state.pathSel = [];
    state.pathNodes = null;
    state.pathPairs = null;
    if (!state.pathMode) { applyStyles(); hideDetail(); }
    else toast('路径分析：依次点击两台设备');
    updatePathUI();
  }

  /* ------------------------------------------------------------------ */
  /* 事件                                                                */
  /* ------------------------------------------------------------------ */

  function onNetworkClick(params) {
    if (params.nodes.length) {
      var id = params.nodes[0];
      var deviceId = nodeDeviceId(id);
      if (state.pathMode) { handlePathClick(deviceId); return; }
      selectNode(id);
    } else {
      clearSelection();
    }
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function resetFilters() {
    state.types = { host: true, switch: true, storage: true, unknown: true };
    state.kinds = { host: true, switch: true, storage: true, unknown: true, other: true };
    state.offDevices.clear();
    state.offPorts.clear();
    state.hiddenLayers.clear();
    state.pinned.clear();
    state.onlyUp = false;
    state.collapseHosts = false;
    state.autoBundle = true;
    state.expandedGroups.clear();
    state.collapsedPlanes.clear();
    state.scope = 'all';
    state.isolateQuery = false;
    state.query = '';
    $('#search').value = '';
    $('#isolate-search').checked = false;
    $('#only-up').checked = false;
    var collapseCb = $('#collapse-hosts');
    if (collapseCb) collapseCb.checked = false;
    if ($('#auto-bundle')) $('#auto-bundle').checked = true;
    var scopeSel = $('#scope-select');
    if (scopeSel) scopeSel.value = 'all';
    syncTypeCheckboxes();
    $$('#kind-filters input').forEach(function (cb) { cb.checked = true; });
    rebuild();
  }

  function bindUI() {
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#summary-menu')) closeSummary(false);
      if (!e.target.closest('#style-menu')) closeStyleMenu(false);
      if (!e.target.closest('#export-menu')) closeExportMenu(false);
      var sh = e.target.closest('[data-shell]');
      if (sh) { setShell(sh.getAttribute('data-shell')); return; }
      var sc = e.target.closest('[data-export-scale]');
      if (sc) {
        exportScale = Number(sc.getAttribute('data-export-scale')) || 1;
        $$('#export-popover [data-export-scale]').forEach(function (b) {
          b.classList.toggle('active', Number(b.getAttribute('data-export-scale')) === exportScale);
        });
        return;
      }
      var inv = e.target.closest('[data-inventory]');
      if (inv) {
        exportInventory(inv.getAttribute('data-inventory'));
        closeExportMenu(true);
        return;
      }
      var ex = e.target.closest('[data-export]');
      if (ex) {
        exportImage(ex.getAttribute('data-export'));
        closeExportMenu(true);
        return;
      }
      var b = e.target.closest('[data-style]');
      if (b) setStyle(b.getAttribute('data-style'), !!b.closest('#style-popover'));
    });

    var styleTrigger = $('#style-trigger');
    if (styleTrigger) {
      styleTrigger.addEventListener('click', function (e) {
        e.stopPropagation();
        var pop = $('#style-popover');
        if (pop && pop.hidden) openStyleMenu();
        else closeStyleMenu(true);
      });
      styleTrigger.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openStyleMenu();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeStyleMenu(true);
        }
      });
    }
    var stylePopover = $('#style-popover');
    if (stylePopover) {
      stylePopover.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); moveStyleFocus(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); moveStyleFocus(-1); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeStyleMenu(true); }
        else if (e.key === 'Tab') { closeStyleMenu(true); }
      });
    }

    $('#type-filters').addEventListener('change', function (e) {
      var cb = e.target.closest('input[data-type]');
      if (!cb) return;
      state.types[cb.dataset.type] = cb.checked;
      rebuild();
    });

    $('#kind-filters').addEventListener('change', function (e) {
      var cb = e.target.closest('input[data-kind]');
      if (!cb) return;
      state.kinds[cb.dataset.kind] = cb.checked;
      rebuild();
    });

    $('#layer-chips').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-layer]');
      if (!btn) return;
      var l = btn.dataset.layer;
      if (l === 'all') state.hiddenLayers.clear();
      else {
        var n = parseInt(l, 10);
        if (state.hiddenLayers.has(n)) state.hiddenLayers.delete(n);
        else state.hiddenLayers.add(n);
      }
      rebuild();
    });

    $$('.scope-tile').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var scope = btn.dataset.scope;
        if (scope === 'port') openPicker('all', true);
        else openPicker(scope, false);
      });
    });
    $('#open-picker').addEventListener('click', function () { openPicker('all', false); });

    $('#gran').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-gran]');
      if (!btn || btn.dataset.gran === state.gran) return;
      state.gran = btn.dataset.gran;
      $$('#gran button').forEach(function (b) { b.classList.toggle('active', b === btn); });
      $('#gran-hint').textContent = state.gran === 'port'
        ? '展开每台设备的每个网口，连线表示端口之间的实际链路。'
        : '按设备查看结构，多网口聚合为一条链路。';
      rebuild();
    });

    var onSearch = debounce(function () {
      state.query = $('#search').value;
      if (state.isolateQuery) {
        rebuild();
      } else {
        var q = state.query.trim().toLowerCase();
        var hits = new Set();
        if (q) G.devices.forEach(function (d) { if (deviceMatches(d, q)) hits.add(d.id); });
        state.searchHits = hits;
        applyStyles();
      }
    }, 220);
    var sideTabs = $('#side-tabs');
    if (sideTabs) {
      sideTabs.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-side-tab]');
        if (btn) setSideTab(btn.getAttribute('data-side-tab'));
      });
      sideTabs.addEventListener('keydown', function (e) {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(e.key) < 0) return;
        var tabs = $$('#side-tabs [data-side-tab]');
        if (!tabs.length) return;
        e.preventDefault();
        var idx = tabs.indexOf(document.activeElement);
        if (idx < 0) idx = 0;
        if (e.key === 'Home') idx = 0;
        else if (e.key === 'End') idx = tabs.length - 1;
        else idx = (idx + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        setSideTab(tabs[idx].getAttribute('data-side-tab'), true);
      });
    }

    var layoutSwitch = $('#layout-switch');
    if (layoutSwitch) {
      layoutSwitch.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-layout]');
        if (btn && !btn.disabled) setLayout(btn.getAttribute('data-layout'));
      });
    }
    var presetSave = $('#preset-save');
    if (presetSave) presetSave.addEventListener('click', savePreset);
    var presetName = $('#preset-name');
    if (presetName) presetName.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); savePreset(); }
    });
    var presetList = $('#preset-list');
    if (presetList) presetList.addEventListener('click', function (e) {
      var apply = e.target.closest('[data-preset-apply]');
      if (apply) { applyPreset(apply.getAttribute('data-preset-apply')); return; }
      var del = e.target.closest('[data-preset-delete]');
      if (del) { deletePreset(del.getAttribute('data-preset-delete')); return; }
    });

    var rankOverlay = $('#rank-overlay');
    if (rankOverlay) {
      rankOverlay.addEventListener('click', function (e) {
        var lane = e.target.closest('[data-plane]');
        if (!lane || !state._planeMode) return;
        var key = lane.getAttribute('data-plane');
        if (!key) return;
        if (state.collapsedPlanes.has(key)) state.collapsedPlanes.delete(key);
        else state.collapsedPlanes.add(key);
        rebuild();
      });
    }

    $('#search').addEventListener('input', onSearch);

    $('#isolate-search').addEventListener('change', function (e) {
      state.isolateQuery = e.target.checked;
      rebuild();
    });

    $('#hide-isolated').addEventListener('change', function (e) {
      state.hideIsolated = e.target.checked;
      rebuild();
    });
    $('#only-up').addEventListener('change', function (e) {
      state.onlyUp = e.target.checked;
      rebuild();
    });
    var scopeSel = $('#scope-select');
    if (scopeSel) {
      scopeSel.addEventListener('change', function (e) {
        state.scope = e.target.value || 'all';
        rebuild();
      });
    }
    var collapseHosts = $('#collapse-hosts');
    if (collapseHosts) {
      collapseHosts.addEventListener('change', function (e) {
        state.collapseHosts = e.target.checked;
        if (!state.collapseHosts) state.expandedGroups.clear();
        rebuild();
      });
    }
    var autoBundle = $('#auto-bundle');
    if (autoBundle) {
      autoBundle.addEventListener('change', function (e) {
        state.autoBundle = e.target.checked;
        rebuild();
      });
    }
    $('#show-unused').addEventListener('change', function (e) {
      state.showUnused = e.target.checked;
      rebuild();
    });
    $('#show-wwn').addEventListener('change', function (e) {
      state.showWwn = e.target.checked;
      rebuild({ keepCamera: true });
    });

    var onSpacing = debounce(function (e) {
      state.spacing = parseFloat(e.target.value) || 1;
      rebuild({ keepCamera: true });
    }, 60);
    $('#spacing').addEventListener('input', onSpacing);

    $('#btn-fit').addEventListener('click', function () {
      fitGraph(true);
    });
    $('#btn-zoom-in').addEventListener('click', function () {
      if (!network) return;
      network.moveTo({ scale: network.getScale() * 1.25, animation: { duration: 160 } });
    });
    $('#btn-zoom-out').addEventListener('click', function () {
      if (!network) return;
      network.moveTo({ scale: network.getScale() * 0.8, animation: { duration: 160 } });
    });
    var summaryTrigger = $('#summary-trigger');
    if (summaryTrigger) {
      summaryTrigger.addEventListener('click', function (e) {
        e.stopPropagation();
        var card = $('#summary-card');
        if (card && card.hidden) openSummary();
        else closeSummary(true);
      });
      summaryTrigger.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openSummary();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeSummary(true);
        }
      });
    }
    var summaryCard = $('#summary-card');
    if (summaryCard) {
      summaryCard.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeSummary(true);
        }
      });
    }
    var summaryClose = $('#summary-close');
    if (summaryClose) summaryClose.addEventListener('click', function () { closeSummary(true); });
    var summaryFilter = $('#summary-filter');
    if (summaryFilter) summaryFilter.addEventListener('click', function () {
      closeSummary(false);
      openPicker();
    });
    var summaryRed = $('#summary-redundancy');
    if (summaryRed) summaryRed.addEventListener('click', openRedundancy);
    var redClose = $('#red-close');
    if (redClose) redClose.addEventListener('click', closeRedundancy);
    $$('#redundancy [data-red-close]').forEach(function (el) { el.addEventListener('click', closeRedundancy); });
    var redSearch = $('#red-search');
    if (redSearch) redSearch.addEventListener('input', function (e) {
      redundancy.query = e.target.value;
      renderRedundancy();
    });
    var redCsv = $('#red-csv');
    if (redCsv) redCsv.addEventListener('click', exportRedundancyCsv);
    var redFail = $('#red-fail');
    if (redFail) redFail.addEventListener('change', function (e) {
      computeRedundancy(e.target.value || null);
    });
    var redBody = $('#red-body');
    if (redBody) redBody.addEventListener('click', function (e) {
      var cell = e.target.closest('[data-red-cell]');
      if (!cell) return;
      renderRedDetail(Number(cell.getAttribute('data-hi')), Number(cell.getAttribute('data-si')));
    });
    var redDetail = $('#red-detail');
    if (redDetail) redDetail.addEventListener('click', function (e) {
      if (e.target.closest('[data-red-detail-close]')) redDetail.classList.add('hidden');
    });

    var exportTrigger = $('#btn-export');
    if (exportTrigger) {
      exportTrigger.addEventListener('click', function (e) {
        e.stopPropagation();
        var pop = $('#export-popover');
        if (pop && pop.hidden) openExportMenu();
        else closeExportMenu(true);
      });
      exportTrigger.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openExportMenu();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeExportMenu(true);
        }
      });
    }
    var exportPopover = $('#export-popover');
    if (exportPopover) {
      exportPopover.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); moveExportFocus(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); moveExportFocus(-1); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeExportMenu(true); }
        else if (e.key === 'Tab') { closeExportMenu(true); }
      });
    }
    $('#btn-path').addEventListener('click', togglePathMode);

    $('#matrix-close').addEventListener('click', closePortMatrix);
    $$('#matrix [data-matrix-close]').forEach(function (el) { el.addEventListener('click', closePortMatrix); });
    $('#matrix-search').addEventListener('input', function (e) {
      matrix.query = e.target.value;
      renderMatrix();
    });
    $('#matrix-only-used').addEventListener('change', function (e) {
      matrix.onlyUsed = e.target.checked;
      renderMatrix();
    });
    $('#matrix-csv').addEventListener('click', exportMatrixCsv);

    $('#btn-theme').addEventListener('click', function () {
      state.theme = state.theme === 'light' ? 'dark' : 'light';
      document.body.classList.toggle('dark', state.theme === 'dark');
      rebuild({ keepCamera: true });
    });

    $('#btn-reset').addEventListener('click', function () {
      resetFilters();
      state.hideIsolated = true;
      state.showUnused = false;
      state.showWwn = false;
      state.collapseHosts = false;
      state.autoBundle = true;
      state.expandedGroups.clear();
      state.collapsedPlanes.clear();
      state.scope = 'all';
      state.spacing = 1;
      state.gran = 'device';
      state.pathMode = false;
      state.pathSel = [];
      $('#hide-isolated').checked = true;
      $('#show-unused').checked = false;
      $('#show-wwn').checked = false;
      if ($('#collapse-hosts')) $('#collapse-hosts').checked = false;
      if ($('#auto-bundle')) $('#auto-bundle').checked = true;
      if ($('#scope-select')) $('#scope-select').value = 'all';
      $('#spacing').value = '1';
      $$('#gran button').forEach(function (b) { b.classList.toggle('active', b.dataset.gran === 'device'); });
      $('#gran-hint').textContent = '按设备查看结构，多网口聚合为一条链路。';
      updatePathUI();
      rebuild();
    });

    $('#filterbar').addEventListener('click', function (e) {
      var x = e.target.closest('[data-fclear]');
      if (!x) return;
      var key = x.getAttribute('data-fclear');
      if (key === 'all') { resetFilters(); return; }
      if (key.indexOf('type:') === 0) {
        state.types[key.split(':')[1]] = true;
        syncTypeCheckboxes();
      } else if (key.indexOf('devices:') === 0) {
        var t = key.split(':')[1];
        G.devices.forEach(function (d) { if (d.type === t) state.offDevices.delete(d.id); });
      } else if (key === 'ports') {
        state.offPorts.clear();
      } else if (key === 'layers') {
        state.hiddenLayers.clear();
      } else if (key === 'onlyup') {
        state.onlyUp = false;
        $('#only-up').checked = false;
      } else if (key === 'collapse') {
        state.collapseHosts = false;
        state.expandedGroups.clear();
        if ($('#collapse-hosts')) $('#collapse-hosts').checked = false;
      } else if (key === 'auto-bundle') {
        state.autoBundle = false;
        if ($('#auto-bundle')) $('#auto-bundle').checked = false;
      } else if (key === 'expanded-groups') {
        state.expandedGroups.clear();
      } else if (key === 'scope') {
        state.scope = 'all';
        if ($('#scope-select')) $('#scope-select').value = 'all';
      } else if (key.indexOf('plane:') === 0) {
        state.collapsedPlanes.delete(key.slice(6));
      } else if (key === 'query') {
        state.query = '';
        state.isolateQuery = false;
        $('#search').value = '';
        $('#isolate-search').checked = false;
      }
      rebuild();
    });

    /* picker */
    $('#pick-tabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-tab]');
      if (!b) return;
      picker.tab = b.dataset.tab;
      $$('#pick-tabs button').forEach(function (x) { x.classList.toggle('active', x === b); });
      renderPicker();
    });
    $('#pick-search').addEventListener('input', function (e) {
      picker.query = e.target.value;
      renderPicker();
    });
    $('#pick-result-all').addEventListener('click', function () { pickerResultAll(true); });
    $('#pick-result-none').addEventListener('click', function () { pickerResultAll(false); });
    $('#pick-list').addEventListener('click', pickerEvent);
    $('#pick-list').addEventListener('keydown', function (e) {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      var target = e.target.closest('[data-dev-toggle],[data-port-toggle]');
      if (!target) return;
      e.preventDefault();
      target.click();
    });
    $('#pick-all').addEventListener('click', function () {
      G.devices.forEach(function (d) {
        picker.draft.offDevices.delete(d.id);
        d.ports.forEach(function (p) { picker.draft.offPorts.delete(p.id); });
        picker.draft.types[d.type] = true;
      });
      renderPicker();
    });
    $('#pick-none').addEventListener('click', function () {
      G.devices.forEach(function (d) { picker.draft.offDevices.add(d.id); });
      renderPicker();
    });
    $('#pick-ports-all').addEventListener('click', function () {
      picker.draft.offPorts.clear();
      renderPicker();
    });
    $('#pick-apply').addEventListener('click', applyPicker);
    $$('#picker [data-close]').forEach(function (el) {
      el.addEventListener('click', closePicker);
    });

    $('#detail').addEventListener('click', function (e) {
      var matrixBtn = e.target.closest('[data-action="matrix"]');
      if (matrixBtn && state.current) {
        var md = devById.get(nodeDeviceId(state.current));
        if (md) openPortMatrix(md);
        return;
      }
      var expandGroup = e.target.closest('[data-action="expand-group"]');
      if (expandGroup) {
        var gid = expandGroup.getAttribute('data-group');
        if (gid) state.expandedGroups.add(gid);
        hideDetail();
        rebuild();
        return;
      }
      var expandHosts = e.target.closest('[data-action="expand-hosts"]');
      if (expandHosts) {
        state.collapseHosts = false;
        state.autoBundle = false;
        state.expandedGroups.clear();
        var cb = $('#collapse-hosts');
        if (cb) cb.checked = false;
        var ab = $('#auto-bundle');
        if (ab) ab.checked = false;
        hideDetail();
        rebuild();
        return;
      }
      var close = e.target.closest('[data-action="close"]');
      if (close) { clearSelection(); return; }
      var copy = e.target.closest('[data-action="copy"]');
      if (copy) {
        var wwn = copy.getAttribute('data-wwn') || '';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(wwn).then(function () { toast('WWN 已复制'); }, function () { toast('复制失败，请手动选择'); });
        } else toast(wwn);
        return;
      }
      var focusBtn = e.target.closest('[data-action="focus"]');
      if (focusBtn && state.current) {
        var node = state.nodeById.get(state.current);
        if (node) selectNode(state.current, { center: false });
        return;
      }
      var filterBtn = e.target.closest('[data-action="filter"]');
      if (filterBtn && state.current) {
        var dev = devById.get(nodeDeviceId(state.current));
        if (!dev) return;
        state.offDevices.clear();
        state.offPorts.clear();
        state.types[dev.type] = true;
        G.devices.forEach(function (d) { if (d.id !== dev.id) state.offDevices.add(d.id); });
        state.hiddenLayers.clear();
        state.pinned = new Set([dev.id]);
        syncTypeCheckboxes();
        rebuild();
        toast('只显示 ' + displayName(dev) + '；点“清除全部筛选”可恢复');
        return;
      }
      var pathBtn = e.target.closest('[data-action="path"]');
      if (pathBtn && state.current) {
        var dev2 = nodeDeviceId(state.current);
        if (!state.pathMode) togglePathMode();
        state.pathSel = [dev2];
        hideDetail();
        selectNode(dev2, { detail: false });
        updatePathUI();
        toast('已选择起点，请点击终点设备');
        return;
      }
      var goto = e.target.closest('[data-goto]');
      if (goto) {
        var target = goto.getAttribute('data-goto');
        if (state.nodeById.has(target)) selectNode(target, { center: true });
        else {
          var d = devById.get(target);
          toast(d ? ('设备 ' + d.label + ' 已被筛选隐藏') : '设备不可见');
        }
      }
    });

    $('#warnings').addEventListener('click', function (e) {
      var item = e.target.closest('[data-device]');
      if (!item) return;
      var id = item.getAttribute('data-device');
      if (state.nodeById.has(id)) selectNode(id, { center: true });
      else toast('该设备已被筛选隐藏');
    });

    $('#path-hint').addEventListener('click', function (e) {
      if (e.target.closest('[data-clear]')) {
        state.pathSel = [];
        state.pathNodes = null;
        state.pathPairs = null;
        state.pathMode = false;
        updatePathUI();
        applyStyles();
        hideDetail();
      }
    });

    $('#btn-sidebar').addEventListener('click', function () {
      if (window.matchMedia('(max-width: 900px)').matches) {
        $('#sidebar').classList.toggle('open');
        syncSidebarButton();
        return;
      }
      var collapsed = document.body.classList.toggle('sidebar-collapsed');
      try { localStorage.setItem('topo-sidebar-collapsed', collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
      syncSidebarButton();
      setTimeout(function () {
        if (!network) return;
        network.redraw();
        fitGraph();
      }, 220);
    });

    var stage = $('#stage');
    var fullBtn = $('#btn-fullscreen');
    if (fullBtn && stage) {
      fullBtn.addEventListener('click', function () {
        if (document.fullscreenElement) {
          if (document.exitFullscreen) document.exitFullscreen();
          return;
        }
        if (stage.requestFullscreen) {
          stage.requestFullscreen().catch(function () { toast('当前浏览器不支持全屏预览'); });
        } else {
          toast('当前浏览器不支持全屏预览');
        }
      });
    }
    var exitFull = $('#btn-exit-fullscreen');
    if (exitFull) {
      exitFull.addEventListener('click', function () {
        if (document.exitFullscreen) document.exitFullscreen();
      });
    }
    document.addEventListener('fullscreenchange', function () {
      var on = !!document.fullscreenElement;
      if (fullBtn) {
        fullBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        fullBtn.setAttribute('aria-label', on ? '退出全屏' : '全屏预览');
        fullBtn.setAttribute('data-tip', on ? '退出全屏' : '全屏预览');
      }
      setTimeout(function () {
        if (!network) return;
        network.redraw();
        fitGraph();
      }, 80);
    });
    window.addEventListener('resize', syncSidebarButton);

    var commandInput = $('#command-input');
    if (commandInput) {
      commandInput.addEventListener('input', renderCommand);
      commandInput.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveCommand(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); moveCommand(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); runCommand(command.active); }
        else if (e.key === 'Escape') { e.preventDefault(); closeCommand(true); }
      });
    }
    var commandList = $('#command-list');
    if (commandList) {
      commandList.addEventListener('click', function (e) {
        var item = e.target.closest('[data-command-index]');
        if (item) runCommand(Number(item.getAttribute('data-command-index')));
      });
    }
    $$('#command [data-command-close]').forEach(function (el) {
      el.addEventListener('click', function () { closeCommand(true); });
    });

    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k') {
        e.preventDefault();
        if (command.open) closeCommand(true); else openCommand();
        return;
      }
      if (e.key === 'Escape') {
        if (command.open) { e.preventDefault(); closeCommand(true); return; }
        if (document.fullscreenElement && document.exitFullscreen) { document.exitFullscreen(); return; }
        var red = $('#redundancy');
        if (red && !red.classList.contains('hidden')) { closeRedundancy(); return; }
        var mx = $('#matrix');
        if (mx && !mx.classList.contains('hidden')) { closePortMatrix(); return; }
        var sum = $('#summary-card');
        if (sum && !sum.hidden) { closeSummary(true); return; }
        var exp = $('#export-popover');
        if (exp && !exp.hidden) { closeExportMenu(true); return; }
        var pop = $('#style-popover');
        if (pop && !pop.hidden) { closeStyleMenu(true); return; }
        if (picker.open) { closePicker(); return; }
        if (state.pathMode) togglePathMode();
        else clearSelection();
      }
    });
  }

  function commandActions() {
    return [
      { kind: 'ACT', label: '适应窗口', hint: '缩放并居中全部设备', run: function () { fitGraph(); } },
      { kind: 'ACT', label: '重置筛选与视图', hint: '清除所有筛选并恢复默认视图', run: function () { $('#btn-reset').click(); } },
      { kind: 'ACT', label: '切换深色 / 浅色主题', hint: '主题', run: function () { $('#btn-theme').click(); } },
      { kind: 'ACT', label: '布局：横向分层', hint: '设备视图', run: function () { setLayout('layered'); } },
      { kind: 'ACT', label: '布局：网络平面', hint: '按 meta.fabric 分带', run: function () { setLayout('plane'); } },
      { kind: 'ACT', label: '打开筛选器', hint: '设备 / 网口 / 类型', run: function () { openPicker('all'); } },
      { kind: 'ACT', label: '打开网络平面冗余分析', hint: '主机 × 存储', run: function () { openRedundancy(); } },
      { kind: 'ACT', label: '导出 PNG', hint: '当前视口 1×', run: function () { exportImage('png'); } },
      { kind: 'ACT', label: '导出设备清单 CSV', hint: '全部设备', run: function () { exportInventory('devices'); } },
      { kind: 'ACT', label: '显示图例', hint: '侧栏', run: function () { setSideTab('info'); } },
      { kind: 'ACT', label: '显示视图设置', hint: '布局 / 风格 / 预设', run: function () { setSideTab('display'); } },
      { kind: 'ACT', label: '显示筛选', hint: '设备 / 类型', run: function () { setSideTab('filter'); } },
      { kind: 'ACT', label: '收起 / 展开侧栏', hint: '界面', run: function () { $('#btn-sidebar').click(); } }
    ];
  }

  function renderCommand() {
    var list = $('#command-list');
    if (!list) return;
    var q = ($('#command-input') && $('#command-input').value || '').trim().toLowerCase();
    var items = commandActions().filter(function (a) {
      return !q || (a.label + ' ' + a.hint).toLowerCase().indexOf(q) >= 0;
    });
    if (q) {
      var devs = G.devices.filter(function (d) { return deviceMatches(d, q); }).slice(0, 8);
      devs.forEach(function (d) {
        var ip = (d.ips && d.ips[0]) || (d.meta && d.meta.fabric) || '';
        items.push({
          kind: 'DEV', label: displayName(d), hint: TYPE_LABEL[d.type] + (ip ? ' · ' + ip : ''),
          device: d,
          run: function () {
            var node = state.nodes.filter(function (n) { return n._device === d.id; })[0];
            if (!node) { toast('该设备不在当前视图'); return; }
            selectNode(node.id, { center: true });
          }
        });
      });
    }
    command.items = items.slice(0, 14);
    command.active = 0;
    if (!command.items.length) {
      list.innerHTML = '<div class="command-empty">没有匹配的设备或命令</div>';
      return;
    }
    list.innerHTML = command.items.map(function (it, i) {
      return '<div class="command-item' + (i === 0 ? ' active' : '') + '" role="option" aria-selected="' + (i === 0) + '" data-command-index="' + i + '">' +
        '<span class="cmd-kind">' + it.kind + '</span>' +
        '<span class="cmd-title">' + esc(it.label) + '</span>' +
        '<span class="cmd-hint">' + esc(it.hint) + '</span></div>';
    }).join('');
  }

  function moveCommand(dir) {
    if (!command.items.length) return;
    command.active = (command.active + dir + command.items.length) % command.items.length;
    $$('#command-list .command-item').forEach(function (el, i) {
      var on = i === command.active;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
  }

  function runCommand(index) {
    var it = command.items[index];
    if (!it) return;
    closeCommand(false);
    it.run();
  }

  function openCommand() {
    closeSummary(false);
    closeStyleMenu(false);
    closeExportMenu(false);
    $('#command').classList.remove('hidden');
    command.open = true;
    var input = $('#command-input');
    if (input) { input.value = ''; input.focus(); }
    renderCommand();
  }

  function closeCommand(refocus) {
    var modal = $('#command');
    if (!modal) return;
    modal.classList.add('hidden');
    command.open = false;
    if (refocus) {
      var search = $('#search');
      if (search) search.focus();
    }
  }

  function openSummary() {
    var card = $('#summary-card');
    var trig = $('#summary-trigger');
    if (!card || !trig) return;
    closeStyleMenu(false);
    closeExportMenu(false);
    card.hidden = false;
    trig.setAttribute('aria-expanded', 'true');
    var close = $('#summary-close');
    if (close) close.focus();
  }

  function closeSummary(refocus) {
    var card = $('#summary-card');
    var trig = $('#summary-trigger');
    if (!card || card.hidden) return;
    card.hidden = true;
    if (trig) trig.setAttribute('aria-expanded', 'false');
    if (refocus && trig) trig.focus();
  }

  function openExportMenu() {
    var pop = $('#export-popover');
    var trig = $('#btn-export');
    if (!pop || !trig) return;
    closeStyleMenu(false);
    pop.hidden = false;
    trig.setAttribute('aria-expanded', 'true');
    $$('#export-popover [data-export-scale]').forEach(function (b) {
      b.classList.toggle('active', Number(b.getAttribute('data-export-scale')) === exportScale);
    });
    var first = pop.querySelector('.export-option');
    if (first) first.focus();
  }

  function closeExportMenu(refocus) {
    var pop = $('#export-popover');
    var trig = $('#btn-export');
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    if (trig) trig.setAttribute('aria-expanded', 'false');
    if (refocus && trig) trig.focus();
  }

  function moveExportFocus(dir) {
    var opts = $$('#export-popover .export-option');
    if (!opts.length) return;
    var idx = opts.indexOf(document.activeElement);
    var next = idx < 0 ? 0 : (idx + dir + opts.length) % opts.length;
    opts[next].focus();
  }

  function csvCell(v) {
    v = v == null ? '' : String(v);
    // Excel/Sheets formula injection guard.
    if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
    return '"' + v.replace(/"/g, '""') + '"';
  }

  function safeDownloadName(name) {
    return String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'export';
  }

  function downloadCsv(filename, header, rows) {
    var lines = [header.map(csvCell).join(',')];
    rows.forEach(function (r) { lines.push(r.map(csvCell).join(',')); });
    var blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = safeDownloadName(filename);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast('已导出 ' + filename);
  }

  function exportInventory(kind) {
    var date = new Date().toISOString().slice(0, 10);
    if (kind === 'devices') {
      var dhead = ['类型', '名称', 'ID', 'WWN', 'IP', '端口数', '已连接端口', '健康', '厂商', '型号', '站点', '网络平面', '机房'];
      var drows = G.devices.map(function (d) {
        return [
          TYPE_LABEL[d.type] || d.type,
          d.label,
          d.id,
          d.wwn || '',
          (d.ips || []).join('; '),
          d.ports.length,
          d.ports.filter(function (p) { return p.connected; }).length,
          HEALTH_LABEL[deviceHealth(d)] || '未知',
          d.meta && d.meta.vendor ? d.meta.vendor : '',
          d.meta && d.meta.model ? d.meta.model : '',
          d.meta && d.meta.site ? d.meta.site : '',
          d.meta && d.meta.fabric ? d.meta.fabric : '',
          d.meta && d.meta.rack ? d.meta.rack : ''
        ];
      });
      downloadCsv('topology-' + date + '-devices.csv', dhead, drows);
      return;
    }
    if (kind === 'ports') {
      var phead = ['设备', '设备类型', '端口', 'WWN', '连接状态', '未使用', '对端设备', '对端端口', '链路类型', '链路状态', '来源'];
      var byPort = new Map();
      allLinks.forEach(function (l) {
        if (l.a.port) {
          if (!byPort.has(l.a.port)) byPort.set(l.a.port, []);
          byPort.get(l.a.port).push({ l: l, other: l.b });
        }
        if (l.b.port) {
          if (!byPort.has(l.b.port)) byPort.set(l.b.port, []);
          byPort.get(l.b.port).push({ l: l, other: l.a });
        }
      });
      var prows = [];
      G.devices.forEach(function (d) {
        d.ports.forEach(function (p) {
          var hits = byPort.get(p.id) || [];
          var state = p.connected ? '已连接' : (p.unused ? '未使用' : '未连接');
          if (!hits.length) {
            prows.push([d.label, TYPE_LABEL[d.type] || d.type, p.label, p.wwn || '', state, p.unused ? '是' : '否', '', '', '', '', '']);
            return;
          }
          hits.forEach(function (h) {
            var peerDev = devById.get(h.other.device);
            var peerPort = h.other.port ? portById.get(h.other.port) : null;
            prows.push([
              d.label, TYPE_LABEL[d.type] || d.type, p.label, p.wwn || '', state, p.unused ? '是' : '否',
              peerDev ? peerDev.label : h.other.device, peerPort ? peerPort.label : '',
              KIND_LABEL[h.l.kind] || h.l.kind, h.l.status || '', h.l.source || ''
            ]);
          });
        });
      });
      downloadCsv('topology-' + date + '-ports.csv', phead, prows);
      return;
    }
    if (kind === 'links') {
      var lhead = ['A 设备', 'A 端口', 'A WWN', 'B 设备', 'B 端口', 'B WWN', '链路类型', '状态', '速率', '来源'];
      var lrows = allLinks.map(function (l) {
        var da = devById.get(l.a.device), db = devById.get(l.b.device);
        var pa = l.a.port ? portById.get(l.a.port) : null;
        var pb = l.b.port ? portById.get(l.b.port) : null;
        return [
          da ? da.label : l.a.device, pa ? pa.label : '', l.a.wwn || '',
          db ? db.label : l.b.device, pb ? pb.label : '', l.b.wwn || '',
          KIND_LABEL[l.kind] || l.kind, l.status || '', l.speed || '', l.source || ''
        ];
      });
      downloadCsv('topology-' + date + '-links.csv', lhead, lrows);
    }
  }

  function downloadCanvas(out, format, quality) {
    var mime = format === 'jpg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
    var ext = format === 'jpg' ? 'jpg' : format === 'webp' ? 'webp' : 'png';
    var data = out.toDataURL(mime, 0.92);
    if (format === 'webp' && data.indexOf('data:image/webp') !== 0) {
      toast('当前浏览器不支持 WebP，已改为 PNG');
      data = out.toDataURL('image/png');
      ext = 'png';
    } else if (format === 'jpg' && data.indexOf('data:image/jpeg') !== 0) {
      toast('当前浏览器不支持 JPG，已改为 PNG');
      data = out.toDataURL('image/png');
      ext = 'png';
    }
    var a = document.createElement('a');
    a.download = 'topology-' + new Date().toISOString().slice(0, 10) +
      (quality > 1 ? '@' + quality + 'x' : '') + '.' + ext;
    a.href = data;
    a.click();
    toast('已导出 ' + ext.toUpperCase() + (quality > 1 ? '（' + quality + '×）' : ''));
  }

  function copyCanvas(src, net, cssWidth, baseWidth) {
    var out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    var ctx = out.getContext('2d');
    ctx.fillStyle = state.theme === 'dark' ? '#0b1424' : '#f7f9fc';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0);
    drawRankOverlayOnCanvas(ctx, net, cssWidth, baseWidth);
    return out;
  }

  function exportHighRes(format, quality) {
    if (!network || !state.nodes.length || !window.vis) return;
    var el = $('#network');
    var w = el.clientWidth || 1200;
    var h = el.clientHeight || 800;
    var tw = Math.round(w * quality);
    var th = Math.round(h * quality);
    if (tw * th > 40000000) {
      toast('画布过大，请降低清晰度或缩小窗口');
      return;
    }
    var view = network.getViewPosition();
    var baseScale = network.getScale();
    var host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-100000px;top:0;width:' + tw + 'px;height:' + th +
      'px;pointer-events:none;z-index:-1;background:' + (state.theme === 'dark' ? '#0b1424' : '#f7f9fc') + ';';
    document.body.appendChild(host);
    var clone;
    try {
      clone = new vis.Network(host, { nodes: nodesDS, edges: edgesDS }, networkOptions());
      clone.setSize(tw + 'px', th + 'px');
    } catch (e) {
      if (clone) clone.destroy();
      host.remove();
      toast('高清导出失败：' + e.message);
      return;
    }

    var done = false;
    function cleanup() {
      if (clone) clone.destroy();
      host.remove();
    }
    function finish() {
      if (done) return;
      done = true;
      var src = null;
      var canvases = host.querySelectorAll('canvas');
      for (var i = 0; i < canvases.length; i++) {
        if (canvases[i].width > 100) { src = canvases[i]; break; }
      }
      if (!src) {
        cleanup();
        toast('高清导出失败：画布未就绪');
        return;
      }
      var baseW = $('#stage') ? $('#stage').clientWidth : tw;
      var out = copyCanvas(src, clone, tw, baseW);
      cleanup();
      downloadCanvas(out, format, quality);
    }
    clone.once('afterDrawing', finish);
    clone.moveTo({ position: view, scale: baseScale * quality, animation: false });
    clone.redraw();
    setTimeout(finish, 3000);
    toast('正在渲染 ' + quality + '× 图片…');
  }

  function exportImage(format) {
    format = format === 'jpg' || format === 'webp' ? format : 'png';
    if (!network || !state.nodes.length) return;
    var quality = exportScale || 1;
    if (quality > 1) {
      exportHighRes(format, quality);
      return;
    }
    network.redraw();
    var src = null;
    var canvases = $$('#network canvas');
    for (var i = 0; i < canvases.length; i++) {
      if (canvases[i].width > 100) { src = canvases[i]; break; }
    }
    if (!src) { toast('导出失败：画布未就绪'); return; }
    var stage = $('#stage');
    var bw = stage ? stage.clientWidth : src.width;
    downloadCanvas(copyCanvas(src, network, bw, bw), format, 1);
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  function syncStyleButtons() {
    $$('[data-style]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-style') === state.style);
    });
    var label = $('#style-label');
    var swatch = $('#style-swatch');
    if (label) label.textContent = STYLE_LABELS[state.style] || state.style;
    if (swatch) swatch.className = 'swatch ' + state.style;
    var trig = $('#style-trigger');
    if (trig) trig.setAttribute('data-tip', '节点风格：' + (STYLE_LABELS[state.style] || state.style) + '（点击切换）');
    $$('#style-popover .style-option').forEach(function (b) {
      var on = b.getAttribute('data-style') === state.style;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function openStyleMenu() {
    var pop = $('#style-popover');
    var trig = $('#style-trigger');
    if (!pop || !trig) return;
    closeExportMenu(false);
    pop.hidden = false;
    trig.setAttribute('aria-expanded', 'true');
    var cur = pop.querySelector('.style-option[data-style="' + state.style + '"]') || pop.querySelector('.style-option');
    if (cur) cur.focus();
  }

  function closeStyleMenu(refocus) {
    var pop = $('#style-popover');
    var trig = $('#style-trigger');
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    if (trig) trig.setAttribute('aria-expanded', 'false');
    if (refocus && trig) trig.focus();
  }

  function moveStyleFocus(dir) {
    var opts = $$('#style-popover .style-option');
    if (!opts.length) return;
    var idx = opts.indexOf(document.activeElement);
    var next = idx < 0 ? 0 : (idx + dir + opts.length) % opts.length;
    opts[next].focus();
  }

  function setStyle(name, fromMenu) {
    if (['shadcn', 'line', 'skeuo'].indexOf(name) < 0) return;
    if (name === state.style) { closeStyleMenu(true); return; }
    closeStyleMenu(false);
    state.style = name;
    try { localStorage.setItem('topo-style-v3', name); } catch (e) { /* file:// 下可能不可用 */ }
    syncStyleButtons();
    rebuild({ keepCamera: true });
    toast(name === 'shadcn' ? '节点风格：shadcn/ui' : name === 'line' ? '节点风格：线稿' : '节点风格：机架拟物');
    if (fromMenu) requestAnimationFrame(function () {
      var trig = $('#style-trigger');
      if (trig) trig.focus();
    });
  }

  function syncSidebarButton() {
    var btn = $('#btn-sidebar');
    if (!btn) return;
    var mobile = window.matchMedia('(max-width: 900px)').matches;
    var collapsed = document.body.classList.contains('sidebar-collapsed');
    var open = $('#sidebar').classList.contains('open');
    var label = mobile ? (open ? '关闭筛选面板' : '打开筛选面板') : (collapsed ? '展开侧栏' : '收起侧栏');
    btn.setAttribute('aria-label', label);
    btn.setAttribute('data-tip', label);
    btn.setAttribute('aria-pressed', (mobile ? open : collapsed) ? 'true' : 'false');
    var sidebar = $('#sidebar');
    if (sidebar && 'inert' in sidebar) sidebar.inert = mobile ? !open : collapsed;
  }

  function syncShellButtons() {
    $$('[data-shell]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-shell') === state.shell);
    });
  }

  function applyShell(name) {
    state.shell = name === 'shadcn' ? 'shadcn' : 'classic';
    document.body.classList.toggle('shell-classic', state.shell === 'classic');
    document.body.classList.toggle('shell-shadcn', state.shell === 'shadcn');
    syncShellButtons();
  }

  function setShell(name) {
    if (name !== 'classic' && name !== 'shadcn') return;
    if (name === state.shell) return;
    applyShell(name);
    try { localStorage.setItem('topo-shell', state.shell); } catch (e) { /* ignore */ }
    toast(state.shell === 'classic' ? '界面风格：经典' : '界面风格：shadcn');
  }

  function init() {
    try {
      var saved = localStorage.getItem('topo-style-v3');
      if (saved === 'shadcn' || saved === 'line' || saved === 'skeuo') state.style = saved;
      var savedShell = localStorage.getItem('topo-shell');
      if (savedShell === 'classic' || savedShell === 'shadcn') state.shell = savedShell;
      var savedLayout = localStorage.getItem('topo-layout');
      if (savedLayout === 'plane' && hasPlaneMeta()) state.layout = 'plane';
      if (localStorage.getItem('topo-sidebar-collapsed') === '1') document.body.classList.add('sidebar-collapsed');
    } catch (e) { /* ignore */ }
    applyShell(state.shell);
    renderTypeFilters();
    renderKindFilters();
    renderScopeSelector();
    renderWarnings();
    bindUI();
    loadPresets();
    renderPresets();
    setSideTab(state.sideTab || 'filter');
    syncStyleButtons();
    syncLayoutButtons();
    syncSidebarButton();
    rebuild();
    if (document.body.classList.contains('sidebar-collapsed') && window.matchMedia('(min-width: 901px)').matches) {
      setTimeout(fitGraph, 260);
    }
    window.__TOPO__ = {
      state: state,
      get network() { return network; },
      get flags() { return nodeFlags; },
      select: selectNode,
      rebuild: rebuild,
      openPicker: openPicker,
      setStyle: setStyle
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
