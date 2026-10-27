/**
 * Load test: N painters against a real server process.
 *
 *   node scripts/loadtest.js [painters=1000]
 *
 * Starts its own server on a spare port with a copy of data/ (seed it first for
 * a realistic canvas; the copy's epoch is moved so the year is still open).
 * Every painter connects in waves of 50 with its own forwarded address and
 * waits for the full canvas, then a hundred of them paint at once and every
 * painter times the deltas. Reports connect-to-canvas time, delta fan-out,
 * bytes on the wire and the server's CPU and RSS. Exits non-zero if a painter
 * never gets the canvas or misses a delta.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { YEAR_S } from '../shared/patina.js'

const N = Number(process.argv[2] ?? 1000)
const PAINTERS = Math.min(100, N)
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4700 + Math.floor(Math.random() * 300)

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'patina-load-'))
if (fs.existsSync(path.join(ROOT, 'data', 'events.bin'))) fs.copyFileSync(path.join(ROOT, 'data', 'events.bin'), path.join(data, 'events.bin'))
// A day before the year closes, so placements are still accepted.
fs.writeFileSync(path.join(data, 'meta.json'), JSON.stringify({ epoch: Math.floor(Date.now() / 1000) - YEAR_S + 86_400 }))

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
	env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), PATINA_DATA: data },
	stdio: ['ignore', 'ignore', 'inherit'],
})
process.on('exit', () => server.kill())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; !(await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok, () => false)); i++) {
	if (i > 100) throw new Error('server did not come up')
	await sleep(100)
}

// Server CPU (ms) and RSS (MB) from /proc, so the clients in this process do not count.
const usage = () => {
	const stat = fs.readFileSync(`/proc/${server.pid}/stat`, 'utf8').split(') ')[1].split(' ')
	const rss = Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${server.pid}/status`, 'utf8'))[1]) / 1024
	return { cpu: (Number(stat[11]) + Number(stat[12])) * 10, rss }
}
let peakRss = 0
const sampler = setInterval(() => (peakRss = Math.max(peakRss, usage().rss)), 250)
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? NaN
const fmt = (xs) => `p50 ${pct(xs, 50).toFixed(0)}ms, p95 ${pct(xs, 95).toFixed(0)}ms, max ${Math.max(...xs).toFixed(0)}ms`

const cpu0 = usage().cpu
const t0 = performance.now()
const clients = []
const canvasMs = []
let canvasBytes = 0
let failed = 0
for (let i = 0; i < N; i += 50) {
	await Promise.all(Array.from({ length: Math.min(50, N - i) }, (_, j) => new Promise((resolve) => {
		const s = performance.now()
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { 'x-forwarded-for': `10.0.${(i + j) >> 8}.${(i + j) & 255}` } })
		ws.deltas = 0
		ws.wire = 0
		const t = setTimeout(() => (failed++, resolve()), 60_000)
		ws.on('message', (b) => {
			ws.wire += b.length
			// The canvas comes gzipped (0x1f, gzip's first byte), or raw (0x01) if that failed.
			if (b[0] === 0x1f || b[0] === 0x01) {
				canvasMs.push(performance.now() - s)
				canvasBytes = b.length
				clients.push(ws)
				clearTimeout(t)
				resolve()
			} else if (b[0] === 0x03) ws.onDelta?.()
		})
		ws.on('error', () => (failed++, clearTimeout(t), resolve()))
	})))
}
const joinWall = performance.now() - t0
console.log(`${clients.length}/${N} painters had the canvas (${(canvasBytes / 1048576).toFixed(1)} MB on the wire) in ${(joinWall / 1000).toFixed(1)}s; connect-to-canvas ${fmt(canvasMs)}`)

// A hundred painters place at once; every painter times all hundred deltas.
const s = performance.now()
const fanout = []
await Promise.all(clients.map((ws) => new Promise((resolve) => {
	const t = setTimeout(() => (failed++, resolve()), 15_000)
	ws.onDelta = () => {
		if (++ws.deltas < PAINTERS) return
		fanout.push(performance.now() - s)
		clearTimeout(t)
		resolve()
	}
	const i = clients.indexOf(ws)
	if (i < PAINTERS) ws.send(Buffer.from([0x10, i & 255, i >> 8, 7, 7, 3]))
})))
console.log(`${PAINTERS} placements at once: ${fanout.length}/${clients.length} painters saw all of them, ${fmt(fanout)}`)

const cpu = usage().cpu - cpu0
const wall = performance.now() - t0
clearInterval(sampler)
const wire = clients.map((ws) => ws.wire)
console.log(`server: ${(cpu / 1000).toFixed(1)}s CPU over ${(wall / 1000).toFixed(1)}s (${((cpu / wall) * 100).toFixed(0)}% of one core), peak RSS ${peakRss.toFixed(0)} MB`)
console.log(`received per painter: p50 ${(pct(wire, 50) / 1048576).toFixed(1)} MB`)
for (const ws of clients) ws.terminate()
fs.rmSync(data, { recursive: true, force: true })
console.log(failed ? `FAIL: ${failed} painters missed the canvas or a delta` : 'ok')
process.exit(failed ? 1 : 0)
