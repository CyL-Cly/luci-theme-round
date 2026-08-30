# 修复：CBI 页签无效 + 防火墙/端口徽章不适配

## Context

上一轮已修弹窗居中与实时图表白底（commit `9a979ab`，apk r6）。本轮是截图里的两处不适配：

1. **`/cgi-bin/luci/admin/network/network` 的 `ul.cbi-tabmenu` 点了没切**（接口 / 设备 / 全局网络选项）。LuCI `ui.js` 的 `switchTab` **只改 class 和 `data-tab-active` 属性**，真正隐藏/显示 pane 全靠 CSS。官方 bootstrap（cascade.css:2473-2484）：

```css
[data-tab-title] { height: 0; opacity: 0; overflow: hidden; }
[data-tab-active="true"] { opacity: 1; height: auto; overflow: visible; }
```

本主题 `cascade.css` **完全没有这两条**。所以 JS 其实已经切了 tab，只是三个 pane 同时可见，看起来像「点了没反应」。

2. **防火墙区域表 + 状态页端口卡**（截图）。根因都是徽章/tooltip 缺官方布局规则：
   - `.label/.ifacebadge/.zonebadge` 被统一成 `inline-flex + 药丸圆角`（cascade.css:1039），把官方「徽章里嵌徽章」的结构压扁 → 防火墙源/目标区域叠在一起，`wan6: (空)` 溢出。
   - `.cbi-tooltip` 只写了 `border-radius`，**没有官方的 `position:absolute; left:-10000px; opacity:0`**。端口卡里 `29_ports.js` 把「属于以下网络」整段放进 `.cbi-tooltip`，本主题把它当正文渲染，撑破 `max-width:100px` 的窄卡，文字换行成「已接收字节数」那种竖条。
   - 缺 `.zone-forwards`、`.network-status-table`、`.ifacebadge img`、`.td.cbi-section-actions`。

对照源：`E:\sysDownloads\luci-master\themes\luci-theme-bootstrap\htdocs\luci-static\bootstrap\cascade.css`（tabs 2473、tooltip 1806、zonebadge 2292、ifacebadge 2207、zone-forwards 1872、network-status-table 2232）。

## 修改

仅 `htdocs/luci-static/round/cascade.css`。本地 `Makefile` `PKG_RELEASE` 升到 6（与服务器已编译的 r6 对齐后再升 7）。

### 1. 补 tab pane 显隐（tabs 段 :647 附近）

```css
[data-tab-title] {
	height: 0;
	opacity: 0;
	overflow: hidden;
}
[data-tab-active="true"] {
	opacity: 1;
	height: auto;
	overflow: visible;
	transition: opacity .25s ease-in;
}
.cbi-section-node-tabbed {
	padding: 0;
	border: 0;
	box-shadow: none;
	background: transparent;
}
```

`.cbi-tabmenu > li` 加 `cursor: pointer`，保证 `<a href="#">` 可点。

### 2. 拆开徽章规则（:1038）

不要把 `.ifacebadge/.zonebadge` 跟 `.label` 绑在一起。`.label/.badge` 保留药丸；`.ifacebadge/.zonebadge` 改成官方形态（主题 token）：

```css
.ifacebadge {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 2px 6px;
	border-radius: var(--radius-sm);
	border: 1px solid var(--line);
	background: var(--bg-input);
	font-size: 12px;
	font-weight: 600;
	line-height: 1.3;
	white-space: nowrap;
}
.ifacebadge img { width: 16px; height: 16px; vertical-align: middle; }
.ifacebadge.large img { width: 32px; height: 32px; }

.zonebadge {
	display: inline-flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px;
	padding: 4px 8px;
	border-radius: var(--radius-sm);
	white-space: nowrap;
}
.zonebadge > .ifacebadge { margin: 0; }
.zonebadge-empty { border: 1px dashed var(--line-strong); color: var(--text-muted); font-style: italic; }
```

暗色下 LuCI 给 `.zonebadge[style]` / `.ifacebox-head[style]` 写内联亮色，补一条（仿 bootstrap:2189）：

```css
:root[data-darkmode="true"] .zonebadge[style],
:root[data-darkmode="true"] .ifacebox-head[style] {
	background: linear-gradient(rgba(0,0,0,.28), rgba(0,0,0,.18)) !important;
}
```

### 3. 补 tooltip 隐藏（替换 :1413 的空规则）

```css
.cbi-tooltip-container { cursor: help; position: relative; }
.cbi-tooltip {
	position: absolute;
	z-index: 1000;
	left: -10000px;
	opacity: 0;
	padding: 6px 10px;
	border-radius: 8px;
	background: var(--bg-panel);
	border: 1px solid var(--line);
	box-shadow: var(--shadow);
	color: var(--text);
	white-space: pre;
	pointer-events: none;
	transition: opacity .2s ease-in;
}
.cbi-tooltip-container:hover .cbi-tooltip:not(:empty) {
	left: auto;
	opacity: 1;
}
```

端口卡「属于以下网络」会回到 hover 才出现。

### 4. 补防火墙 forwards + 端口卡 + 操作列

```css
.zone-forwards { display: flex; flex-wrap: nowrap; align-items: center; gap: 8px; }
.zone-forwards > * { flex: 1 1 40%; }
.zone-forwards > span { flex-basis: 10%; text-align: center; }
.zone-forwards .zone-src, .zone-forwards .zone-dest { display: flex; flex-direction: column; gap: 6px; }

.network-status-table { display: flex; flex-wrap: wrap; }
.network-status-table .ifacebox { margin: .5em; flex-grow: 1; }
.network-status-table .ifacebox-body { display: flex; flex-direction: column; height: 100%; text-align: left; }
.network-status-table .ifacebox-body .ifacebadge {
	display: flex; flex: 1; min-width: 220px; white-space: normal;
}

.ifacebox { display: inline-flex; flex-direction: column; min-width: 70px; }
.ifacebox-body { overflow: hidden; }

.td.cbi-section-actions { text-align: right; white-space: nowrap; width: 1%; }
.td.cbi-section-actions > * { display: inline-flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; }
```

## 不改的东西

- 不改 `ui.js` / 网络页 JS。tab 失效是纯 CSS。
- 不改 `.round-dash-*`。
- `Makefile` 只动 `PKG_RELEASE`（本地 5 → 7，与即将编译的 apk 对齐）。

## 验证

1. 网络 → 接口：点「设备」「全局网络选项」，pane 应互斥切换，菜单高亮跟着走。
2. 网络 → 防火墙：源/目标区域徽章并排不叠，iface 图标完整，「添加」和行操作按钮不挤成竖条。
3. 状态概览「端口状态」：窄卡只显示口名/速率/色条；「属于以下网络」和详细统计 hover 才出；不再把「已接收字节数」撑破卡片。
4. 按惯例：编辑前 commit 当前树 → 改完 commit → ssh hkserver 同步 SDK、`PKG_RELEASE:=7`、`make package/luci-theme-round/compile`、apk 拉回 `out/`。
