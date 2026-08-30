include $(TOPDIR)/rules.mk

PKG_NAME:=luci-theme-round
PKG_VERSION:=1.0.0
PKG_RELEASE:=10

PKG_MAINTAINER:=
PKG_LICENSE:=Apache-2.0

include $(INCLUDE_DIR)/package.mk

define Package/luci-theme-round
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=4. Themes
  TITLE:=Round cyan-glass LuCI theme
  DEPENDS:=+luci-base
  PKGARCH:=all
endef

define Package/luci-theme-round/description
  Rounded cyan-teal glass theme for LuCI on ImmortalWrt 25.12 / OpenWrt 24+.
  Sidebar layout with light/dark toggle. No Lua runtime required.
endef

define Build/Prepare
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/luci-theme-round/install
	$(INSTALL_DIR) $(1)/www/luci-static/round
	$(INSTALL_DATA) ./htdocs/luci-static/round/cascade.css $(1)/www/luci-static/round/cascade.css
	$(INSTALL_DATA) ./htdocs/luci-static/round/mobile.css $(1)/www/luci-static/round/mobile.css
	$(INSTALL_DATA) ./htdocs/luci-static/round/custom.css $(1)/www/luci-static/round/custom.css
	$(INSTALL_DATA) ./htdocs/luci-static/round/logo.svg $(1)/www/luci-static/round/logo.svg

	$(INSTALL_DIR) $(1)/www/luci-static/resources
	$(INSTALL_DATA) ./htdocs/luci-static/resources/menu-round.js $(1)/www/luci-static/resources/menu-round.js

	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/round
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/round/sysauth.js $(1)/www/luci-static/resources/view/round/sysauth.js
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/round/dashboard.js $(1)/www/luci-static/resources/view/round/dashboard.js

	$(INSTALL_DIR) $(1)/usr/share/ucode/luci/template/themes/round
	$(INSTALL_DATA) ./ucode/template/themes/round/header.ut $(1)/usr/share/ucode/luci/template/themes/round/header.ut
	$(INSTALL_DATA) ./ucode/template/themes/round/footer.ut $(1)/usr/share/ucode/luci/template/themes/round/footer.ut
	$(INSTALL_DATA) ./ucode/template/themes/round/sysauth.ut $(1)/usr/share/ucode/luci/template/themes/round/sysauth.ut

	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./root/etc/uci-defaults/30_luci-theme-round $(1)/etc/uci-defaults/30_luci-theme-round

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-theme-round.json $(1)/usr/share/rpcd/acl.d/luci-theme-round.json
endef

define Package/luci-theme-round/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache /tmp/luci-modulecache/* 2>/dev/null
	/etc/init.d/rpcd reload >/dev/null 2>&1 || true
}
exit 0
endef

define Package/luci-theme-round/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	uci -q delete luci.themes.Round
	uci -q commit luci
	rm -f /tmp/luci-indexcache /tmp/luci-modulecache/* 2>/dev/null
}
exit 0
endef

$(eval $(call BuildPackage,luci-theme-round))
