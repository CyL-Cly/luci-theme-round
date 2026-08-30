'use strict';
'require baseclass';
'require rpc';
'require fs';
'require network';

const POLL_MS = 2000;
const HISTORY = 60;
const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_R = 52;
const RING_C = 2 * Math.PI * RING_R;
const SKIP_IFACE = /^(lo|ifb\d*|teql\d*|sit\d*|gre\d*|gretap\d*|erspan\d*|dummy\d*|tun\d*|tap\d*|ip6tnl\d*|ip6gre\d*|veth)/;

const callSystemInfo = rpc.declare({
	object: 'system',
	method: 'info'
});

const callDevStatus = rpc.declare({
	object: 'network.device',
	method: 'status'
});

const callDhcpLeases = rpc.declare({
	object: 'luci-rpc',
	method: 'getDHCPLeases',
	expect: { '': {} }
});

const callMountPoints = rpc.declare({
	object: 'luci',
	method: 'getMountPoints',
	expect: { result: [] }
});

const callNetworkDevices = rpc.declare({
	object: 'luci-rpc',
	method: 'getNetworkDevices',
	expect: { '': {} }
});

function svg(name, attrs, children) {
	const el = document.createElementNS(SVG_NS, name);
	for (const key in attrs)
		el.setAttribute(key, attrs[key]);
	(children || []).forEach((child) => el.appendChild(child));
	return el;
}

function fmtBytes(n) {
	n = Math.max(0, Number(n) || 0);
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let i = 0;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}
	const digits = i === 0 ? 0 : (n >= 100 ? 0 : n >= 10 ? 1 : 2);
	return n.toFixed(digits) + ' ' + units[i];
}

function fmtRate(n) {
	return fmtBytes(n) + '/s';
}

function clampPct(n) {
	n = Number(n);
	if (!isFinite(n) || n < 0)
		return 0;
	return Math.min(100, n);
}

function levelFor(pct) {
	if (pct >= 90)
		return 'danger';
	if (pct >= 70)
		return 'warn';
	return 'ok';
}

function skipIface(name) {
	return !name || SKIP_IFACE.test(name);
}

function cpuFromStat(line) {
	if (!line)
		return null;
	const parts = line.trim().split(/\s+/);
	if (parts[0] !== 'cpu')
		return null;
	const nums = parts.slice(1).map((v) => parseInt(v, 10) || 0);
	const idle = (nums[3] || 0) + (nums[4] || 0);
	const total = nums.slice(0, 8).reduce((s, v) => s + v, 0);
	return { idle, total };
}

function addrsOf(net) {
	if (!net)
		return [];
	try {
		if (typeof net.getIPAddrs === 'function') {
			const addrs = net.getIPAddrs();
			return Array.isArray(addrs) ? addrs.filter(Boolean) : [];
		}
	} catch (e) { /* ignore */ }
	return [];
}

function settled(value, fallback) {
	try {
		return Promise.resolve(value).then((v) => (v == null ? fallback : v), () => fallback);
	} catch (e) {
		return Promise.resolve(fallback);
	}
}

return baseclass.extend({
	__init__() {
		this.prevCpu = null;
		this.prevNet = null;
		this.prevAt = 0;
		this.history = [];
		this.iface = 'all';
		this.dash = this.mount();
		if (!this.dash)
			return;
		this.tick();
		this.timer = window.setInterval(() => this.tick(), POLL_MS);
	},

	mount() {
		if (document.getElementById('round-dashboard'))
			return document.getElementById('round-dashboard');

		const container = document.querySelector('#maincontent > .container') || document.getElementById('maincontent');
		if (!container)
			return null;

		const dash = this.build();
		const view = document.getElementById('view');
		const tab = document.getElementById('tabmenu');
		if (view)
			container.insertBefore(dash, view);
		else if (tab && tab.parentNode === container)
			container.insertBefore(dash, tab.nextSibling);
		else
			container.insertBefore(dash, container.firstChild);
		return dash;
	},

	buildRing(key, label) {
		const arc = svg('circle', {
			'class': 'arc',
			cx: '60',
			cy: '60',
			r: String(RING_R),
			'stroke-dasharray': RING_C.toFixed(2),
			'stroke-dashoffset': RING_C.toFixed(2)
		});
		const pct = svg('text', { 'class': 'pct', x: '60', y: '62' }, []);
		pct.textContent = '0%';

		return E('article', { 'class': 'round-dash-card', 'data-gauge': key, 'data-level': 'ok' }, [
			E('div', { 'class': 'round-dash-meta' }, [
				E('div', { 'class': 'round-dash-label' }, label),
				E('div', { 'class': 'round-dash-value' }, '—'),
				E('div', { 'class': 'round-dash-sub' }, '—')
			]),
			E('div', { 'class': 'round-dash-ring' }, [
				svg('svg', { viewBox: '0 0 120 120', 'aria-hidden': 'true' }, [
					svg('circle', { 'class': 'track', cx: '60', cy: '60', r: String(RING_R) }),
					arc,
					pct
				])
			])
		]);
	},

	buildOverviewCell(key, title) {
		return E('div', { 'class': 'round-dash-ov-cell', 'data-ov': key }, [
			E('div', { 'class': 'round-dash-ov-title' }, title),
			E('div', { 'class': 'round-dash-ov-value' }, '—'),
			E('div', { 'class': 'round-dash-ov-sub' }, '—')
		]);
	},

	build() {
		const iface = E('select', { id: 'round-dash-iface', 'aria-label': _('Interface') }, [
			E('option', { value: 'all' }, _('All'))
		]);
		iface.addEventListener('change', () => {
			this.iface = iface.value || 'all';
			this.history = [];
			this.prevNet = null;
			this.prevAt = 0;
			this.renderTraffic({
				rxRate: 0, txRate: 0, rxTotal: 0, txTotal: 0, names: this.lastNames || ['all']
			});
		});

		const chart = svg('svg', { viewBox: '0 0 640 220', preserveAspectRatio: 'none', 'class': 'round-dash-svg' }, [
			svg('g', { 'class': 'grid' }),
			svg('path', { 'class': 'fill rx' }),
			svg('path', { 'class': 'fill tx' }),
			svg('polyline', { 'class': 'line rx' }),
			svg('polyline', { 'class': 'line tx' })
		]);

		return E('div', { id: 'round-dashboard' }, [
			E('div', { 'class': 'round-dash-gauges' }, [
				this.buildRing('load', _('Load')),
				this.buildRing('cpu', 'CPU'),
				this.buildRing('ram', 'RAM'),
				this.buildRing('disk', '/')
			]),
			E('div', { 'class': 'round-dash-body' }, [
				E('section', { 'class': 'round-dash-panel round-dash-overview' }, [
					E('h3', {}, _('Overview')),
					E('div', { 'class': 'round-dash-overview-grid' }, [
						this.buildOverviewCell('wan', 'WAN'),
						this.buildOverviewCell('lan', 'LAN'),
						this.buildOverviewCell('wifi', _('Wireless')),
						this.buildOverviewCell('dhcp', 'DHCP')
					])
				]),
				E('section', { 'class': 'round-dash-panel round-dash-traffic' }, [
					E('header', { 'class': 'round-dash-traffic-head' }, [
						E('h3', {}, _('Traffic')),
						iface
					]),
					E('div', { 'class': 'round-dash-traffic-stats' }, [
						E('div', { 'class': 'round-dash-stat tx' }, [
							E('span', { 'class': 'k' }, _('Upload')),
							E('span', { 'class': 'v', 'data-k': 'txRate' }, '—')
						]),
						E('div', { 'class': 'round-dash-stat rx' }, [
							E('span', { 'class': 'k' }, _('Download')),
							E('span', { 'class': 'v', 'data-k': 'rxRate' }, '—')
						]),
						E('div', { 'class': 'round-dash-stat' }, [
							E('span', { 'class': 'k' }, _('Total sent')),
							E('span', { 'class': 'v', 'data-k': 'txTotal' }, '—')
						]),
						E('div', { 'class': 'round-dash-stat' }, [
							E('span', { 'class': 'k' }, _('Total received')),
							E('span', { 'class': 'v', 'data-k': 'rxTotal' }, '—')
						])
					]),
					E('div', { 'class': 'round-dash-chart' }, [chart])
				])
			])
		]);
	},

	setText(root, selector, text) {
		const el = root.querySelector(selector);
		if (el)
			el.textContent = text;
	},

	setGauge(key, label, value, sub, pct) {
		const card = this.dash.querySelector('[data-gauge="%s"]'.format(key));
		if (!card)
			return;
		pct = clampPct(pct);
		card.setAttribute('data-level', levelFor(pct));
		this.setText(card, '.round-dash-label', label);
		this.setText(card, '.round-dash-value', value);
		this.setText(card, '.round-dash-sub', sub);
		this.setText(card, 'text.pct', '%d%%'.format(Math.round(pct)));
		const arc = card.querySelector('circle.arc');
		if (arc)
			arc.setAttribute('stroke-dashoffset', (RING_C * (1 - pct / 100)).toFixed(2));
	},

	setOverview(key, value, sub) {
		const cell = this.dash.querySelector('[data-ov="%s"]'.format(key));
		if (!cell)
			return;
		this.setText(cell, '.round-dash-ov-value', value || '—');
		this.setText(cell, '.round-dash-ov-sub', sub || '—');
	},

	countable(devs) {
		const members = new Set();
		for (const name in devs) {
			const list = (devs[name] && (devs[name]['bridge-members'] || devs[name].bridge_members)) || [];
			list.forEach((m) => members.add(m));
		}

		const all = {};
		const listed = [];
		for (const name in devs) {
			if (skipIface(name))
				continue;
			const d = devs[name];
			if (d && d.present === false)
				continue;
			listed.push(name);
			if (!members.has(name))
				all[name] = d;
		}
		listed.sort();
		return { all, listed };
	},

		sumStats(devs) {
			let rx = 0, tx = 0;
			for (const name in devs) {
				const d = devs[name] || {};
				const st = d.statistics || d.stats || {};
				rx += Number(st.rx_bytes) || 0;
				tx += Number(st.tx_bytes) || 0;
			}
			return { rx, tx };
		},

	pickStats(devs, iface) {
		const counted = this.countable(devs);
		const src = (iface && iface !== 'all' && devs[iface]) ? { tmp: devs[iface] } : counted.all;
		const stats = this.sumStats(src);
		stats.listed = counted.listed;
		return stats;
	},

	syncIfaceSelect(names) {
		const sel = this.dash.querySelector('#round-dash-iface');
		if (!sel)
			return;
		const wanted = ['all'].concat(names);
		const have = Array.from(sel.options).map((o) => o.value);
		if (have.join('\0') === wanted.join('\0'))
			return;
		const current = this.iface;
		sel.textContent = '';
		wanted.forEach((name) => {
			sel.appendChild(E('option', { value: name }, name === 'all' ? _('All') : name));
		});
		sel.value = wanted.indexOf(current) >= 0 ? current : 'all';
		this.iface = sel.value;
	},

	renderTraffic(t) {
		this.lastNames = t.names || [];
		this.syncIfaceSelect(this.lastNames);
		this.setText(this.dash, '[data-k="txRate"]', fmtRate(t.txRate));
		this.setText(this.dash, '[data-k="rxRate"]', fmtRate(t.rxRate));
		this.setText(this.dash, '[data-k="txTotal"]', fmtBytes(t.txTotal));
		this.setText(this.dash, '[data-k="rxTotal"]', fmtBytes(t.rxTotal));

		const chart = this.dash.querySelector('.round-dash-svg');
		if (!chart)
			return;

		const w = 640, h = 220, padL = 8, padR = 8, padT = 12, padB = 10;
		const innerW = w - padL - padR;
		const innerH = h - padT - padB;
		const samples = this.history;
		let max = 1;
		samples.forEach((s) => {
			if (s.rx > max) max = s.rx;
			if (s.tx > max) max = s.tx;
		});
		const n = Math.max(samples.length - 1, 1);
		const pt = (i, v) => (padL + (innerW * i) / n).toFixed(1) + ',' + (padT + innerH * (1 - v / max)).toFixed(1);
		const y0 = (padT + innerH).toFixed(1);

		const grid = chart.querySelector('g.grid');
		grid.textContent = '';
		for (let i = 0; i <= 4; i++) {
			const gy = padT + (innerH * i) / 4;
			grid.appendChild(svg('line', {
				x1: String(padL),
				x2: String(w - padR),
				y1: String(gy),
				y2: String(gy)
			}));
		}

		function series(key) {
			if (!samples.length)
				return { line: '', fill: '' };
			const pts = samples.map((s, i) => pt(i, s[key]));
			const line = pts.join(' ');
			const xFirst = pts[0].split(',')[0];
			const xLast = pts[pts.length - 1].split(',')[0];
			const fill = 'M' + xFirst + ',' + y0 + ' L' + line.replace(/ /g, ' L') + ' L' + xLast + ',' + y0 + ' Z';
			return { line, fill };
		}

		const rx = series('rx');
		const tx = series('tx');
		chart.querySelector('polyline.line.rx').setAttribute('points', rx.line);
		chart.querySelector('polyline.line.tx').setAttribute('points', tx.line);
		chart.querySelector('path.fill.rx').setAttribute('d', rx.fill);
		chart.querySelector('path.fill.tx').setAttribute('d', tx.fill);
	},

	async readCpu() {
		const raw = await L.resolveDefault(fs.read('/proc/stat'), '');
		const lines = String(raw || '').split(/\n/);
		const now = cpuFromStat(lines[0]);
		let cores = 0;
		for (let i = 0; i < lines.length; i++) {
			if (/^cpu\d+/.test(lines[i]))
				cores++;
		}
		if (!cores)
			cores = 1;

		let pct = 0;
		if (now && this.prevCpu && now.total > this.prevCpu.total) {
			const dTotal = now.total - this.prevCpu.total;
			const dIdle = now.idle - this.prevCpu.idle;
			pct = (1 - dIdle / dTotal) * 100;
		}
		this.prevCpu = now;
		return { pct: clampPct(pct), cores };
	},

	async readWifi() {
		try {
			if (!network || typeof network.getWifiNetworks !== 'function')
				return { ssid: '—', count: '—' };
			const nets = await L.resolveDefault(network.getWifiNetworks(), []);
			const active = (nets || []).filter((n) => {
				try {
					return typeof n.isUp === 'function' ? n.isUp() : true;
				} catch (e) {
					return false;
				}
			});
			if (!active.length)
				return { ssid: '—', count: '—' };

			const ssids = [];
			active.forEach((n) => {
				try {
					const ssid = n.getSSID && n.getSSID();
					if (ssid)
						ssids.push(ssid);
				} catch (e) { /* ignore */ }
			});

			const lists = await Promise.all(active.map((n) => {
				if (typeof n.getAssocList !== 'function')
					return Promise.resolve([]);
				return L.resolveDefault(n.getAssocList(), []);
			}));
			const count = lists.reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
			return {
				ssid: ssids[0] || _('On'),
				count: '%d'.format(count)
			};
		} catch (e) {
			return { ssid: '—', count: '—' };
		}
	},

	async readDisk(info) {
		const root = info && info.root;
		if (root && Number(root.total) > 0) {
			return {
				total: Number(root.total) * 1024,
				used: Number(root.used) * 1024
			};
		}

		const mounts = await L.resolveDefault(callMountPoints(), []);
		if (Array.isArray(mounts)) {
			let hit = null;
			for (let i = 0; i < mounts.length; i++) {
				if (mounts[i] && mounts[i].mount === '/') {
					hit = mounts[i];
					break;
				}
			}
			if (!hit && mounts[0])
				hit = mounts[0];
			if (hit && Number(hit.size) > 0) {
				const total = Number(hit.size);
				const free = Number(hit.free) || 0;
				return { total, used: Math.max(0, total - free) };
			}
		}

		return { total: 0, used: 0 };
	},

	looksLikeDevs(devs) {
		if (!devs || typeof devs !== 'object' || Array.isArray(devs))
			return false;
		for (const name in devs) {
			const d = devs[name];
			if (d && typeof d === 'object' && (d.statistics || d.stats || d.type || d.up != null))
				return true;
		}
		return false;
	},

	unwrapDevs(raw) {
		if (this.looksLikeDevs(raw))
			return raw;
		if (raw && typeof raw === 'object') {
			if (this.looksLikeDevs(raw.values))
				return raw.values;
			if (this.looksLikeDevs(raw.devices))
				return raw.devices;
		}
		return null;
	},

	async readDevs() {
		return this.unwrapDevs(await settled(callDevStatus(), {}))
			|| this.unwrapDevs(await settled(callNetworkDevices(), {}))
			|| {};
	},

	async readLan() {
		try {
			if (!network || typeof network.getNetwork !== 'function')
				return null;
			const lan = await L.resolveDefault(network.getNetwork('lan'), null);
			if (lan)
				return lan;
			if (typeof network.getNetworks !== 'function')
				return null;
			const nets = await L.resolveDefault(network.getNetworks(), []);
			for (let i = 0; i < (nets || []).length; i++) {
				const n = nets[i];
				try {
					if (n && typeof n.isWAN === 'function' && !n.isWAN())
						return n;
				} catch (e) { /* ignore */ }
			}
			return (nets && nets[0]) || null;
		} catch (e) {
			return null;
		}
	},

	async tick() {
		if (this.busy)
			return;
		this.busy = true;
		try {
			await this.refresh();
		} catch (e) {
			console.error('round-dashboard', e);
		} finally {
			this.busy = false;
		}
	},

	async refresh() {
		const now = Date.now();
		const wanP = (network && typeof network.getWANNetworks === 'function')
			? network.getWANNetworks()
			: [];
		const [info, cpu, devs, wans, lan, leases, wifi] = await Promise.all([
			settled(callSystemInfo(), {}),
			this.readCpu(),
			this.readDevs(),
			settled(wanP, []),
			this.readLan(),
			settled(callDhcpLeases(), null),
			this.readWifi()
		]);

		const sys = info || {};
		const loadRaw = (sys.load || [0, 0, 0]).map((v) => (Number(v) || 0) / 65535);
		const perCore = loadRaw[0] / (cpu.cores || 1);
		const loadPct = clampPct(perCore * 100);
		const loadTxt = loadRaw.map((v) => v.toFixed(2)).join(' / ');
		const loadHint = perCore < 0.7 ? _('Running smoothly') : (
			perCore < 1 ? _('Normal load') : _('High load')
		);

		const mem = sys.memory || {};
		const memTotal = Number(mem.total) || 0;
		const memAvail = Number(mem.available != null ? mem.available : ((Number(mem.free) || 0) + (Number(mem.buffered) || 0)));
		const memUsed = memTotal ? Math.max(0, memTotal - memAvail) : 0;
		const memPct = memTotal ? (memUsed / memTotal) * 100 : 0;

		const disk = await this.readDisk(sys);
		const diskUsed = (disk && disk.used) || 0;
		const diskTotal = (disk && disk.total) || 0;
		const diskPct = diskTotal ? (diskUsed / diskTotal) * 100 : 0;

		this.setGauge('load', _('Load'), loadHint, loadTxt, loadPct);
		this.setGauge('cpu', 'CPU', '%d %s'.format(cpu.cores, _('cores')), '', cpu.pct);
		this.setGauge('ram', 'RAM', '%s / %s'.format(fmtBytes(memUsed), fmtBytes(memTotal)), '', memPct);
		this.setGauge('disk', '/', '%s / %s'.format(fmtBytes(diskUsed), fmtBytes(diskTotal)), '', diskPct);

		const wan = (wans || [])[0];
		const wanAddrs = addrsOf(wan);
		const lanAddrs = addrsOf(lan);
		const wanUp = wan && typeof wan.isUp === 'function' ? wan.isUp() : !!wanAddrs.length;
		this.setOverview('wan', wanUp ? _('Connected') : _('Down'), wanAddrs[0] || '—');
		this.setOverview('lan', lanAddrs[0] || '—', lan && lan.getName ? lan.getName() : 'LAN');
		this.setOverview('wifi', wifi.ssid, wifi.count === '—' ? '—' : _('Clients: %s').format(wifi.count));

		let leaseCount = '—';
		if (leases) {
			const v4 = Array.isArray(leases.dhcp_leases) ? leases.dhcp_leases : [];
			const v6 = Array.isArray(leases.dhcp6_leases) ? leases.dhcp6_leases : [];
			leaseCount = '%d'.format(v4.length + v6.length);
		}
		this.setOverview('dhcp', leaseCount === '—' ? '—' : _('Leases: %s').format(leaseCount), 'DHCP');

		const stats = this.pickStats(devs || {}, this.iface);
		let rxRate = 0, txRate = 0;
		if (this.prevNet && this.prevAt) {
			const dt = Math.max((now - this.prevAt) / 1000, 0.001);
			rxRate = Math.max(0, (stats.rx - this.prevNet.rx) / dt);
			txRate = Math.max(0, (stats.tx - this.prevNet.tx) / dt);
		}
		this.prevNet = { rx: stats.rx, tx: stats.tx };
		this.prevAt = now;
		this.history.push({ rx: rxRate, tx: txRate });
		if (this.history.length > HISTORY)
			this.history.shift();

		this.renderTraffic({
			rxRate, txRate,
			rxTotal: stats.rx,
			txTotal: stats.tx,
			names: stats.listed
		});
	}
});
