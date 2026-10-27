// The cooldown is the only brake on an append-only, year-long log, so it must
// key on an address the client cannot choose.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'

const PORT = 4398

test('a spoofed X-Forwarded-For does not buy a second placement', async (t) => {
	const data = fs.mkdtempSync(path.join(os.tmpdir(), 'patina-cool-'))
	const relay = spawn(process.execPath, ['server/index.js'], {
		env: { ...process.env, PORT: String(PORT), PATINA_DATA: data },
		stdio: 'ignore',
	})
	t.after(() => { relay.kill(); fs.rmSync(data, { recursive: true, force: true }) })
	for (let i = 0; i < 50; i++) {
		if (await fetch(`http://127.0.0.1:${PORT}/health`).then(() => true, () => false)) break
		await new Promise((r) => setTimeout(r, 100))
	}

	/** Place one pixel as `xff`; resolve with the cooldown the relay answers. */
	const place = (xff) => new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { 'x-forwarded-for': xff } })
		ws.on('error', reject)
		ws.on('open', () => ws.send(Buffer.from([0x10, 1, 0, 1, 0, 0])))
		ws.on('message', (d) => {
			if (d[0] !== 0x05) return
			ws.close()
			resolve(d.readUInt32LE(1))
		})
	})

	const deltas = []
	const watcher = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
	watcher.on('message', (d) => { if (d.length === 12 && d[0] === 0x03) deltas.push(d) })
	await new Promise((r) => watcher.on('open', r))
	await new Promise((r) => setTimeout(r, 300))

	await place('198.51.100.1')
	await place('198.51.100.2')
	await new Promise((r) => setTimeout(r, 300))
	watcher.close()
	assert.equal(deltas.length, 1, 'only the first placement reached the canvas')
})
