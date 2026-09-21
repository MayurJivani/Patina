/**
 * The page. Decodes the socket, folds the reel, and draws — all of it against
 * the same `shared/patina.js` the relay folds its log with, so a scrubbed month
 * on a phone and the live canvas on a laptop are the same arithmetic.
 */
import {
	W, H, YEAR_S,
	place, renderView, hardness, blank, bake, at as slotAt,
} from '../../shared/patina.js'

const $ = (id) => document.getElementById(id)

const stage = $('stage')
const ctx = stage.getContext('2d', { alpha: false })

// There is no bitmap of the board anywhere — 4096² of RGBA is 67 MB. The
// renderer stamps painted cells straight into a screen-sized buffer instead.
let screen = null
let dpr = 1

const view = { scale: 1, x: 0, y: 0 }
let state = blank()
let at = 0            // the moment currently on screen, seconds since epoch
let serverNow = 0     // how far into the year the canvas actually is
let mode = 'weathered'
let colour = 2
let scrubbing = false
let playing = false
// Whether the view is pinned to the present. Derived state ("at >= serverNow")
// reads fine but is wrong before the first snapshot arrives, when `at` is 0 and
// the year is nearly over — the canvas would open on an empty January.
let following = true
let framed = false   // the opening view is chosen once, from the first canvas we see
let cooldownUntil = 0 // performance.now() ms — local, never the server's clock

// ─── drawing ────────────────────────────────────────────────────────────────

function paint() {
	const vw = stage.width
	const vh = stage.height

	// Cheap when already current; the alternative is recomputing a quarter of a
	// million cells' worth of oxidation on every pan.
	if (state.bakedAt !== at) bake(state, at)

	// The cell buffer is device-pixel space, so the view is scaled up to match
	// and putImageData lands 1:1. Overlays below go back to CSS pixels.
	ctx.setTransform(1, 0, 0, 1, 0, 0)
	renderView(
		state, at, mode,
		{ scale: view.scale * dpr, x: view.x * dpr, y: view.y * dpr },
		screen.data, vw, vh,
	)
	ctx.putImageData(screen, 0, 0)
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

	// Cell gridlines, but only once a cell is big enough that they read as a
	// drafting grid instead of a grey wash — and only across the visible span,
	// because there are four thousand of them each way.
	if (view.scale >= 6) {
		const cw = vw / dpr
		const ch = vh / dpr
		const i0 = Math.max(0, Math.floor(-view.x / view.scale))
		const i1 = Math.min(W, Math.ceil((cw - view.x) / view.scale))
		const j0 = Math.max(0, Math.floor(-view.y / view.scale))
		const j1 = Math.min(H, Math.ceil((ch - view.y) / view.scale))

		ctx.strokeStyle = 'rgba(120,179,255,0.10)'
		ctx.lineWidth = 1
		ctx.beginPath()
		for (let i = i0; i <= i1; i++) {
			const x = Math.round(view.x + i * view.scale) + 0.5
			ctx.moveTo(x, Math.max(0, view.y)); ctx.lineTo(x, Math.min(ch, view.y + H * view.scale))
		}
		for (let j = j0; j <= j1; j++) {
			const y = Math.round(view.y + j * view.scale) + 0.5
			ctx.moveTo(Math.max(0, view.x), y); ctx.lineTo(Math.min(cw, view.x + W * view.scale), y)
		}
		ctx.stroke()
	}

	// The board edge, drawn like a sheet on a table.
	ctx.strokeStyle = 'rgba(120,179,255,0.32)'
	ctx.lineWidth = 1
	ctx.strokeRect(view.x - 0.5, view.y - 0.5, W * view.scale + 1, H * view.scale + 1)

	if (hover && live()) {
		ctx.strokeStyle = '#eef4fb'
		ctx.lineWidth = 2
		ctx.strokeRect(view.x + hover.x * view.scale, view.y + hover.y * view.scale, view.scale, view.scale)
	}
}

let queued = false
function draw() {
	if (queued) return
	queued = true
	requestAnimationFrame(() => { queued = false; paint() })
}

function resize() {
	dpr = Math.min(window.devicePixelRatio || 1, 2)
	stage.width = Math.round(innerWidth * dpr)
	stage.height = Math.round(innerHeight * dpr)
	screen = ctx.createImageData(stage.width, stage.height)
	draw()
}

/** Frame a region of the board, in cell coordinates. */
function frame(x0, y0, x1, y1) {
	const pad = 120
	// No Math.floor on the scale: fitting 4096 cells into a laptop is well under
	// one pixel per cell, and rounding down collapses the board to nothing.
	view.scale = Math.min((innerWidth - pad) / (x1 - x0), (innerHeight - pad * 2) / (y1 - y0))
	view.x = (innerWidth - (x1 - x0) * view.scale) / 2 - x0 * view.scale
	view.y = (innerHeight - (y1 - y0) * view.scale) / 2 - y0 * view.scale
}

/** The whole sheet. */
const fit = () => frame(0, 0, W, H)

/**
 * Where the paint is. On a board this size the painted region is a small island
 * in a lot of empty sheet, and opening on the whole thing shows a rounding
 * error in the middle of a dark rectangle. Open on the work instead, squared up
 * so the aspect isn't distorted, and leave `f` to pull back to the full board.
 */
function frameContent(s) {
	if (s.n === 0) return fit()
	let x0 = W, y0 = H, x1 = 0, y1 = 0
	for (let slot = 0; slot < s.n; slot++) {
		const cell = s.cells[slot]
		const cx = cell % W
		const cy = (cell - cx) / W
		if (cx < x0) x0 = cx
		if (cx > x1) x1 = cx
		if (cy < y0) y0 = cy
		if (cy > y1) y1 = cy
	}
	const m = Math.max(x1 - x0, y1 - y0) * 0.6 + 24
	const cx = (x0 + x1) / 2
	const cy = (y0 + y1) / 2
	frame(Math.max(0, cx - m), Math.max(0, cy - m), Math.min(W, cx + m), Math.min(H, cy + m))
}

// ─── the socket ─────────────────────────────────────────────────────────────

let ws
let backoff = 500

function connect() {
	ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
	ws.binaryType = 'arraybuffer'

	ws.onopen = () => { backoff = 500 }

	ws.onmessage = (ev) => {
		const buf = ev.data
		const view8 = new Uint8Array(buf)
		const dv = new DataView(buf)

		switch (view8[0]) {
			case 0x01: { // full canvas
				const s = decode(buf)
				serverNow = s.now
				state = s.state
				if (following) at = serverNow
				if (!framed) { framed = true; frameContent(state) }
				$('painted').style.width = `${(serverNow / YEAR_S) * 100}%`
				syncHead()
				draw()
				break
			}
			case 0x03: { // one placement
				const t = dv.getUint32(1, true)
				const x = dv.getUint16(5, true)
				const y = dv.getUint16(7, true)
				serverNow = Math.max(serverNow, t)
				// Only the live view moves. If you are looking at March, someone
				// painting now must not reach in and change what March looked like.
				if (live() && !playing) {
					place(state, x, y, [view8[9], view8[10], view8[11]], t)
					at = serverNow
					// One cell changed and the clock moved a second; re-baking
					// the whole canvas for that would stall a busy board.
					bake(state, at, [slotAt(state, x, y)])
					draw()
				}
				break
			}
			case 0x05: // cooldown, in seconds remaining
				cooldownUntil = performance.now() + dv.getUint32(1, true) * 1000
				break
			case 0x06: { // how many people are here
				const n = dv.getUint16(1, true)
				$('presence').textContent = `${n} ${n === 1 ? 'painter' : 'painters'} · day ${Math.floor(serverNow / 86400)} of 365`
				break
			}
		}
	}

	ws.onclose = () => {
		$('presence').textContent = 'reconnecting'
		// Backing off to 8s rather than hammering: a relay restart brings a few
		// hundred sockets back at once and they all send a 196 KB snapshot.
		setTimeout(connect, backoff)
		backoff = Math.min(backoff * 2, 8000)
	}
}

/**
 * Wraps the snapshot's arrays in place — no copy, which is why the header is
 * 24 bytes and the u32 ranges come first. Rebuilds the cell→slot index, which
 * is the one thing not worth putting on the wire: it is derivable, and a Map
 * does not serialise.
 */
function decode(buf) {
	const dv = new DataView(buf)
	const n = dv.getUint32(16, true)

	let o = 24
	const cells = new Uint32Array(buf, o, n); o += n * 4
	const touched = new Uint32Array(buf, o, n); o += n * 4
	const layers = new Uint16Array(buf, o, n); o += n * 2
	const base = new Uint8Array(buf, o, n * 3); o += n * 3
	const pristine = new Uint8Array(buf, o, n * 3)

	const index = new Map()
	for (let i = 0; i < n; i++) index.set(cells[i], i)

	return {
		now: dv.getUint32(4, true),
		at: dv.getUint32(12, true),
		// cap === n means the next placement grows the arrays, which is correct:
		// these are views onto the socket's buffer and must not be written past.
		state: { index, cells, base, pristine, touched, layers, n, cap: n },
	}
}

// ─── placing ────────────────────────────────────────────────────────────────

const live = () => following && !playing

function cellAt(px, py) {
	const x = Math.floor((px - view.x) / view.scale)
	const y = Math.floor((py - view.y) / view.scale)
	return x >= 0 && y >= 0 && x < W && y < H ? { x, y } : null
}

function put(cell) {
	if (!cell || !live() || ws?.readyState !== 1) return
	if (performance.now() < cooldownUntil) return

	const b = new Uint8Array(6)
	b[0] = 0x10
	new DataView(b.buffer).setUint16(1, cell.x, true)
	new DataView(b.buffer).setUint16(3, cell.y, true)
	b[5] = colour
	ws.send(b)
	// Optimism would be wrong here: how much of the colour lands depends on the
	// cure clock the server holds, so the echo is the only honest answer. It is
	// one round trip, and the cooldown is twenty seconds.
}

setInterval(() => {
	const left = Math.ceil((cooldownUntil - performance.now()) / 1000)
	$('cooldown').textContent = left > 0 ? `next in ${left}s` : ''
	document.body.classList.toggle('waiting', left > 0)
}, 200)

// ─── pointer: pan, zoom, paint, hover ───────────────────────────────────────

let hover = null
let drag = null
let moved = 0

stage.addEventListener('pointerdown', (e) => {
	stage.setPointerCapture(e.pointerId)
	drag = { x: e.clientX, y: e.clientY }
	moved = 0
})

stage.addEventListener('pointermove', (e) => {
	if (drag) {
		const dx = e.clientX - drag.x
		const dy = e.clientY - drag.y
		moved += Math.abs(dx) + Math.abs(dy)
		view.x += dx
		view.y += dy
		drag = { x: e.clientX, y: e.clientY }
		draw()
		return
	}
	hover = cellAt(e.clientX, e.clientY)
	readout()
	draw()
})

stage.addEventListener('pointerup', (e) => {
	// A drag that barely moved was a click. 6px of slop, because a finger never
	// lands perfectly still and every tap would otherwise pan instead of paint.
	if (drag && moved < 6) put(cellAt(e.clientX, e.clientY))
	drag = null
})

stage.addEventListener('pointerleave', () => { drag = null; hover = null; $('readout').hidden = true; draw() })

stage.addEventListener('wheel', (e) => {
	e.preventDefault()
	const k = Math.exp(-e.deltaY * 0.0015)
	// Floor is "the whole board, a little smaller" rather than 1 — at 4096 wide
	// a scale of 1 is already twelve screens across, so clamping there would
	// mean never being able to see the thing.
	const floor = Math.min((innerWidth - 96) / W, (innerHeight - 192) / H) * 0.8
	const next = Math.min(48, Math.max(floor, view.scale * k))
	// Zoom about the cursor, not the origin, or the cell you are aiming at
	// walks off the screen.
	view.x = e.clientX - (e.clientX - view.x) * (next / view.scale)
	view.y = e.clientY - (e.clientY - view.y) * (next / view.scale)
	view.scale = next
	draw()
}, { passive: false })

function readout() {
	const panel = $('readout')
	if (!hover) { panel.hidden = true; return }
	panel.hidden = false

	const i = slotAt(state, hover.x, hover.y)
	const n = i < 0 ? 0 : state.layers[i]
	$('r-cell').textContent = `${hover.x}, ${hover.y}`
	$('r-layers').textContent = n === 0 ? 'bare' : `${n}`

	if (n === 0) {
		$('r-cured').textContent = '—'
		$('r-age').textContent = 'never painted'
		$('r-bar').style.width = '0%'
		return
	}
	const h = hardness(state.touched[i], at)
	$('r-cured').textContent = `${Math.round(h * 100)}%`
	$('r-age').textContent = ago(at - state.touched[i])
	$('r-bar').style.width = `${h * 100}%`
}

function ago(s) {
	if (s < 90) return `${Math.max(0, Math.round(s))}s ago`
	if (s < 5400) return `${Math.round(s / 60)}m ago`
	if (s < 172800) return `${Math.round(s / 3600)}h ago`
	return `${Math.round(s / 86400)}d ago`
}

// ─── the two readings ───────────────────────────────────────────────────────

const NOTE = {
	weathered: 'what time did to it',
	pristine: 'what the painters meant',
}

for (const b of document.querySelectorAll('.mode')) {
	b.addEventListener('click', () => {
		mode = b.dataset.mode
		for (const o of document.querySelectorAll('.mode')) o.classList.toggle('is-on', o === b)
		$('mode-note').textContent = NOTE[mode]
		draw()
	})
}

for (const s of document.querySelectorAll('.swatch')) {
	s.addEventListener('click', () => {
		colour = Number(s.dataset.i)
		for (const o of document.querySelectorAll('.swatch')) o.classList.toggle('is-on', o === s)
	})
}
document.querySelector('.swatch[data-i="2"]').classList.add('is-on')

// ─── the year ───────────────────────────────────────────────────────────────

const track = $('track')

function syncHead() {
	const f = serverNow > 0 ? at / YEAR_S : 0
	$('head').style.left = `${f * 100}%`
	$('stamp').textContent = `day ${Math.floor(at / 86400)}`
	$('live').classList.toggle('is-on', live())
	track.setAttribute('aria-valuenow', String(Math.floor(at / 86400)))
	track.setAttribute('aria-valuetext', `day ${Math.floor(at / 86400)} of 365`)
}

/** Ask the relay for the canvas as it stood, and show that. */
let pending = 0
async function seek(t) {
	at = Math.max(0, Math.min(Math.round(t), serverNow))
	// Scrubbing to the far right is how you get back to the present, so the
	// last few seconds of the year count as live.
	following = at >= serverNow - 1
	syncHead()
	const ticket = ++pending
	const res = await fetch(`/at?t=${at}`)
	const buf = await res.arrayBuffer()
	// Drags fire faster than the network answers; only the newest reply counts.
	if (ticket !== pending) return
	const s = decode(buf)
	state = s.state
	serverNow = s.now
	readout()
	draw()
}

function trackTime(clientX) {
	const r = track.getBoundingClientRect()
	return ((clientX - r.left) / r.width) * YEAR_S
}

track.addEventListener('pointerdown', (e) => {
	track.setPointerCapture(e.pointerId)
	scrubbing = true
	stop()
	seek(trackTime(e.clientX))
})
track.addEventListener('pointermove', (e) => { if (scrubbing) seek(trackTime(e.clientX)) })
track.addEventListener('pointerup', () => { scrubbing = false })

track.addEventListener('keydown', (e) => {
	const step = e.shiftKey ? YEAR_S / 12 : 86400
	if (e.key === 'ArrowLeft') { stop(); seek(at - step); e.preventDefault() }
	if (e.key === 'ArrowRight') { stop(); seek(at + step); e.preventDefault() }
})

$('live').addEventListener('click', () => { stop(); seek(YEAR_S) })

// ─── playback ───────────────────────────────────────────────────────────────

/**
 * The reel is a keyframe of nothing plus one bucket of placements per frame,
 * folded here with the same `place()` the relay uses. Downloading 240 finished
 * canvases would be 47 MB; this is a few hundred KB and it replays in both
 * modes without a second request.
 */
const FRAMES = 240
let reel = null
let timer = null

async function play() {
	if (playing) return stop()
	$('play').textContent = '…'

	if (!reel || reel.to < serverNow - 3600) {
		const res = await fetch(`/reel?from=0&to=${serverNow}&frames=${FRAMES}`)
		reel = parseReel(await res.arrayBuffer())
	}

	playing = true
	following = false
	$('play').textContent = '■'
	$('live').classList.remove('is-on')
	state = blank()
	let f = 0

	// 24fps of wall clock, ~15 days of canvas per frame. Fast enough to feel
	// like footage, slow enough to watch a region get taken.
	timer = setInterval(() => {
		if (f >= reel.frames.length) return stop(true)
		at = reel.from + ((f + 1) / reel.frames.length) * (reel.to - reel.from)
		const touched = []
		for (const p of reel.frames[f]) {
			place(state, p.x, p.y, p.c, p.t)
			touched.push(slotAt(state, p.x, p.y))
		}
		// Every sixteenth frame goes wide, so a whole year of accumulated fade
		// and oxidation on cells nobody is repainting still lands on screen.
		bake(state, at, f % 16 === 0 ? null : touched)
		f++
		syncHead()
		draw()
	}, 1000 / 24)
}

function stop(finished = false) {
	clearInterval(timer)
	if (!playing) return
	playing = false
	$('play').textContent = '▶'
	// Landing on the live canvas at the end is the right ending; a manual stop
	// should leave you where you paused.
	if (finished) seek(YEAR_S)
	else syncHead()
}

function parseReel(buf) {
	const dv = new DataView(buf)
	const from = dv.getUint32(1, true)
	const to = dv.getUint32(5, true)
	const n = dv.getUint16(9, true)
	let o = 11
	const frames = []
	const span = Math.max(1, to - from)
	for (let f = 0; f < n; f++) {
		const count = dv.getUint32(o, true); o += 4
		const out = []
		// Every placement in a bucket is stamped with the bucket's end, which is
		// what keeps the cure clock advancing during playback — without it the
		// whole reel would fold as one instant of wet paint.
		const t = from + ((f + 1) / n) * span
		for (let i = 0; i < count; i++) {
			out.push({
				x: dv.getUint16(o, true),
				y: dv.getUint16(o + 2, true),
				c: [dv.getUint8(o + 4), dv.getUint8(o + 5), dv.getUint8(o + 6)],
				t,
			})
			o += 8
		}
		frames.push(out)
	}
	return { from, to, frames }
}

$('play').addEventListener('click', play)

document.addEventListener('keydown', (e) => {
	if (e.target !== document.body) return
	if (e.key === ' ') { e.preventDefault(); play() }
	if (e.key === 'f') { frameContent(state); draw() }
	if (e.key === 'F') { fit(); draw() }
	if (e.key === 'p' || e.key === 'w') {
		document.querySelector(`.mode[data-mode="${mode === 'pristine' ? 'weathered' : 'pristine'}"]`).click()
	}
})

addEventListener('resize', resize)
resize()
fit()      // something sane on screen until the first snapshot lands
connect()
