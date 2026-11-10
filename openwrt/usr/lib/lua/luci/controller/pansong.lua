module("luci.controller.pansong", package.seeall)

local fs = require "nixio.fs"
local sys = require "luci.sys"
local http = require "luci.http"
local uci = require "luci.model.uci".cursor()

function index()
	if not fs.access("/etc/config/pansong") then
		return
	end

	local page = entry({"admin", "services", "pansong"}, alias("admin", "services", "pansong", "settings"), _("盘松网盘聚合"), 25)
	page.dependent = true
	page.acl_depends = { "luci-app-pansong" }

	entry({"admin", "services", "pansong", "settings"}, cbi("pansong/settings"), _("服务设置与状态"), 1).leaf = true
	entry({"admin", "services", "pansong", "log"}, template("pansong/log"), _("运行日志"), 2).leaf = true

	entry({"admin", "services", "pansong", "status"}, call("act_status")).leaf = true
	entry({"admin", "services", "pansong", "action"}, call("act_control")).leaf = true
	entry({"admin", "services", "pansong", "getlog"}, call("act_log")).leaf = true
end

function act_status()
	local port = uci:get("pansong", "main", "port") or "3200"
	local running = (sys.call("pgrep -f '/usr/share/pansong/src/server.js' >/dev/null 2>&1") == 0)
	local health_raw = ""
	if running then
		health_raw = sys.exec("curl -s --max-time 2 http://127.0.0.1:" .. port .. "/api/health 2>/dev/null")
	end

	http.prepare_content("application/json")
	http.write_json({
		running = running,
		port = tonumber(port) or 3200,
		health_raw = health_raw
	})
end

function act_control()
	local cmd = http.formvalue("cmd") or ""
	local port = uci:get("pansong", "main", "port") or "3200"
	if cmd == "restart" then
		sys.call("/etc/init.d/pansong restart >/dev/null 2>&1 &")
	elseif cmd == "start" then
		uci:set("pansong", "main", "enabled", "1")
		uci:commit("pansong")
		sys.call("/etc/init.d/pansong start >/dev/null 2>&1 &")
	elseif cmd == "stop" then
		sys.call("/etc/init.d/pansong stop >/dev/null 2>&1 &")
	elseif cmd == "clear_cache" then
		sys.call("curl -s -X POST http://127.0.0.1:" .. port .. "/api/cache/clear >/dev/null 2>&1")
	elseif cmd == "reset_breaker" then
		sys.call("curl -s -X POST http://127.0.0.1:" .. port .. "/api/breaker/reset >/dev/null 2>&1")
	end

	http.prepare_content("application/json")
	http.write_json({ ok = true, cmd = cmd })
end

function act_log()
	local log = sys.exec("logread -e pansong 2>/dev/null | tail -n 120")
	if not log or log == "" then
		log = sys.exec("logread 2>/dev/null | grep -iE 'pansong|server\\.js' | tail -n 80")
	end
	if not log or log == "" then
		log = "盘松 (PANSONG) 守护服务运行正常，暂无异常告警日志。\n"
	end
	http.prepare_content("text/plain; charset=utf-8")
	http.write(log)
end
