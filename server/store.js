/**
 * The year, on disk.
 *
 * One append-only log of placements is the only source of truth here; the live
 * canvas, any month you scrub to, and the reel are all folds of it. That is
 * what makes the pristine layer honest — it is not a second canvas people paint
 * on, it is the same history replayed with the medium switched off.
 *
 * Records are fixed 12 bytes, so seeking a month is arithmetic rather than a
 * parse:
 *
 *     u32 t   seconds since the canvas epoch
 *     u16 x   u16 y
 *     u8  r   u8 g   u8 b
 *     u8  _   padding, keeps the record 4-byte aligned
 */
import fs from 'node:fs'
import path from 'node:path'
import { blank, place, W, H, CELLS, YEAR_S } from '../shared/patina.js'

export const REC = 12
const MONTHS = 12
const MONTH_S = Math.floor(YEAR_S / MONTHS)

export class Store {
	constructor(dir) {
		this.dir = dir
		this.logPath = path.join(dir, 'events.bin')
		this.metaPath = path.join(dir, 'meta.json')
		fs.mkdirSync(dir, { recursive: true })

		const meta = fs.existsSync(this.metaPath)
			? JSON.parse(fs.readFileSync(this.metaPath, 'utf8'))
			: { epoch: Math.floor(Date.now() / 1000) }
		this.epoch = meta.epoch
		fs.writeFileSync(this.metaPath, JSON.stringify({ epoch: this.epoch }, null, 2))

		// ponytail: the whole log lives in RAM (12 bytes a placement — a busy
		// year of two million is 24 MB, which is nothing). A canvas that ran for
		// several years, or one wide enough to attract bots, wants this chunked
		// or mmap'd instead of slurped.
		const onDisk = fs.existsSync(this.logPath) ? fs.readFileSync(this.logPath) : Buffer.alloc(0)
		this.count = Math.floor(onDisk.length / REC)
		// Headroom, doubled when it runs out. The obvious version re-concats the
		// whole log on every placement, which at a year's size is a 10 MB memcpy
		// per painted pixel.
		this.log = Buffer.alloc(Math.max(onDisk.length * 2, 1 << 20))
		onDisk.copy(this.log)
		this.fd = fs.openSync(this.logPath, 'a')

		this.live = blank()
		this.foldInto(this.live, 0, this.count)

	}

	/** Seconds since the canvas epoch. The canvas stops accepting paint at the year mark. */
	now() {
		return Math.min(Math.floor(Date.now() / 1000) - this.epoch, YEAR_S)
	}

	read(i) {
		const o = i * REC
		return {
			t: this.log.readUInt32LE(o),
			x: this.log.readUInt16LE(o + 4),
			y: this.log.readUInt16LE(o + 6),
			c: [this.log[o + 8], this.log[o + 9], this.log[o + 10]],
		}
	}

	append(x, y, colour, t) {
		const rec = Buffer.alloc(REC)
		rec.writeUInt32LE(t, 0)
		rec.writeUInt16LE(x, 4)
		rec.writeUInt16LE(y, 6)
		rec[8] = colour[0]; rec[9] = colour[1]; rec[10] = colour[2]

		// Disk first. A placement that is in memory but not on disk is a pixel
		// that vanishes on the next redeploy, and the log is the only truth here.
		fs.writeSync(this.fd, rec)

		const end = this.count * REC
		if (end + REC > this.log.length) {
			const bigger = Buffer.alloc(this.log.length * 2)
			this.log.copy(bigger)
			this.log = bigger
		}
		rec.copy(this.log, end)
		this.count++

		place(this.live, x, y, colour, t)
	}

	foldInto(state, from, to) {
		for (let i = from; i < to; i++) {
			const e = this.read(i)
			place(state, e.x, e.y, e.c, e.t)
		}
		return state
	}

	/** Index of the first record at or after `t`. Binary search; the log is sorted by construction. */
	seek(t) {
		let lo = 0, hi = this.count
		while (lo < hi) {
			const mid = (lo + hi) >> 1
			if (this.log.readUInt32LE(mid * REC) < t) lo = mid + 1
			else hi = mid
		}
		return lo
	}

	/**
	 * The canvas as it stood at `t`, folded from the start of the year.
	 *
	 * This began as monthly keyframes with an LRU cache, on the assumption that
	 * replaying December meant replaying twelve months. Measured, a whole year
	 * of 800k placements folds in under 200ms, while the keyframe path cost
	 * 231ms cold and 85ms warm — the cache was slower than the thing it cached,
	 * because a sparse state's index is a Map and cloning one is most of the
	 * work. So there is no cache. Scrubbing is one pass over the log.
	 *
	 * ponytail: linear in the whole log, so this degrades as the year fills —
	 * at ~5M placements it is over a second and wants the keyframes back, but
	 * stored as sparse deltas rather than cloned states.
	 */
	at(t) {
		if (t >= this.now()) return this.live
		return this.foldInto(blank(), 0, this.seek(t + 1))
	}

	/**
	 * Playback, as a keyframe plus deltas rather than a stack of stills.
	 *
	 * Sending N full canvases would be 200 KB each. Instead the range is cut
	 * into `frames` buckets and each bucket keeps only the last placement per
	 * cell — a year of painting collapses to a few hundred KB, and the client
	 * folds it with the same `place()` the server used, so the weathered and
	 * pristine reels both come out right from one payload.
	 *
	 *   u8  0x04
	 *   u32 from   u32 to   u16 frames
	 *   then per frame: u32 count, then count × (u16 x, u16 y, u8 r,g,b, u8 _)
	 */
	reel(from, to, frames) {
		const span = Math.max(1, to - from)
		const buckets = Array.from({ length: frames }, () => new Map())

		for (let i = this.seek(from); i < this.count; i++) {
			const e = this.read(i)
			if (e.t > to) break
			const f = Math.min(frames - 1, Math.floor(((e.t - from) / span) * frames))
			// Last write per cell per bucket wins — the intermediate colours
			// inside one frame were never going to be visible anyway.
			buckets[f].set(e.y * W + e.x, e)
		}

		const total = buckets.reduce((n, b) => n + b.size, 0)
		const buf = Buffer.alloc(1 + 4 + 4 + 2 + frames * 4 + total * 8)
		let o = 0
		buf[o++] = 0x04
		buf.writeUInt32LE(from, o); o += 4
		buf.writeUInt32LE(to, o); o += 4
		buf.writeUInt16LE(frames, o); o += 2

		for (const bucket of buckets) {
			buf.writeUInt32LE(bucket.size, o); o += 4
			for (const e of bucket.values()) {
				buf.writeUInt16LE(e.x, o); o += 2
				buf.writeUInt16LE(e.y, o); o += 2
				buf[o++] = e.c[0]; buf[o++] = e.c[1]; buf[o++] = e.c[2]; buf[o++] = 0
			}
		}
		return buf
	}

	/**
	 * A whole canvas on the wire.
	 *
	 *   u8 op, u8[3] pad, u32 now, u32 epoch, u32 at, u32 n, u16 w, u16 h
	 *   cells[n×4], touched[n×4], layers[n×2], base[n×3], pristine[n×3]
	 *
	 * 16 bytes per *painted* cell and nothing for the rest of the board, which
	 * is what lets a 4096² canvas ship at all. The u32 arrays come first and the
	 * header is 24 bytes so every range starts 4-byte aligned — the client wraps
	 * these in place rather than copying, and a misaligned byteOffset throws.
	 *
	 * The client gets `touched` and `layers` as well as colour so it can draw
	 * the cure ring, the readout and both readings without asking the server
	 * about every cell the cursor crosses.
	 *
	 * ponytail: this is the whole canvas in one message. Fine to a few hundred
	 * thousand painted cells (a few MB, and the socket deflates it); past about
	 * a million, cut it into 256² tiles and send only the viewport's.
	 */
	snapshot(state, at, op = 0x01) {
		const n = state.n
		const head = Buffer.alloc(24)
		head[0] = op
		head.writeUInt32LE(this.now(), 4)
		head.writeUInt32LE(this.epoch, 8)
		head.writeUInt32LE(at, 12)
		head.writeUInt32LE(n, 16)
		head.writeUInt16LE(W, 20)
		head.writeUInt16LE(H, 22)

		// The arrays are over-allocated by the doubling in `grow()`; only the
		// first n slots are real, so every range is subarray'd before it goes out.
		const raw = (arr, stride) =>
			Buffer.from(arr.buffer, arr.byteOffset, n * stride * arr.BYTES_PER_ELEMENT)

		return Buffer.concat([
			head,
			raw(state.cells, 1), raw(state.touched, 1), raw(state.layers, 1),
			raw(state.base, 3), raw(state.pristine, 3),
		])
	}

	close() {
		try { fs.closeSync(this.fd) } catch { /* already gone */ }
	}
}


export { MONTH_S, MONTHS, CELLS }
