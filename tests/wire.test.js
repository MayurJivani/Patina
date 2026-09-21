/**
 * The wire format and the fold, checked against a real log.
 *
 * The client decodes these bytes with hand-written offsets and then folds the
 * reel with the same `place()` the relay used. If either drifts, a scrubbed
 * month quietly stops matching the canvas it claims to show — which is exactly
 * the thing this project is about, so it gets a test.
 *
 * Builds its own log in a temp dir; no server, no sockets, no fixtures.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store, REC } from '../server/store.js'
import { blank, place, bake, renderView, PALETTE, W, H, VOID, YEAR_S } from '../shared/patina.js'

/** A small but structurally realistic year: overlapping claims, repainted cells. */
function seeded(n = 4000) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patina-'))
	const events = []
	for (let i = 0; i < n; i++) {
		const g = i % 3
		// The claimed area widens as the year goes on, so new cells keep
		// appearing instead of the same few being repainted — otherwise the
		// painted-cell count saturates immediately and says nothing about time.
		const reach = 8 + Math.floor((i / n) * 60)
		events.push({
			t: Math.floor((i / n) * (YEAR_S - 10)),
			x: 2000 + (g * 90) + (i * 7) % reach,
			y: 2000 + (i * 13) % reach,
			c: PALETTE[[2, 16, 9][g]],
		})
	}
	const buf = Buffer.alloc(n * REC)
	events.forEach((e, i) => {
		const o = i * REC
		buf.writeUInt32LE(e.t, o)
		buf.writeUInt16LE(e.x, o + 4)
		buf.writeUInt16LE(e.y, o + 6)
		buf[o + 8] = e.c[0]; buf[o + 9] = e.c[1]; buf[o + 10] = e.c[2]
	})
	fs.writeFileSync(path.join(dir, 'events.bin'), buf)
	fs.writeFileSync(path.join(dir, 'meta.json'),
		JSON.stringify({ epoch: Math.floor(Date.now() / 1000) - YEAR_S + 60 }))
	return new Store(dir)
}

/** The client's decoder, transcribed. If this needs editing, so does client.js. */
function decode(buf) {
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
	const dv = new DataView(ab)
	const n = dv.getUint32(16, true)
	let o = 24
	const cells = new Uint32Array(ab, o, n); o += n * 4
	const touched = new Uint32Array(ab, o, n); o += n * 4
	const layers = new Uint16Array(ab, o, n); o += n * 2
	const base = new Uint8Array(ab, o, n * 3); o += n * 3
	const pristine = new Uint8Array(ab, o, n * 3); o += n * 3
	assert.equal(o, ab.byteLength, 'snapshot has no trailing bytes')

	const index = new Map()
	for (let i = 0; i < n; i++) index.set(cells[i], i)
	return {
		op: dv.getUint8(0), now: dv.getUint32(4, true), at: dv.getUint32(12, true),
		w: dv.getUint16(20, true), h: dv.getUint16(22, true),
		state: { index, cells, base, pristine, touched, layers, n, cap: n },
	}
}

test('a snapshot round-trips through the client decoder', () => {
	const store = seeded()
	const s = decode(store.snapshot(store.live, store.now()))

	assert.equal(s.op, 1)
	assert.equal(s.w, W)
	assert.equal(s.h, H)
	assert.equal(s.state.n, store.live.n, 'every painted cell made it across')
	assert.equal(s.state.index.size, s.state.n, 'the index covers every slot')

	// Colours must survive byte-for-byte, or the canvas shifts on reconnect.
	for (let i = 0; i < s.state.n; i++) {
		assert.equal(s.state.cells[i], store.live.cells[i])
		assert.equal(s.state.base[i * 3], store.live.base[i * 3])
		assert.equal(s.state.layers[i], store.live.layers[i])
	}
})

test('the snapshot is over-allocation-safe', () => {
	// `grow()` doubles, so the arrays are longer than n. Shipping the raw
	// buffers instead of the used prefix would send megabytes of zeroes and
	// desynchronise every offset after `cells`.
	const store = seeded(100)
	assert.ok(store.live.cap > store.live.n, 'the test state is genuinely over-allocated')
	assert.equal(store.snapshot(store.live, store.now()).length, 24 + store.live.n * 16)
})

test('scrubbing is monotonic, deterministic, and stops short of the present', () => {
	const store = seeded()
	const counts = [0.1, 0.4, 0.7].map((f) => store.at(Math.floor(store.now() * f)).n)
	assert.ok(counts[0] < counts[1] && counts[1] < counts[2], 'paint only accumulates')
	assert.ok(counts.at(-1) <= store.live.n, 'no month holds more than the present')

	const t = Math.floor(store.now() * 0.5)
	assert.deepEqual(store.snapshot(store.at(t), t), store.snapshot(store.at(t), t), 'the same instant folds the same way twice')
})

test('the reel folds to exactly the canvas it claims to end on', () => {
	const store = seeded()
	const frames = 60
	const buf = store.reel(0, store.now(), frames)

	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
	assert.equal(dv.getUint8(0), 0x04)
	const n = dv.getUint16(9, true)
	assert.equal(n, frames)

	// Fold it the way the client does.
	const st = blank()
	let o = 11
	for (let f = 0; f < n; f++) {
		const count = dv.getUint32(o, true); o += 4
		const t = ((f + 1) / n) * store.now()
		for (let i = 0; i < count; i++) {
			place(st, dv.getUint16(o, true), dv.getUint16(o + 2, true),
				[dv.getUint8(o + 4), dv.getUint8(o + 5), dv.getUint8(o + 6)], t)
			o += 8
		}
	}
	assert.equal(o, buf.byteLength, 'the reel parses with nothing left over')

	// Bucketing drops intermediate placements within a frame, so colours may
	// differ — but every cell that was ever painted must exist, or playback
	// ends on a canvas that isn't the one you were just looking at.
	assert.equal(st.n, store.live.n, 'the reel ends on the same painted cells as live')
	for (let i = 0; i < store.live.n; i++) {
		assert.ok(st.index.has(store.live.cells[i]), `cell ${store.live.cells[i]} survived the reel`)
	}
})

test('the two readings actually differ on screen', () => {
	// The pristine/weathered toggle is the feature. If a calibration change ever
	// makes the gap invisible, this is what catches it.
	const store = seeded(12_000)
	const now = store.now()
	bake(store.live, now)

	const VW = 240, VH = 200
	const view = { scale: 2, x: -3980, y: -3980 }
	const a = new Uint8ClampedArray(VW * VH * 4)
	const b = new Uint8ClampedArray(VW * VH * 4)
	renderView(store.live, now, 'weathered', view, a, VW, VH)
	renderView(store.live, now, 'pristine', view, b, VW, VH)

	let painted = 0, differing = 0
	for (let i = 0; i < a.length; i += 4) {
		if (a[i] === VOID[0] && a[i + 1] === VOID[1] && a[i + 2] === VOID[2]) continue
		painted++
		if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) differing++
	}
	assert.ok(painted > 500, `the test view actually contains paint (${painted}px)`)
	assert.ok(differing / painted > 0.5,
		`time visibly changed the canvas (${(100 * differing / painted).toFixed(0)}% of painted pixels differ)`)
})

test('baking matches computing each cell the slow way', () => {
	const store = seeded(2000)
	const now = store.now()
	const VW = 120, VH = 100
	const view = { scale: 2, x: -3980, y: -3980 }

	const slow = new Uint8ClampedArray(VW * VH * 4)
	renderView(store.live, now, 'weathered', view, slow, VW, VH)  // unbaked → per-cell path
	bake(store.live, now)
	const fast = new Uint8ClampedArray(VW * VH * 4)
	renderView(store.live, now, 'weathered', view, fast, VW, VH)  // baked → table lookup

	assert.deepEqual(Buffer.from(fast.buffer), Buffer.from(slow.buffer),
		'the cache is a speedup, not a different picture')
})
