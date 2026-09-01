# luci-theme-round

Rounded cyan-teal glass theme for LuCI on ImmortalWrt 25.12 / OpenWrt 24+.
Pure ucode + JS — no Lua runtime required.

ImmortalWrt 25.12 / OpenWrt 24+ 的 LuCI 圆角青蓝玻璃主题。ucode + JS，不依赖 Lua。

## Features / 特性

- Glass 200px sidebar, 14px rounded cards, cyan→electric-teal primary buttons
  200px 玻璃侧栏、14px 卡片圆角、青蓝→电青主按钮
- Light by default, dark mode toggle in the sidebar
  (`localStorage['luci-theme-round']`, follows system preference until you choose)
  浅色默认，侧栏按钮切换深色；未手动选过则跟随系统
- Overview page overlays donut gauges, summary cards and per-interface traffic charts
  on top of the original tables (tables are kept)
  状态概览页顶部叠加环形仪表、概述卡和网卡流量图（原表格保留）
- Hamburger collapses the sidebar on desktop
  (`localStorage['luci-theme-round-sidebar']`); on narrow screens (≤768px) it opens
  an overlay drawer. Logout is pinned to the sidebar footer.
  汉堡可收起侧栏；窄屏（≤768px）汉堡 + 遮罩滑出菜单；退出固定在侧栏底部
- zh-Hans translations included
  内置简体中文翻译
- Static assets served with long-lived `Cache-Control` via a ucode uhttpd handler
  静态资源通过 ucode handler 设置长期缓存

## Requirements

- ImmortalWrt 25.12 / OpenWrt 24+ with LuCI (master, ucode-based)
- `luci-base`, apk (or opkg) package manager

## Install / 安装

### Option 1 — prebuilt package / 直接安装预编译包

```sh
curl -fsSL -o /tmp/luci-theme-round.apk \
  https://github.com/CyL-Cly/luci-theme-round/releases/download/latest/luci-theme-round.apk
apk add --allow-untrusted /tmp/luci-theme-round.apk
```

(opkg: `wget -O /tmp/luci-theme-round.ipk <url>` then `opkg install /tmp/luci-theme-round.ipk`)

### Option 2 — build from source / 源码编译

Clone into an OpenWrt SDK or buildroot:

```sh
git clone https://github.com/CyL-Cly/luci-theme-round feeds/luci-theme-round
make package/feeds/luci-theme-round/compile V=s
```

Install the resulting `luci-theme-round-*.apk` (or `.ipk`) from
`bin/packages/<arch>/luci-theme-round/`.

> Note: this is a single-package repo, so `./scripts/feeds install luci-theme-round`
> does not work — point `src-git` at it only if you restructure it as a feed, or
> just clone it into `package/` and run
> `make package/luci-theme-round/compile V=s`.

### Activate the theme / 启用主题

```sh
uci set luci.main.mediaurlbase=/luci-static/round
uci commit luci
rm -f /tmp/luci-indexcache
rm -rf /tmp/luci-modulecache
```

Or pick **Round** under **System → System → Language and Style**
（或在 **系统 → 系统 → 语言和界面** 里选 **Round**）。

First install registers `luci.themes.Round` via uci-defaults and switches to
Round if no theme was set before. 首次安装会自动注册主题，未设置过主题时自动切换。

## Uninstall / 卸载

```sh
apk del luci-theme-round    # or: opkg remove luci-theme-round
```

postrm removes the `luci.themes.Round` entry and the uhttpd ucode cache prefixes
and restarts uhttpd. 卸载会自动清理主题注册与静态缓存 handler。

## Local preview / 本地预览

This repo keeps `preview/` untracked. Clone and open `preview/index.html` in a
browser to see the mock, or serve the repo root:

```sh
git clone https://github.com/CyL-Cly/luci-theme-round
cd luci-theme-round
python3 -m http.server   # then browse to http://localhost:8000/preview/index.html
```

## Layout

| Path | Purpose |
|---|---|
| `htdocs/luci-static/round/` | CSS (`cascade.css`, `mobile.css`, `custom.css`) and logo |
| `htdocs/luci-static/resources/` | JS: menu, login view, overview dashboard |
| `ucode/template/themes/round/` | header / footer / sysauth templates |
| `root/usr/share/ucode/luci-round/` | uhttpd ucode handler for static asset caching |
| `root/etc/uci-defaults/` | first-boot theme registration |
| `po/zh_Hans/` | Simplified Chinese translations (`.po` + built `.lmo`) |

## License

Apache-2.0
