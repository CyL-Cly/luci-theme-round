# luci-theme-round

ImmortalWrt 25.12 / OpenWrt 24+ 的 LuCI 圆角青蓝玻璃主题。ucode + JS，不依赖 Lua。

本地预览：用浏览器打开 [`preview/index.html`](preview/index.html)。

## 安装

把本目录拷到 SDK 的 `package/luci-theme-round`，编译：

```sh
make package/luci-theme-round/compile V=s
```

在路由器上安装生成的 `luci-theme-round*.apk`（或 `.ipk`），然后：

```sh
uci set luci.main.mediaurlbase=/luci-static/round
uci commit luci
rm -f /tmp/luci-indexcache
rm -rf /tmp/luci-modulecache
```

或在 **系统 → 系统 → 语言和界面** 里选 **Round**。

首次安装时 uci-defaults 会注册 `luci.themes.Round`，并在尚未设置过主题时切到 Round。

## 外观

- 浅色默认，侧栏按钮切换深色（`localStorage['luci-theme-round']`，未手动选过则跟随系统）
- 220px 玻璃侧栏、14px 卡片圆角、青蓝→电青主按钮
- 窄屏（≤768px）汉堡 + 遮罩滑出菜单

覆盖样式写在 `htdocs/luci-static/round/custom.css`。
