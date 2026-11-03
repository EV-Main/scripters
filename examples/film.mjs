// Films a walk through a built script for the README: `node film.mjs <script.html> <out.webp>`.
// Needs `chromium` and `img2webp` on PATH; `nix run .#film` provides both and pins the fonts.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [html, out] = process.argv.slice(2);
if (!html || !out) throw new Error('usage: film.mjs <script.html> <out.webp>');
const W = 1280, H = 720;
const SETTLE_MS = 1200; // view.js reveals 400ms after a click, then scrolls smoothly
const dir = mkdtempSync(join(tmpdir(), 'film-'));

const browser = spawn('chromium', ['--headless', '--disable-gpu', '--hide-scrollbars', '--disable-smooth-scrolling', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${join(dir, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const port = await new Promise((ok, fail) => {
	let err = '';
	browser.stderr.on('data', d => {
		err += d;
		const m = err.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
		if (m) ok(m[1]);
	});
	browser.on('exit', code => fail(new Error(`chromium exited with ${code} before listening:\n${err}`)));
});
const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(ok => ws.addEventListener('open', ok, { once: true }));
let nextId = 0;
const pending = new Map();
const waiters = new Map();
ws.addEventListener('message', ({ data }) => {
	const msg = JSON.parse(data);
	if (msg.id !== undefined) {
		const { ok, fail, method } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? fail(new Error(`${method}: ${msg.error.message}`)) : ok(msg.result);
	} else waiters.get(msg.method)?.(msg.params);
});
const cdp = (method, params = {}) => new Promise((ok, fail) => {
	pending.set(++nextId, { ok, fail, method });
	ws.send(JSON.stringify({ id: nextId, method, params }));
});
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
// wheels `target` fully into view as a caller would; view.js's own reveal can leave it past the edge of a laptop-sized view
const follow = async target => {
	const [dx, dy] = await js(`(() => {
		const e = ${target};
		if (!e || e.closest('#bar')) return [0, 0]; // the bar is fixed
		const r = e.getBoundingClientRect(), top = document.getElementById('bar').offsetHeight, pad = 24;
		const off = (lo, hi, min, max) => (lo >= min && hi <= max ? 0 : (lo + hi) / 2 - (min + max) / 2);
		return [off(r.left, r.right, pad, innerWidth - pad), off(r.top, r.bottom, top + pad, innerHeight - pad)].map(Math.round);
	})()`);
	if (!dx && !dy) return false;
	await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: W / 2, y: H / 2, deltaX: dx, deltaY: dy });
	await sleep(SETTLE_MS);
	return true;
};
const settle = async () => {
	await sleep(SETTLE_MS);
	await follow(`document.querySelector('#canvas .card.current')`);
};
const js = async expr => {
	const { result, exceptionDetails } = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true });
	if (exceptionDetails) throw new Error(`${expr}\n${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
	return result.value;
};

await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
const loaded = new Promise(ok => waiters.set('Page.loadEventFired', ok));
await cdp('Page.navigate', { url: `file://${resolve(html)}` });
await loaded;
await js(`(() => {
	const c = document.createElement('div');
	c.id = 'film-cursor';
	c.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M3 2l17 11-7.5 1.2L8.5 21z" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/></svg>';
	Object.assign(c.style, { position: 'fixed', left: '-40px', top: '-40px', zIndex: 2147483647, pointerEvents: 'none' });
	document.body.append(c);
	const s = document.createElement('style');
	s.textContent = 'textarea { caret-color: transparent; }'; // a blinking caret makes frames depend on timing
	document.head.append(s);
	for (const f of ['scrollBy', 'scrollTo']) { // a frame caught mid smooth-scroll depends on timing too
		const orig = window[f];
		window[f] = o => orig.call(window, { ...o, behavior: 'instant' });
	}
})()`);

const frames = [];
const shot = async ms => {
	const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
	const f = join(dir, `${String(frames.length).padStart(3, '0')}.png`);
	writeFileSync(f, Buffer.from(data, 'base64'));
	frames.push(['-d', String(ms), f]);
};
const unique = (what, query) => `(() => {
	const all = ${query};
	if (all.length !== 1) throw new Error(${JSON.stringify(what)} + ': ' + all.length + ' matches');
	return all[0];
})()`;
const label = text => unique(`response "${text}"`, `[...document.querySelectorAll('#canvas button.label')].filter(b => b.textContent === ${JSON.stringify(text)})`);
const card = title => unique(`card "${title}"`, `[...document.querySelectorAll('#canvas article.card')].filter(c => c.querySelector('h2')?.textContent === ${JSON.stringify(title)})`);
const dim = name => unique(`dim "${name}"`, `[...document.querySelectorAll('#bar label.dim')].filter(l => l.firstChild.textContent.trim() === ${JSON.stringify(name)}).map(l => l.querySelector('select'))`);
const point = async (target, part = 'e') => {
	const at = () => js(`(() => {
		const e = ${target};
		const r = (${part}).getBoundingClientRect();
		return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
	})()`);
	if (await follow(target)) await shot(900);
	const [x, y] = await at();
	if (!(x > 0 && x < W && y > 0 && y < H)) throw new Error(`${target} is off-screen at ${x},${y} after scrolling to it`);
	await js(`Object.assign(document.getElementById('film-cursor').style, { left: '${x - 3}px', top: '${y - 2}px' })`);
	await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
	return [x, y];
};
const click = async ([x, y], clickCount = 1) => {
	await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
	await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount });
};
const respond = async text => {
	const at = await point(label(text));
	await shot(700);
	await click(at);
	await settle();
	await shot(1300);
};
const pick = async (name, value) => {
	await point(dim(name));
	await js(`(() => { const s = ${dim(name)}; s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); })()`);
	await sleep(SETTLE_MS);
};

await point(card('Introduction'), "e.querySelector('h2')"); // view.js opens on the top-left corner, which the entry card need not be in
await shot(1800);
await pick('opener', 'warm');
await pick('offer', 'demo');
const intro = await point(card('Introduction'), "e.querySelector('h2')");
await shot(700);
await click(intro);
await settle();
await shot(1300);
for (const r of ['Has a minute', 'Yes, it happens', 'We call back manually', 'Too expensive', 'Okay, that makes sense', "No, that's it", 'Books a slot']) await respond(r);

const booked = await point(card('Booked'), "e.querySelector('.body')");
await click(booked, 1);
await click(booked, 2);
await sleep(SETTLE_MS);
await shot(1300);
await cdp('Input.insertText', { text: '\n\n> Log the slot in the CRM before hanging up.' });
await js(`document.querySelector('#canvas textarea').dispatchEvent(new Event('input'))`);
await shot(1600);
await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 });
await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 });
await sleep(SETTLE_MS);
await shot(2000);
ws.close();
await new Promise(ok => {
	browser.on('exit', ok);
	browser.kill();
});
const enc = spawnSync('img2webp', ['-loop', '0', '-lossless', '-m', '6', ...frames.flat(), '-o', out], { stdio: 'inherit' });
if (enc.status !== 0) throw new Error(`img2webp exited with ${enc.status}`);
rmSync(dir, { recursive: true });
