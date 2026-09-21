/**
 * One process: the built page, the scrub and reel endpoints, and the socket.
 * Same shape as the Mosaic relay — single origin, no second service, nothing to
 * keep in step across a network boundary.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { Store, MONTHS, MONTH_S } from './store.js'
import { PALETTE, COOLDOWN_S, YEAR_S, inBounds } from '../shared/patina.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
// 4323, because Mosaic's relay already has 4322 on the same box.
const PORT = Number(process.env.PORT ?? 4323)
const DATA = process.env.PATINA_DATA ?? path.join(ROOT, 'data')

const store = new Store(DATA)

const TYPES = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
	'.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon',
	'.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8',
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, 'http://x')

	if (url.pathname === '/health') return send(res, 200, 'text/plain', 'ok')

	// The canvas at a moment. `t` is seconds since the epoch, clamped into the
	// year — a hand-typed value out of range should give you January or today,
	// not a 500.
	if (url.pathname === '/at') {
		const t = clampTime(Number(url.searchParams.get('t')))
		return sendBuf(res, store.snapshot(store.at(t), t, 0x02))
	}

	// The year as playable frames. The frame count is capped because each one
	// costs a bucket of Map allocations server-side.
	if (url.pathname === '/reel') {
		const from = clampTime(Number(url.searchParams.get('from') ?? 0))
		const to = Math.max(from + 1, clampTime(Number(url.searchParams.get('to') ?? store.now())))
		const frames = Math.max(2, Math.min(600, Number(url.searchParams.get('frames')) || 240))
		return sendBuf(res, store.reel(from, to, frames))
	}

	return serveStatic(url.pathname, res)
})

const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: true })

/** ip → unix seconds the next placement is allowed. */
const cooldowns = new Map()

wss.on('connection', (ws, req) => {
	ws.binaryType = 'nodebuffer'
	ws.ip = (req.headers['x-forwarded-for']?.split(',')[0] ?? req.socket.remoteAddress ?? '?').trim()

	ws.send(store.snapshot(store.live, store.now(), 0x01))
	broadcastPresence()

	ws.on('message', (data) => {
		// Everything past this point came off the wire. Length, opcode, bounds
		// and palette index all get checked before anything touches the log —
		// the log is append-only and a year long, so a bad record is forever.
		if (!Buffer.isBuffer(data) || data.length < 6 || data[0] !== 0x10) return

		const x = data.readUInt16LE(1)
		const y = data.readUInt16LE(3)
		const idx = data[5]
		if (!inBounds(x, y) || idx >= PALETTE.length) return

		const wall = Math.floor(Date.now() / 1000)
		const readyAt = cooldowns.get(ws.ip) ?? 0
		if (readyAt > wall) return sendCooldown(ws, readyAt - wall)

		const t = store.now()
		if (t >= YEAR_S) return // the year is over; the canvas is what it is

		store.append(x, y, PALETTE[idx], t)
		cooldowns.set(ws.ip, wall + COOLDOWN_S)
		sendCooldown(ws, COOLDOWN_S)

		const delta = Buffer.alloc(12)
		delta[0] = 0x03
		delta.writeUInt32LE(t, 1)
		delta.writeUInt16LE(x, 5)
		delta.writeUInt16LE(y, 7)
		delta[9] = PALETTE[idx][0]; delta[10] = PALETTE[idx][1]; delta[11] = PALETTE[idx][2]
		for (const peer of wss.clients) if (peer.readyState === 1) peer.send(delta)
	})

	ws.on('close', broadcastPresence)
})

// Seconds remaining, not an absolute time: a client whose clock is off by a
// minute would otherwise show a cooldown that never expires, or none at all.
function sendCooldown(ws, seconds) {
	const b = Buffer.alloc(5)
	b[0] = 0x05
	b.writeUInt32LE(seconds, 1)
	ws.send(b)
}

function broadcastPresence() {
	const b = Buffer.alloc(3)
	b[0] = 0x06
	b.writeUInt16LE(Math.min(wss.clients.size, 0xffff), 1)
	for (const peer of wss.clients) if (peer.readyState === 1) peer.send(b)
}

// A socket that dies without a FIN leaves a client in the presence count for
// good. Ping every 30s and drop anything that missed the last one.
setInterval(() => {
	for (const ws of wss.clients) {
		if (ws.alive === false) { ws.terminate(); continue }
		ws.alive = false
		ws.ping()
	}
}, 30_000).unref()
wss.on('connection', (ws) => { ws.alive = true; ws.on('pong', () => { ws.alive = true }) })

const clampTime = (t) => (Number.isFinite(t) ? Math.max(0, Math.min(Math.floor(t), store.now())) : store.now())

function send(res, code, type, body) {
	res.writeHead(code, { 'content-type': type })
	res.end(body)
}

function sendBuf(res, buf) {
	res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' })
	res.end(buf)
}

function serveStatic(pathname, res) {
	const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
	const file = path.join(DIST, rel)
	// Resolve first, then check the prefix — `/../` in a request must not walk
	// out of dist/.
	if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
		const index = path.join(DIST, 'index.html')
		if (!fs.existsSync(index)) return send(res, 404, 'text/plain', 'not built — run npm run build')
		return sendHtml(res, index)
	}
	if (file.endsWith('.html')) return sendHtml(res, file)

	const ext = path.extname(file)
	res.writeHead(200, {
		'content-type': TYPES[ext] ?? 'application/octet-stream',
		// Astro hashes asset filenames, so everything under _astro is safe to
		// pin forever. Anything else gets a day.
		'cache-control': file.includes('_astro') ? 'public, max-age=31536000, immutable' : 'public, max-age=86400',
	})
	fs.createReadStream(file).pipe(res)
}

function sendHtml(res, file) {
	res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' })
	fs.createReadStream(file).pipe(res)
}

server.listen(PORT, () => {
	const day = Math.floor(store.now() / 86400)
	console.log(`patina :${PORT} — day ${day} of 365, ${store.count} placements, ${MONTHS} months of ${MONTH_S}s`)
})

for (const sig of ['SIGTERM', 'SIGINT']) {
	process.on(sig, () => {
		// The log is written synchronously on every placement, so there is
		// nothing to flush — just close cleanly so a redeploy doesn't reset
		// everyone's socket the hard way.
		for (const ws of wss.clients) ws.close(1001, 'restarting')
		store.close()
		server.close(() => process.exit(0))
		setTimeout(() => process.exit(0), 2000).unref()
	})
}
