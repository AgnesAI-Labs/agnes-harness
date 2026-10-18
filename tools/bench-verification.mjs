// pnpm exec tsx tools/bench-verification.mjs --home <isolated-daemon-home> --owner <owner-json>
//   --trace <NDJSON-from-preload> [--profile local-dev] [--session <synthetic-workspace>]
//   [--concurrency <rounds>] measures session-list latency on a separate SDK connection.
// Start that daemon with bench-verification-preload.mjs first; see the preload header.
// No startup, activation or inference here. --session explicitly opts into a synthetic session.
// Timings include opt-in instrumentation. Repeat without the preload for uninstrumented timings.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createClient, memoryJournal } from '../packages/sdk/src/index.node.ts'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
if (!args.get('--home') || !args.get('--owner'))
  throw new Error('Pass --home and the trusted --owner JSON of the already running isolated daemon')
const home = resolve(args.get('--home'))
const owner = JSON.parse(readFileSync(resolve(args.get('--owner')), 'utf8'))
if (
  !Number.isSafeInteger(owner.pid) ||
  typeof owner.processStartId !== 'string' ||
  typeof owner.socketPath !== 'string'
)
  throw new Error('Invalid daemon owner record')
const connect = () =>
  createClient({
    journal: memoryJournal(),
    transport: {
      kind: 'unix',
      path: owner.socketPath,
      ...(owner.socketPath.startsWith('\\\\.\\pipe\\')
        ? { serverIdentity: { pid: owner.pid, processStartId: owner.processStartId } }
        : {}),
    },
  })
const client = connect()
const profile = args.get('--profile') ?? 'local-dev'
const events = () => {
  if (!args.get('--trace')) return []
  try {
    return readFileSync(resolve(args.get('--trace')), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse)
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}
try {
  await client.initialize()
  if (args.get('--trace')) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const before = events().length
      await new Promise((resolve) => setTimeout(resolve, 250))
      if (events().length === before) break
      if (attempt === 29) throw new Error('Daemon is not idle; use an isolated home')
    }
  }
  const queries = [
    ['app info', () => client.call('_agnes/v1/applications.get', { profile })],
    ['package list', () => client.call('_agnes/v1/packages.list', { profile })],
    ['client modules', () => client.clientModules.list(profile)],
    ['skin list', () => client.skins.list(profile)],
    ['model list', () => client.sessionSelection.modelAdapters()],
  ]
  if (args.get('--session'))
    queries.push([
      'session open',
      async () => {
        const session = await client.createSession({
          cwd: resolve(args.get('--session')),
          sessionKey: `verification-benchmark-${randomUUID()}`,
        })
        await session.detach()
      },
    ])
  console.log(
    JSON.stringify({
      node: process.version,
      platform: process.platform,
      home,
      profile,
      instrumented: Boolean(args.get('--trace')),
    }),
  )
  if (args.has('--concurrency')) {
    const rounds = Number(args.get('--concurrency'))
    if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100)
      throw new Error('Concurrency rounds must be 1..100')
    const light = connect()
    try {
      await light.initialize()
      for (const scenario of ['idle', 'package list', 'skin list', 'mixed lists']) {
        const samples = []
        for (let round = 0; round < rounds; round++) {
          let running = true
          const polling = (async () => {
            do {
              const start = performance.now()
              await light.call('_agnes/v1/session.list', { limit: 10 })
              samples.push(performance.now() - start)
              await new Promise((resolve) => setTimeout(resolve, 1))
            } while (running)
          })()
          try {
            if (scenario === 'idle') await new Promise((resolve) => setTimeout(resolve, 100))
            else if (scenario === 'mixed lists')
              await Promise.all(queries.slice(0, 5).map(([, read]) => read()))
            else await queries.find(([query]) => query === scenario)[1]()
          } finally {
            running = false
            await polling
          }
        }
        console.log(
          JSON.stringify({
            scenario,
            rounds,
            samples: samples.length,
            maxLightQueryMs: Math.max(...samples),
          }),
        )
      }
    } finally {
      await light.close()
    }
  }
  for (const [query, read] of queries)
    for (let round = 0; round < 2; round++) {
      const before = events().length,
        start = performance.now()
      await read()
      const ms = performance.now() - start,
        hashes = events().slice(before)
      const directories = Object.fromEntries(
        [...new Set(hashes.map((e) => e.directory))].map((dir) => [
          dir,
          hashes.filter((e) => e.directory === dir).length,
        ]),
      )
      console.log(
        JSON.stringify({
          query,
          round,
          ms,
          hashes: args.get('--trace') ? hashes.length : null,
          synchronous: hashes.filter((e) => !e.asynchronous).length,
          asynchronous: hashes.filter((e) => e.asynchronous).length,
          directories,
        }),
      )
    }
} finally {
  await client.close()
}
