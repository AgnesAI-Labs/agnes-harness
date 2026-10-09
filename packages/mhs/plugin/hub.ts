/**
 * AgnesHub as an Agnes backend plugin: devices on /ws/mhs and /ws/nerve, clients on /ws/hub and the
 * Devices panel as a page of its own at /, all on its own port while the plugin is loaded, and the
 * brain's device tools, per-turn snapshot and wake-ups (server/hub-api.md section 15). Bundled with
 * its dependencies into dist/hub.mjs (tools/build-plugin.ts), because an installed plugin snapshot
 * carries no node_modules.
 *
 * AGNES_HUB_LISTEN  host:port to listen on, default 127.0.0.1:4180 (loopback only unless configured)
 * AGNES_HUB_DATA    data directory, default <AGH_HOME or ~/.agh>/hub; it keeps maps.json, the maps
 *                   devices declared
 */
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { RequestListener } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGH_DIR } from '@agnes/protocol'
import { Brain } from '../server/brain.js'
import { North } from '../server/north.js'
import { South } from '../server/south.js'
import { wake } from './daemon.js'
import { type Extension, registerBrainTools } from './tools.js'

// Not 4190: that is ManageSieve's port, which the Fetch standard blocks, so Node's built-in fetch and
// WebSocket (and so devices written for them) could never reach the hub there.
export const DEFAULT_LISTEN = '127.0.0.1:4180'
const RETRY_MS = 1000
// The panel's standalone build (client/dist/page.js and page.css): next to dist/hub.mjs once built
// and installed, next to this file when it runs from source.
const PAGE_DIR = new URL(
  import.meta.url.endsWith('/dist/hub.mjs') ? '../client/dist/' : './client/dist/',
  import.meta.url,
)
const SHELL =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Devices</title><link rel="stylesheet" href="/dist/page.css"><div id="app"></div><script type="module" src="/dist/page.js"></script>'
const ASSETS: Record<string, string> = {
  '/dist/page.js': 'text/javascript; charset=utf-8',
  '/dist/page.css': 'text/css; charset=utf-8',
}

/**
 * The standalone Devices page: an HTML shell at / and its two assets from `dir`. The page finds
 * /ws/hub on the host it was loaded from, so it works on any address the hub listens on.
 */
function servePage(dir: URL): RequestListener {
  return (req, res) => {
    const path = new URL(req.url ?? '/', 'http://hub').pathname
    if (path === '/')
      return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(SHELL)
    const type = ASSETS[path]
    if (!type) return void res.writeHead(404).end()
    readFile(new URL(`.${path.slice('/dist'.length)}`, dir)).then(
      (body) => res.writeHead(200, { 'content-type': type }).end(body),
      () => res.writeHead(404).end(),
    )
  }
}

/** host:port from AGNES_HUB_LISTEN; a bare port listens on loopback. */
export function parseListen(value: string): { host: string; port: number } {
  const at = value.lastIndexOf(':')
  const host = at < 0 ? '127.0.0.1' : value.slice(0, at).replace(/^\[|\]$/g, '') || '127.0.0.1'
  const port = Number(at < 0 ? value : value.slice(at + 1))
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error(`invalid AGNES_HUB_LISTEN ${value}`)
  return { host, port }
}

export function dataDir(env: NodeJS.ProcessEnv): string {
  return env.AGNES_HUB_DATA ?? join(env.AGH_HOME ?? join(homedir(), AGH_DIR), 'hub')
}

interface PluginContext {
  effect(execute: () => () => Promise<void> | void): unknown
  extension?: () => Extension
}

/** Starts AgnesHub in the background and stops it with the plugin. */
export function startHub(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.warn(`[agnes-hub] ${line}`),
  page: URL = PAGE_DIR,
): { hub: South; north: North; ready: Promise<void>; stop: () => Promise<void> } {
  const { host, port } = parseListen(env.AGNES_HUB_LISTEN ?? DEFAULT_LISTEN)
  const data = dataDir(env)
  mkdirSync(data, { recursive: true })
  const hub = new South({ name: 'agnes-hub', log })
  const north = new North(hub, { name: 'agnes-hub', log, mapsFile: join(data, 'maps.json') })
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let resolveReady: () => void = () => undefined
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  // Never block apply: a full plugin rebuild briefly overlaps the old and new copy on the port, so
  // a busy port is retried every second until the old copy lets go.
  const listen = (attempt: number): void => {
    hub.listen(port, host, north.handleUpgrade, servePage(page)).then(
      (address) => {
        if (stopped) return void hub.close()
        log(`listening on ${address.address}:${address.port} (/ws/mhs, /ws/nerve, /ws/hub, page at /)`)
        resolveReady()
      },
      (error: Error) => {
        if (stopped) return
        if (attempt === 0 || attempt % 30 === 0)
          log(`cannot listen on ${host}:${port}: ${error.message}; retrying`)
        timer = setTimeout(() => listen(attempt + 1), RETRY_MS)
      },
    )
  }
  listen(0)
  const stop = async () => {
    stopped = true
    clearTimeout(timer)
    north.close()
    await hub.close()
    log('stopped')
  }
  return { hub, north, ready, stop }
}

export const hub = {
  inject: ['extension'],
  apply(ctx: PluginContext) {
    const env = process.env
    const log = (line: string) => console.warn(`[agnes-hub] ${line}`)
    const { north, stop } = startHub(env, log)
    ctx.effect(() => stop)
    const agnes = ctx.extension?.()
    if (!agnes) return
    const home = env.AGH_HOME ?? join(homedir(), AGH_DIR)
    const brain = new Brain(north, (session, text) =>
      wake(home, session, text).catch((e: Error) => log(`could not wake ${session}: ${e.message}`)),
    )
    const disposers = registerBrainTools(agnes, brain)
    ctx.effect(() => () => {
      for (const dispose of disposers) dispose()
    })
  },
}
