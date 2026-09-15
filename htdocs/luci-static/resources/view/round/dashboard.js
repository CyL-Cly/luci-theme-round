'use strict';
'require baseclass';
'require rpc';
'require fs';
'require network';
'require poll';

// poll.add() takes seconds; 5s matches the interval used by official
// dashboard/status pages and keeps 60 samples covering ~5 minutes.
const POLL_SECS = 5;
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

// 把峰值向上取整到 1/2/2.5/5/10 × 10^k 的“整数刻度”，并设置 1 KB/s 的下限，
// 避免空闲时的微小抖动被放大成满屏曲线（看起来“很假”）。
function niceMax(v) {
	v = Number(v) || 0;
	if (v <= 1024)
		return 1024;
	const exp = Math.floor(Math.log(v) / Math.LN10);
	const base = Math.pow(10, exp);
	const frac = v / base;
	let nice;
	if (frac <= 1) nice = 1;
	else if (frac <= 2) nice = 2;
	else if (frac <= 2.5) nice = 2.5;
	else if (frac <= 5) nice = 5;
	else nice = 10;
	return nice * base;
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
		poll.add(() => this.tick(), POLL_SECS);
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

		const chart = svg('svg', { viewBox: '0 0 640 220', 'class': 'round-dash-svg' }, [
			svg('g', { 'class': 'grid' }),
			svg('g', { 'class': 'yaxis' }),
			svg('path', { 'class': 'fill rx' }),
			svg('path', { 'class': 'fill tx' }),
			svg('polyline', { 'class': 'line rx' }),
			svg('polyline', { 'class': 'line tx' }),
			svg('g', { 'class': 'hover', style: 'display:none' }, [
				svg('line', { 'class': 'cross' }),
				svg('circle', { 'class': 'dot rx', r: '3.5' }),
				svg('circle', { 'class': 'dot tx', r: '3.5' })
			]),
			svg('rect', { 'class': 'overlay', x: '0', y: '0', width: '100%', height: '100%' })
		]);
		const tip = E('div', { 'class': 'round-dash-tip', style: 'display:none' });
		this.chartEl = chart;
		this.tipEl = tip;
		this.parts = {
			grid: chart.querySelector('g.grid'),
			yaxis: chart.querySelector('g.yaxis'),
			lineRx: chart.querySelector('polyline.line.rx'),
			lineTx: chart.querySelector('polyline.line.tx'),
			fillRx: chart.querySelector('path.fill.rx'),
			fillTx: chart.querySelector('path.fill.tx')
		};
		this.lastW = 0;
		this.lastH = 0;
		this.yLabels = [];
		chart.addEventListener('pointermove', (ev) => this.onChartHover(ev));
		chart.addEventListener('pointerleave', () => this.hideHover());

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
					E('div', { 'class': 'round-dash-chart' }, [chart, tip])
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

		const chart = this.chartEl;
		const host = this.dash.querySelector('.round-dash-chart');
		const parts = this.parts;
		if (!chart || !host || !parts)
			return;

		const w = Math.max(host.clientWidth || 0, 320);
		const h = Math.max(host.clientHeight || 0, 160);

		const padL = 58, padR = 12, padT = 12, padB = 18;
		const innerW = Math.max(w - padL - padR, 10);
		const innerH = Math.max(h - padT - padB, 10);
		const samples = this.history;

		let peak = 0;
		samples.forEach((s) => {
			if (s.rx > peak) peak = s.rx;
			if (s.tx > peak) peak = s.tx;
		});
		const max = niceMax(peak);
		// 固定时间窗口：每两个采样点的间距恒定，最新点贴在右侧，
		// 数据不满 HISTORY 时曲线只占右侧部分，如实反映“刚开始采集”。
		const step = innerW / (HISTORY - 1);

		// 网格线只依赖几何尺寸，仅在容器尺寸变化时重建 DOM；Y 轴刻度文字
		// 依赖 max，每帧只改文本，避免无谓的节点增删。
		const DIV = 4;
		if (w !== this.lastW || h !== this.lastH || this.yLabels.length !== DIV + 1) {
			// 以容器真实像素尺寸作为 viewBox，保证坐标与像素 1:1，
			// 不再用 preserveAspectRatio="none" 拉伸导致线宽变形。
			chart.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
			parts.grid.textContent = '';
			parts.yaxis.textContent = '';
			this.yLabels = [];
			for (let i = 0; i <= DIV; i++) {
				const gy = padT + (innerH * i) / DIV;
				parts.grid.appendChild(svg('line', {
					x1: String(padL),
					x2: String(padL + innerW),
					y1: gy.toFixed(1),
					y2: gy.toFixed(1)
				}));
				const label = svg('text', { x: String(padL - 8), y: (gy + 4).toFixed(1), 'text-anchor': 'end' }, []);
				parts.yaxis.appendChild(label);
				this.yLabels.push(label);
			}
			this.lastW = w;
			this.lastH = h;
		}
		for (let i = 0; i <= DIV; i++)
			this.yLabels[i].textContent = fmtRate(max * (1 - i / DIV));

		const count = samples.length;
		const xAt = (i) => padL + innerW - (count - 1 - i) * step;
		const yAt = (v) => padT + innerH * (1 - Math.min(v, max) / max);
		const y0 = padT + innerH;

		function series(key) {
			if (!count)
				return { line: '', fill: '' };
			const pts = samples.map((s, i) => xAt(i).toFixed(1) + ',' + yAt(s[key]).toFixed(1));
			const line = pts.join(' ');
			let fill = '';
			if (count > 1)
				fill = 'M' + xAt(0).toFixed(1) + ',' + y0.toFixed(1) +
					' L' + pts.join(' L') +
					' L' + xAt(count - 1).toFixed(1) + ',' + y0.toFixed(1) + ' Z';
			return { line, fill };
		}

		const rx = series('rx');
		const tx = series('tx');
		parts.lineRx.setAttribute('points', rx.line);
		parts.lineTx.setAttribute('points', tx.line);
		parts.fillRx.setAttribute('d', rx.fill);
		parts.fillTx.setAttribute('d', tx.fill);

		this.geom = { padL, padT, innerW, innerH, step, max, count };

		// 数据滑动后，若鼠标仍停留在图上，按新坐标重新定位十字线/提示框。
		if (this.hoverClientX != null) {
			const rect = chart.getBoundingClientRect();
			this.positionHover(this.hoverClientX - rect.left);
		} else {
			this.hideHover();
		}
	},

	onChartHover(ev) {
		const chart = this.chartEl;
		if (!chart)
			return;
		this.hoverClientX = ev.clientX;
		const rect = chart.getBoundingClientRect();
		this.positionHover(ev.clientX - rect.left);
	},

	positionHover(localX) {
		const chart = this.chartEl;
		const tip = this.tipEl;
		const g = this.geom;
		if (!chart || !tip || !g || !g.count) {
			this.hideHover();
			return;
		}
		const samples = this.history;
		const { padL, padT, innerW, innerH, step, max, count } = g;

		let i;
		if (count === 1)
			i = 0;
		else
			i = Math.round(count - 1 - (padL + innerW - localX) / step);
		i = Math.max(0, Math.min(count - 1, i));

		const s = samples[i] || { rx: 0, tx: 0, t: Date.now() };
		const xi = padL + innerW - (count - 1 - i) * step;
		const yRx = padT + innerH * (1 - Math.min(s.rx, max) / max);
		const yTx = padT + innerH * (1 - Math.min(s.tx, max) / max);

		const hover = chart.querySelector('g.hover');
		hover.style.display = '';
		const cross = hover.querySelector('line.cross');
		cross.setAttribute('x1', xi.toFixed(1));
		cross.setAttribute('x2', xi.toFixed(1));
		cross.setAttribute('y1', String(padT));
		cross.setAttribute('y2', (padT + innerH).toFixed(1));
		const dotRx = hover.querySelector('circle.dot.rx');
		dotRx.setAttribute('cx', xi.toFixed(1));
		dotRx.setAttribute('cy', yRx.toFixed(1));
		const dotTx = hover.querySelector('circle.dot.tx');
		dotTx.setAttribute('cx', xi.toFixed(1));
		dotTx.setAttribute('cy', yTx.toFixed(1));

		tip.style.display = '';
		tip.textContent = '';
		tip.appendChild(E('div', { 'class': 'tip-t' }, new Date(s.t || Date.now()).toLocaleTimeString()));
		tip.appendChild(E('div', { 'class': 'tip-row rx' }, [
			E('span', { 'class': 'dot' }), _('Download') + ': ' + fmtRate(s.rx)
		]));
		tip.appendChild(E('div', { 'class': 'tip-row tx' }, [
			E('span', { 'class': 'dot' }), _('Upload') + ': ' + fmtRate(s.tx)
		]));

		const cw = chart.clientWidth || (padL + innerW + 12);
		const tw = tip.offsetWidth || 150;
		let left = xi + 14;
		if (left + tw > cw - 4)
			left = xi - tw - 14;
		if (left < 4)
			left = 4;
		tip.style.left = left.toFixed(0) + 'px';
		tip.style.top = (padT + 6) + 'px';
	},

	hideHover() {
		this.hoverClientX = null;
		const chart = this.chartEl || (this.dash && this.dash.querySelector('.round-dash-svg'));
		const tip = this.tipEl || (this.dash && this.dash.querySelector('.round-dash-tip'));
		const hover = chart && chart.querySelector('g.hover');
		if (hover)
			hover.style.display = 'none';
		if (tip)
			tip.style.display = 'none';
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

	tick() {
		return this.refresh().catch((e) => console.error('round-dashboard', e));
	},

	async refresh() {
		const now = Date.now();
		// network 模块默认命中缓存，WAN/LAN/WiFi 状态不会自行刷新；每帧先
		// flushCache，否则概览数据首屏后冻结（对齐官方 status/index.js）。
		if (network && typeof network.flushCache === 'function')
			await L.resolveDefault(network.flushCache(), null);
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
		this.history.push({ t: now, rx: rxRate, tx: txRate });
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
