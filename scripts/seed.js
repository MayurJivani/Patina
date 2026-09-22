/**
 * A fabricated year, so the timeline and the reel have something to show before
 * anyone has painted anything. Writes straight to the event log in the store's
 * own format — dev only, and it refuses to touch a log that already has history.
 *
 *   node scripts/seed.js [placements]
 *
 * The shape of the fake matters. Uniform random placements over a 4096² board
 * produce confetti: no contiguous colour, no borders, and so nothing for the
 * cure rule or the oxidation to bite on. Real canvases look the way they do
 * because people coordinate — so this seeds *territories that grow*, collide,
 * and get vandalised along the seams.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PALETTE, W, H, YEAR_S } from '../shared/patina.js'
import { REC } from '../server/store.js'

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')
const log = path.join(DATA, 'events.bin')
fs.mkdirSync(DATA, { recursive: true })

if (fs.existsSync(log) && fs.statSync(log).size > 0) {
	console.error('data/events.bin already has history — refusing to overwrite it.')
	process.exit(1)
}

const N = Number(process.argv[2]) || 900_000
// Pretend the canvas opened a year ago so the whole timeline is populated.
fs.writeFileSync(path.join(DATA, 'meta.json'),
	JSON.stringify({ epoch: Math.floor(Date.now() / 1000) - YEAR_S + 3600 }, null, 2))

const rnd = (a, b) => a + Math.random() * (b - a)
const irnd = (a, b) => Math.floor(rnd(a, b))

// One district, near the middle. A year-old canvas is a settled town on a big
// empty plain, not an evenly spread wash.
const DW = 760, DH = 560
const OX = Math.round((W - DW) / 2)
const OY = Math.round((H - DH) / 2)

// Six claims, laid out 3×2 with deliberate overlap: each rectangle is wider
// than its share of the grid, so neighbours must fight over the seams.
const COLS = 3, ROWS = 2
const OVERLAP = 34
const guilds = []
for (let r = 0; r < ROWS; r++) {
	for (let c = 0; c < COLS; c++) {
		const w = Math.round(DW / COLS) + OVERLAP
		const h = Math.round(DH / ROWS) + OVERLAP
		guilds.push({
			// cyan, mint, yellow, red, violet, pale blue — indices into the
			// family-grouped PALETTE, not the old flat one.
			colour: [9, 17, 26, 32, 38, 8][r * COLS + c],
			x: OX + Math.round((DW / COLS) * c) - (c ? OVERLAP : 0),
			y: OY + Math.round((DH / ROWS) * r) - (r ? OVERLAP : 0),
			w, h,
			// Which corner the claim grows out from, so the reel shows six
			// rectangles creeping toward each other rather than fading up.
			ax: Math.random() < 0.5 ? 0 : 1,
			ay: Math.random() < 0.5 ? 0 : 1,
			// When this guild shows up. Not everyone starts in January.
			start: Math.random() * 0.35,
		})
	}
}

// A mural painted in the first two months and then abandoned — the reference
// for what four seasons of neglect does to untouched paint.
const mural = { x: OX - 210, y: OY + 90, w: 170, h: 130, colour: 44 }  // bone

const events = []

function push(t, x, y, ci) {
	if (x < 0 || y < 0 || x >= W || y >= H) return
	events.push({ t: Math.max(0, Math.min(YEAR_S - 1, Math.floor(t))), x: Math.round(x), y: Math.round(y), c: PALETTE[ci] })
}

for (let i = 0; i < N; i++) {
	const roll = Math.random()

	if (roll < 0.08) {
		// The abandoned mural, all of it inside the first sixth of the year.
		const t = Math.random() * (YEAR_S / 6)
		// Mostly bone, flecked with sand, so the fade has some internal contrast
		// to lose rather than being one flat tone going grey.
		push(t, mural.x + irnd(0, mural.w), mural.y + irnd(0, mural.h), Math.random() < 0.18 ? 42 : mural.colour)
		continue
	}

	// Busier as the year goes on, the way a canvas that people keep finding is.
	const t = Math.pow(Math.random(), 0.75) * (YEAR_S - 3600)
	const g = guilds[irnd(0, guilds.length)]

	const p = (t / YEAR_S - g.start) / (1 - g.start)
	if (p <= 0) continue // this guild hasn't arrived yet

	if (roll < 0.20) {
		// Vandals: anywhere in the district, any colour. This is what puts
		// layers on a cell and drives the oxidation.
		push(t, OX + irnd(-240, DW + 60), OY + irnd(0, DH), irnd(0, PALETTE.length))
		continue
	}

	// The claim as it stands at t: the full rectangle scaled from its anchor
	// corner by how long the guild has been going. Territories therefore only
	// start overlapping late in the year, which is when the seams light up.
	const gw = g.w * Math.min(1, p)
	const gh = g.h * Math.min(1, p)
	const x0 = g.ax ? g.x + g.w - gw : g.x
	const y0 = g.ay ? g.y + g.h - gh : g.y

	// A tenth of a guild's own work is detail in its own colour family, which
	// keeps a filled block from reading as a flat swatch.
	const ci = Math.random() < 0.1 ? (g.colour + (Math.random() < 0.5 ? 1 : -1) + PALETTE.length) % PALETTE.length : g.colour
	push(t, x0 + Math.random() * gw, y0 + Math.random() * gh, ci)
}

events.sort((a, b) => a.t - b.t)

const out = Buffer.alloc(events.length * REC)
events.forEach((e, i) => {
	const o = i * REC
	out.writeUInt32LE(e.t, o)
	out.writeUInt16LE(e.x, o + 4)
	out.writeUInt16LE(e.y, o + 6)
	out[o + 8] = e.c[0]; out[o + 9] = e.c[1]; out[o + 10] = e.c[2]
})
fs.writeFileSync(log, out)
console.log(`seeded ${events.length} placements across the year → ${log}`)
