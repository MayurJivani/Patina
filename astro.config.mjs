// @ts-check
import { defineConfig } from 'astro/config'

// Static: one page, and every dynamic thing on it arrives over the socket.
// The relay serves dist/ directly, so there is no adapter and no SSR.
export default defineConfig({ output: 'static' })
