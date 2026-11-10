local m, s, o
local uci = require "luci.model.uci".cursor()

m = Map("pansong", translate("盘松 · PANSONG 多网盘资源聚合引擎"),
	translate("零 Docker 纯 Node.js 驱动的东方极简影视海报墙与多网盘资源聚合搜索引擎（内置 10 大直连插件源 + 41 个 Telegram 频道 + 7×24 防封护盾）。"))

m:section(SimpleSection).template = "pansong/status"

s = m:section(TypedSection, "pansong", translate("基本配置"))
s.addremove = false
s.anonymous = true

o = s:option(Flag, "enabled", translate("启用盘松服务"), translate("勾选后开机自动通过 procd 守护进程在后台运行盘松引擎"))
o.rmempty = false
o.default = "1"

o = s:option(Value, "port", translate("Web 监听端口"), translate("默认 3200，局域网设备可直接通过 http://路由器IP:端口 访问"))
o.datatype = "port"
o.default = "3200"
o.rmempty = false

o = s:option(Value, "proxy", translate("HTTP 代理地址（可选）"),
	translate("若路由器自身已开启透明代理（OpenClash / Nikki / PassWall），留空即可直连 Telegram；也可指定如 http://127.0.0.1:7890"))
o.placeholder = "留空则使用路由器网关直连，例如 http://127.0.0.1:7890"
o.rmempty = true

o = s:option(Flag, "enable_tg", translate("启用 Telegram 频道并发抓取"),
	translate("并发检索 41 个公开 Telegram 资源频道，自动按历史命中率排优"))
o.default = "1"
o.rmempty = false

o = s:option(Flag, "hide_own", translate("净网过滤模式"),
	translate("自动剔除上游站点的置顶引流链接与公众号营销噪音"))
o.default = "1"
o.rmempty = false

o = s:option(Value, "cache_ttl", translate("搜索缓存有效时间（分钟）"),
	translate("相同关键词在缓存期内的二次检索与多端并发检索将毫秒级秒回"))
o.datatype = "uinteger"
o.default = "30"
o.rmempty = false

m.on_after_commit = function(self)
	luci.sys.call("/etc/init.d/pansong reload >/dev/null 2>&1 &")
end

return m
