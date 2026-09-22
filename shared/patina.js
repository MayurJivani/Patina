/**
 * The mechanic. Pure functions over typed arrays, no I/O, no DOM — the server
 * folds the event log with these and the client folds playback frames with the
 * same code, so a scrubbed month and the live canvas can never disagree.
 *
 * The rule, in one sentence: paint cures. A cell touched seconds ago is wet and
 * takes your colour almost whole; a cell nobody has touched for a week has set,
 * and barely shifts. r/place rewards whoever clicked last. This rewards whoever
 * got there first and then left it alone.
 *
 * Two consequences fall out of that and both are the point:
 *   - attacking cured paint softens it, for everyone. Land a hit on a week-old
 *     wall and you have also made it cheap for its owner to reclaim.
 *   - nothing is ever erased. Contested cells oxidise toward rust or verdigris
 *     in proportion to how often they have been fought over, and untouched
 *     cells fade toward the ground without reaching it. You can read a region's
 *     history off its surface.
 */

/**
 * 4096² is 16.7 million cells. Dense — a byte triple, a timestamp and a counter
 * each — that is 200 MB, which no browser is going to hold and no socket is
 * going to ship. So nothing here is dense: only cells somebody has actually
 * painted take up room, and the canvas being mostly empty is what pays for it
 * being this big. 8192 is the same code and a different number.
 */
export const W = 4096
export const H = 4096
export const CELLS = W * H

const DAY = 86400
export const YEAR_S = 365 * DAY

/** Wet → set. Tuned so a week of quiet buys real protection. */
export const CURE_S = 7 * DAY
/**
 * Placements before a cell is as oxidised as it will get. Two dozen is a number
 * a genuinely contested border reaches inside a month, which is the point —
 * set it at r/place's hundreds and the wear never shows up on anything but the
 * half-dozen most notorious cells on the canvas.
 */
export const OXIDE_N = 24
export const OXIDE_MAX = 0.45
/** Untouched paint drifts toward the ground over a third of a year... */
export const FADE_S = 120 * DAY
/** ...but never all the way. A ghost is still a record. */
export const FADE_MAX = 0.72

/** Seconds between placements, per client. */
export const COOLDOWN_S = 20

/** The ground the canvas is drawn on — --bg-2 from the studio palette. */
export const VOID = [0x0a, 0x15, 0x26]
/** The table the sheet sits on — --bg. Only the renderer needs it. */
export const PAGE = [0x06, 0x0c, 0x18]
const RUST = [0x7a, 0x4a, 0x2e]
const VERDIGRIS = [0x2f, 0x6f, 0x60]

/**
 * 48 placeable colours, in six families of eight — the dock lays them out in
 * that order, so it reads as a paint box rather than a bag of swatches.
 *
 * The studio's blueprint anchors are all still in here, which is what keeps the
 * canvas looking like it belongs to the rest of the site. What the first
 * twenty-four were missing was a neutral ramp (you cannot shade anything with
 * one grey), a full earth ramp, and pinks — and a board this size needs them
 * more than a small one does, because detail is the only thing that survives
 * being zoomed out.
 *
 * The log stores RGB, never an index into this array, so adding to it or
 * reordering it cannot reinterpret a placement that has already happened.
 * `place` messages are validated against the current length.
 */
export const PALETTE = [
	// neutrals — the shading ramp
	[0xee, 0xf4, 0xfb], [0xcd, 0xd9, 0xe8], [0x9f, 0xb0, 0xc7], [0x7e, 0x93, 0xb8],
	[0x56, 0x6a, 0x8a], [0x3a, 0x4d, 0x70], [0x11, 0x23, 0x42], [0x05, 0x07, 0x0d],
	// blues — the studio core. Ends on a teal rather than a third near-black
	// blue; row one already has Navy and Black.
	[0xa9, 0xd3, 0xff], [0x5e, 0xb8, 0xff], [0x2f, 0x86, 0xe0], [0x1b, 0x5f, 0xc4],
	[0x13, 0x40, 0x9e], [0x0d, 0x2b, 0x70], [0x3b, 0x2f, 0x8f], [0x1d, 0x7a, 0x96],
	// greens and teals
	[0x8e, 0xf0, 0xc4], [0x5f, 0xd4, 0xa8], [0x34, 0xb9, 0x8a], [0x1f, 0x9a, 0x70],
	[0x3f, 0x7d, 0x6b], [0x15, 0x5e, 0x4e], [0x0d, 0x3d, 0x32], [0x4a, 0x7a, 0x3c],
	// yellows through oranges, ending on a dark yellow — three bright yellows
	// crowded each other and none of them could shade the other two.
	[0xc9, 0xf2, 0x5e], [0x9f, 0xd9, 0x3f], [0xe8, 0xd4, 0x4d], [0xf0, 0xa1, 0x3a],
	[0xff, 0x7a, 0x2f], [0xe8, 0x5c, 0x1c], [0xb8, 0x43, 0x1a], [0x9a, 0x85, 0x23],
	// reds, pinks, violets
	[0xff, 0x5b, 0x45], [0xff, 0x8a, 0x7a], [0xc0, 0x30, 0x4a], [0x7a, 0x23, 0x40],
	[0xd2, 0x48, 0x9e], [0xf0, 0x90, 0xc0], [0xb0, 0x7a, 0xd8], [0x6f, 0x4b, 0xbd],
	// earths — the family the oxidation pulls toward
	[0x7a, 0x4a, 0x2e], [0xa3, 0x5c, 0x34], [0xb9, 0x8a, 0x5e], [0xd4, 0xa8, 0x78],
	[0xe8, 0xc9, 0xa8], [0x5c, 0x3a, 0x24], [0x3d, 0x25, 0x17], [0x8a, 0x7f, 0x72],
]

/**
 * Names, in palette order. A swatch is a bare coloured square, so without these
 * a screen reader reads out "Colour 27" — which tells you nothing about what you
 * are about to paint with.
 */
export const PALETTE_NAMES = [
	'White', 'Paper', 'Ash', 'Slate', 'Steel', 'Graphite', 'Navy', 'Black',
	'Pale blue', 'Cyan', 'Sky', 'Azure', 'Blue', 'Deep blue', 'Indigo', 'Teal',
	'Pale mint', 'Mint', 'Spring', 'Emerald', 'Verdigris', 'Pine', 'Forest', 'Moss',
	'Lime', 'Chartreuse', 'Yellow', 'Amber', 'Orange', 'Tangerine', 'Ember', 'Brass',
	'Red', 'Coral', 'Crimson', 'Wine', 'Magenta', 'Pink', 'Violet', 'Purple',
	'Rust', 'Sienna', 'Sand', 'Tan', 'Bone', 'Umber', 'Bitumen', 'Taupe',
]

// Mixing pigment in sRGB muddies everything toward grey, which would hide the
// oxidation this whole thing is about. Mix in linear light instead; the forward
// direction is a 256-entry table, the way back is the only pow() per channel.
const TO_LINEAR = new Float32Array(256)
for (let i = 0; i < 256; i++) {
	const c = i / 255
	TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function toSrgb(v) {
	const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
	return Math.max(0, Math.min(255, Math.round(c * 255)))
}

/** `out[k] = a·(1-t) + b·t`, in linear light. `a`/`b` are [r,g,b] 0–255. */
export function mix(a, b, t, out = [0, 0, 0]) {
	for (let k = 0; k < 3; k++) {
		out[k] = toSrgb(TO_LINEAR[a[k]] * (1 - t) + TO_LINEAR[b[k]] * t)
	}
	return out
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * How set a cell is: 0 the instant it is placed, 1 once it has been left alone
 * for CURE_S.
 */
export function hardness(lastTouch, now) {
	return clamp01((now - lastTouch) / CURE_S)
}

/**
 * The fraction of your colour that actually lands. Wet paint takes ~all of it,
 * fully cured paint takes 8% — call it a dozen committed hits to turn a wall,
 * and the first of those hits softens it for whoever comes next.
 */
export function take(lastTouch, now) {
	const h = hardness(lastTouch, now)
	return 0.92 * Math.pow(1 - h, 1.5) + 0.08
}

/**
 * Fresh state.
 *
 * Painted cells are packed into parallel arrays and `index` maps a cell number
 * to its slot, so everything costs 16 bytes per *painted* cell and nothing per
 * empty one. Iterating for a redraw walks the painted cells rather than the
 * canvas, which is also why a 4096² board redraws faster than the 128² dense
 * version did.
 */
export function blank(cap = 1024) {
	return {
		index: new Map(),
		cells: new Uint32Array(cap),
		base: new Uint8Array(cap * 3),
		pristine: new Uint8Array(cap * 3),
		touched: new Uint32Array(cap),
		layers: new Uint16Array(cap),
		n: 0,
		cap,
	}
}

function grow(s) {
	// max(1, …) matters: a state decoded from the wire arrives with cap === n,
	// and an empty canvas would otherwise double 0 forever.
	const cap = Math.max(1, s.cap * 2)
	const copy = (arr, Type, stride) => {
		const next = new Type(cap * stride)
		next.set(arr)
		return next
	}
	s.cells = copy(s.cells, Uint32Array, 1)
	s.base = copy(s.base, Uint8Array, 3)
	s.pristine = copy(s.pristine, Uint8Array, 3)
	s.touched = copy(s.touched, Uint32Array, 1)
	s.layers = copy(s.layers, Uint16Array, 1)
	s.cap = cap
}

/** Slot for a cell, appending one the first time it is painted. */
export function slotOf(s, cell) {
	let slot = s.index.get(cell)
	if (slot === undefined) {
		if (s.n === s.cap) grow(s)
		slot = s.n++
		s.index.set(cell, slot)
		s.cells[slot] = cell
		s.layers[slot] = 0
	}
	return slot
}

/** Slot for a coordinate, or -1 if nobody has painted it. */
export const at = (s, x, y) => s.index.get(y * W + x) ?? -1

const scratch = [0, 0, 0]
const rgb = [0, 0, 0]

/**
 * Apply one placement. Mutates `state` — this runs a few million times on a
 * cold fold, so it allocates nothing beyond the occasional array growth.
 */
export function place(state, x, y, colour, t) {
	const slot = slotOf(state, y * W + x)
	const o = slot * 3

	// A virgin cell has no paint to resist with; it takes the colour whole.
	// Otherwise the cure curve decides how much of it survives contact.
	const w = state.layers[slot] === 0 ? 1 : take(state.touched[slot], t)

	if (w >= 1) {
		scratch[0] = colour[0]; scratch[1] = colour[1]; scratch[2] = colour[2]
	} else {
		rgb[0] = state.base[o]; rgb[1] = state.base[o + 1]; rgb[2] = state.base[o + 2]
		mix(rgb, colour, w, scratch)
	}

	state.base[o] = scratch[0]
	state.base[o + 1] = scratch[1]
	state.base[o + 2] = scratch[2]

	// The pristine layer is the same history with the medium taken out: every
	// placement lands whole, nothing cures, nothing ages. It is what the
	// painters meant, and the gap between it and the weathered canvas is the
	// only thing on this site worth looking at twice.
	state.pristine[o] = colour[0]
	state.pristine[o + 1] = colour[1]
	state.pristine[o + 2] = colour[2]

	state.touched[slot] = t
	if (state.layers[slot] < 0xffff) state.layers[slot]++
}

/**
 * What a cell looks like now: base pigment, pushed toward rust or verdigris by
 * how contested it has been, then faded toward the ground by how long it has
 * been ignored. Warm paint rusts, cool paint greens — same instinct as real
 * metal, and it keeps a busy region legible instead of grey.
 */
export function display(state, slot, now, out = [0, 0, 0]) {
	if (slot < 0 || state.layers[slot] === 0) {
		out[0] = VOID[0]; out[1] = VOID[1]; out[2] = VOID[2]
		return out
	}
	const o = slot * 3
	rgb[0] = state.base[o]
	rgb[1] = state.base[o + 1]
	rgb[2] = state.base[o + 2]

	const ox = Math.min(state.layers[slot] / OXIDE_N, 1) * OXIDE_MAX
	mix(rgb, rgb[0] >= rgb[2] ? RUST : VERDIGRIS, ox, out)

	const fade = clamp01((now - state.touched[slot]) / FADE_S) * FADE_MAX
	return mix(out, VOID, fade, out)
}

/** The colour of a slot in whichever reading is on screen. */
export function colourOf(state, slot, now, mode, out = [0, 0, 0]) {
	if (mode !== 'pristine') return display(state, slot, now, out)
	const o = slot * 3
	out[0] = state.pristine[o]; out[1] = state.pristine[o + 1]; out[2] = state.pristine[o + 2]
	return out
}

/**
 * Precompute the weathered colour of every painted cell into `state.shown`.
 *
 * `display()` is two linear-light mixes and six pow() calls, which is nothing
 * once and 70ms across a quarter-million cells — i.e. the difference between a
 * canvas you can drag and one you can't. None of it depends on the viewport, so
 * it is baked when the clock or the canvas moves and merely copied while you
 * pan and zoom.
 */
export function bake(state, now, slots = null) {
	if (!state.shown || state.shown.length < state.n * 3) {
		state.shown = new Uint8Array(Math.max(state.cap, state.n) * 3)
		slots = null // a fresh buffer has nothing valid in it; bake everything
	}
	const px = [0, 0, 0]
	const one = (slot) => {
		display(state, slot, now, px)
		state.shown[slot * 3] = px[0]
		state.shown[slot * 3 + 1] = px[1]
		state.shown[slot * 3 + 2] = px[2]
	}

	// ponytail: a partial bake leaves every untouched cell carrying the fade and
	// oxidation of the previous instant. That is invisible for a live placement
	// (the clock moved by a second) and near enough during playback (a frame is
	// a day and a half of drift), and callers doing either must force a full
	// bake periodically — the reel does, every sixteen frames.
	if (slots) for (const slot of slots) one(slot)
	else for (let slot = 0; slot < state.n; slot++) one(slot)

	state.bakedAt = now
	return state
}

/**
 * Draw the painted cells into a screen-sized RGBA buffer.
 *
 * There is no full-canvas bitmap anywhere — 4096² of RGBA would be 67 MB. This
 * walks the painted cells instead and stamps each one's rectangle straight into
 * the viewport buffer, so the cost tracks how much has been painted and how
 * much of it is on screen, never the size of the board.
 *
 * ponytail: the walk is over every painted cell, not just the visible ones —
 * O(painted) per frame. At a few hundred thousand that is well under a frame;
 * past a million, bucket the slots into 256² tiles on `place()` and iterate the
 * visible buckets instead.
 */
export function renderView(state, now, mode, view, rgba, vw, vh) {
	const px = [0, 0, 0]
	const { scale, x: ox, y: oy } = view

	// Read straight out of whichever precomputed band applies. `bake()` keeps
	// `shown` current; if it has not run for this instant, fall back to
	// computing per cell so a caller that forgets is slow rather than wrong.
	const band = mode === 'pristine' ? state.pristine : (state.bakedAt === now ? state.shown : null)

	// The buffer is opaque, so the two backgrounds have to be painted here
	// rather than left to a fillRect underneath: page dark everywhere, board
	// ground inside the sheet.
	fillRect(rgba, vw, 0, 0, vw, vh, PAGE)
	fillRect(rgba, vw,
		Math.max(0, Math.floor(ox)), Math.max(0, Math.floor(oy)),
		Math.min(vw, Math.ceil(ox + W * scale)), Math.min(vh, Math.ceil(oy + H * scale)), VOID)

	for (let slot = 0; slot < state.n; slot++) {
		const cell = state.cells[slot]
		const cx = cell % W
		const cy = (cell - cx) / W

		// Cell rectangle in device pixels, clipped to the viewport.
		let x0 = Math.floor(ox + cx * scale)
		let y0 = Math.floor(oy + cy * scale)
		let x1 = Math.max(x0 + 1, Math.floor(ox + (cx + 1) * scale))
		let y1 = Math.max(y0 + 1, Math.floor(oy + (cy + 1) * scale))
		if (x1 <= 0 || y1 <= 0 || x0 >= vw || y0 >= vh) continue
		if (x0 < 0) x0 = 0
		if (y0 < 0) y0 = 0
		if (x1 > vw) x1 = vw
		if (y1 > vh) y1 = vh

		if (band) {
			px[0] = band[slot * 3]; px[1] = band[slot * 3 + 1]; px[2] = band[slot * 3 + 2]
		} else {
			colourOf(state, slot, now, mode, px)
		}
		fillRect(rgba, vw, x0, y0, x1, y1, px)
	}
	return rgba
}

function fillRect(rgba, vw, x0, y0, x1, y1, c) {
	const r = c[0], g = c[1], b = c[2]
	for (let y = y0; y < y1; y++) {
		let p = (y * vw + x0) * 4
		for (let x = x0; x < x1; x++) {
			rgba[p] = r; rgba[p + 1] = g; rgba[p + 2] = b; rgba[p + 3] = 255
			p += 4
		}
	}
}

export const inBounds = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < W && y < H
