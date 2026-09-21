/**
 * The mechanic is the product, so it gets the one runnable check. Everything
 * here is arithmetic over the shared module — no server, no sockets, no fixtures.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
	blank, place, display, take, hardness, at,
	CURE_S, FADE_S, FADE_MAX, OXIDE_N, VOID, W, YEAR_S,
} from '../shared/patina.js'

const RED = [0xff, 0x5b, 0x45]
const BLUE = [0x2f, 0x86, 0xe0]
const WHITE = [0xee, 0xf4, 0xfb]

const cell = (s, x, y) => { const k = at(s, x, y) * 3; return [s.base[k], s.base[k + 1], s.base[k + 2]] }
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

test('a virgin cell takes the colour whole', () => {
	const s = blank()
	place(s, 4, 4, RED, 1000)
	assert.deepEqual(cell(s, 4, 4), RED)
})

test('wet paint yields, cured paint resists', () => {
	assert.ok(take(1000, 1000) > 0.99, 'just-placed paint is wet')
	assert.ok(take(1000, 1000 + CURE_S) < 0.09, 'a week-old cell barely moves')
	assert.ok(hardness(0, CURE_S * 2) === 1, 'hardness saturates')

	const wet = blank()
	place(wet, 1, 1, RED, 0)
	place(wet, 1, 1, BLUE, 5)
	assert.ok(dist(cell(wet, 1, 1), BLUE) < 12, 'overwriting wet paint nearly replaces it')

	const cured = blank()
	place(cured, 1, 1, RED, 0)
	place(cured, 1, 1, BLUE, CURE_S)
	assert.ok(dist(cell(cured, 1, 1), RED) < dist(cell(cured, 1, 1), BLUE), 'cured paint holds its ground')
})

test('turning a cured wall costs about a dozen committed hits', () => {
	const s = blank()
	place(s, 2, 2, RED, 0)
	let t = CURE_S
	for (let i = 0; i < 12; i++) place(s, 2, 2, BLUE, t++)
	assert.ok(dist(cell(s, 2, 2), BLUE) < dist(cell(s, 2, 2), RED), 'twelve hits carry the cell')

	// ...but a single hit is nowhere near enough, or curing would mean nothing.
	const one = blank()
	place(one, 3, 3, RED, 0)
	place(one, 3, 3, BLUE, CURE_S)
	assert.ok(dist(cell(one, 3, 3), RED) < 40, 'one hit only scuffs it')
})

test('attacking softens the cell for the defender too', () => {
	// The interesting half of the rule: an attacker who lands a hit on cured
	// paint has also made it cheap to reclaim.
	const s = blank()
	place(s, 5, 5, RED, 0)
	place(s, 5, 5, BLUE, CURE_S)        // attacker scuffs it, and resets the cure
	place(s, 5, 5, RED, CURE_S + 1)     // defender answers immediately, on wet paint
	assert.ok(dist(cell(s, 5, 5), RED) < 20, 'the defender gets it back in one')
})

test('contested cells oxidise, quiet ones do not', () => {
	const now = 1_000_000
	const quiet = blank()
	place(quiet, 6, 6, WHITE, now)

	const fought = blank()
	for (let i = 0; i < OXIDE_N; i++) place(fought, 6, 6, WHITE, now - OXIDE_N + i)

	const a = display(quiet, at(quiet, 6, 6), now)
	const b = display(fought, at(fought, 6, 6), now)
	assert.ok(dist(b, WHITE) > dist(a, WHITE) + 30, 'a fought-over cell wears visibly')
})

test('neglect fades toward the ground but never reaches it', () => {
	const s = blank()
	place(s, 7, 7, WHITE, 0)
	const i = at(s, 7, 7)

	const fresh = display(s, i, 0)
	const old = display(s, i, FADE_S)
	const ancient = display(s, i, FADE_S * 10)

	assert.ok(dist(old, VOID) < dist(fresh, VOID), 'it fades')
	assert.deepEqual(ancient, old, 'the fade is capped, not asymptotic to nothing')
	assert.ok(dist(ancient, VOID) > 8, `a ghost survives (fade caps at ${FADE_MAX})`)
})

test('the pristine layer ignores the medium entirely', () => {
	const s = blank()
	place(s, 8, 8, RED, 0)
	place(s, 8, 8, BLUE, CURE_S)        // barely moves the weathered canvas...
	const o = at(s, 8, 8) * 3
	assert.deepEqual([s.pristine[o], s.pristine[o + 1], s.pristine[o + 2]], BLUE, '...but lands whole in pristine')
})

test('untouched cells read as ground, not as faded paint', () => {
	const s = blank()
	assert.equal(at(s, 99, 99), -1, 'an unpainted cell has no slot at all')
	assert.deepEqual(display(s, -1, YEAR_S), VOID)
})

test('empty canvas costs nothing, and slots are stable under repaint', () => {
	// The whole reason a 4096² board is possible: state tracks placements, not area.
	const s = blank()
	assert.equal(s.n, 0)

	place(s, 3000, 2500, RED, 0)
	place(s, 3000, 2500, BLUE, 10)
	assert.equal(s.n, 1, 'repainting a cell reuses its slot')

	place(s, 4095, 4095, WHITE, 20)
	assert.equal(s.n, 2, 'a far corner is one more slot, not a bigger grid')
	assert.deepEqual(cell(s, 4095, 4095), WHITE, 'and it addresses correctly at the far edge')
})

test('growth past the initial capacity keeps every cell intact', () => {
	// The arrays double; a copy that dropped or shifted a slot would corrupt
	// history silently, and the log is append-only.
	const s = blank(4)
	for (let i = 0; i < 50; i++) place(s, i, i * 2, PALETTE_SAMPLE[i % 3], i)
	assert.equal(s.n, 50)
	for (let i = 0; i < 50; i++) {
		assert.deepEqual(cell(s, i, i * 2), PALETTE_SAMPLE[i % 3], `slot ${i} survived the grow`)
	}
})
const PALETTE_SAMPLE = [RED, BLUE, WHITE]
