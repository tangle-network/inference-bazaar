import { listenSidecar } from './server'

/**
 * Entry point the Rust operator spawns. Reads `SURPLUS_MM_SIDECAR_PORT`
 * (default 9110) and `SURPLUS_MM_SIDECAR_HOST` (default 127.0.0.1).
 */
const port = Number(process.env.SURPLUS_MM_SIDECAR_PORT ?? 9110)
const host = process.env.SURPLUS_MM_SIDECAR_HOST ?? '127.0.0.1'

const { port: bound } = await listenSidecar(port, host)
// eslint-disable-next-line no-console
console.log(`surplus mm-sidecar listening on http://${host}:${bound}`)
