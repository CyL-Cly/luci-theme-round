// Copyright 2026 luci-theme-round maintainers
// Licensed to the public under the Apache License 2.0.
//
// uhttpd ucode_prefix handler: serves luci-theme-round static assets with
// long-lived Cache-Control headers so browsers can strongly cache them.
//
// Registered prefixes (see /etc/uci-defaults/30_luci-theme-round):
//   /luci-static/round
//   /luci-static/resources/menu-round.js
//   /luci-static/resources/view/round

// uhttpd compiles ucode_prefix handlers in template mode, so the whole
// script must be wrapped in {% %} blocks (like luci's uhttpd.uc) or it
// is treated as literal output and no handle_request() gets defined.
{%

'use strict';

import { readfile, realpath, stat } from 'fs';

const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const S_IFREG = 0x8000;

const MIME_TYPES = {
	'.css': 'text/css',
	'.svg': 'image/svg+xml',
	'.js': 'application/javascript; charset=UTF-8'
};

// URL prefix -> on-disk directory below DOCUMENT_ROOT
const ALLOWED = {
	'/luci-static/round': 'luci-static/round',
	'/luci-static/resources/view/round': 'luci-static/resources/view/round'
};

const SINGLE_FILE = '/luci-static/resources/menu-round.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function send_status(code, msg) {
	uhttpd.send(`Status: ${code} ${msg}\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n`);
}

function http_date(ts) {
	const t = gmtime(ts);

	return sprintf('%s, %02d %s %04d %02d:%02d:%02d GMT',
		WEEKDAYS[t.wday], t.mday, MONTHS[t.mon], t.year + 1900,
		t.hour, t.min, t.sec);
}

global.handle_request = function(env) {
	if (env.REQUEST_METHOD != 'GET' && env.REQUEST_METHOD != 'HEAD') {
		send_status(405, 'Method Not Allowed');
		return;
	}

	const docroot = env.DOCUMENT_ROOT ?? '/www';
	const path = env.PATH_INFO ?? '';
	let phys = null;

	if (path == SINGLE_FILE) {
		phys = `${docroot}${SINGLE_FILE}`;
	}
	else {
		let prefix = null;

		for (let p, dir in ALLOWED) {
			if (substr(path, 0, length(p)) == p) {
				prefix = p;
				phys = `${docroot}/${dir}${substr(path, length(p))}`;
				break;
			}
		}

		if (prefix == null) {
			send_status(404, 'Not Found');
			return;
		}

		const real = realpath(phys);

		// reject path traversal: resolved path must stay inside the
		// canonical allowed directory
		const base = realpath(`${docroot}/${ALLOWED[prefix]}`);

		if (real == null || base == null || substr(real, 0, length(base)) != base) {
			send_status(404, 'Not Found');
			return;
		}

		phys = real;
	}

	const st = stat(phys);

	if (st == null || (st.st_mode & S_IFREG) == 0) {
		send_status(404, 'Not Found');
		return;
	}

	// content type by extension
	const ext = replace(phys, /^.*\.([a-z]+)$/, '$1');
	const ctype = MIME_TYPES[`.${ext}`] ?? 'application/octet-stream';

	const etag = `"${st.st_mtime}-${st.st_size}"`;
	const lastmod = http_date(st.st_mtime);

	// conditional request support: versioned URLs make this redundant for
	// fresh caches, but plain URLs (old bookmarks, manually referenced
	// files) still benefit from it
	const inm = env.headers?.['if-none-match'];
	const ifms = env.headers?.['if-modified-since'];

	if (inm == etag ||
	    (inm == null && ifms != null && index(WEEKDAYS, substr(ifms, 0, 3)) != -1 &&
	     http_date(st.st_mtime) == ifms)) {
		uhttpd.send(`Status: 304 Not Modified\r\nETag: ${etag}\r\nLast-Modified: ${lastmod}\r\nCache-Control: ${CACHE_CONTROL}\r\n\r\n`);
		return;
	}

	const data = readfile(phys);

	if (data == null) {
		send_status(404, 'Not Found');
		return;
	}

	uhttpd.send(`Status: 200 OK\r\nContent-Type: ${ctype}\r\nContent-Length: ${length(data)}\r\nETag: ${etag}\r\nLast-Modified: ${lastmod}\r\nCache-Control: ${CACHE_CONTROL}\r\n\r\n`);

	if (env.REQUEST_METHOD != 'HEAD')
		uhttpd.send(data);
};

%}
