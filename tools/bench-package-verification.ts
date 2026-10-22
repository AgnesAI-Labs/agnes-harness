// Synthetic package reads plus a lightweight HTTP handler in the same event loop.
// This measures the manager, not the full daemon/browser startup path.
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { setImmediate } from 'node:timers/promises'
import {
  createPackageManager,
  emptyLock,
  parseSource,
  writeLock,
} from '../packages/package-manager/src/index.js'

const root = mkdtempSync(join(tmpdir(), 'agh-package-bench-'))
const profile = join(root, 'profiles', 'bench')
function cleanup() {
  const absolute = resolve(root)
  if (!absolute.startsWith(`${resolve(tmpdir())}${sep}agh-package-bench-`))
    throw new Error('unexpected benchmark directory')
  rmSync(absolute, { recursive: true, force: true })
}
const server = createServer((_request, response) => {
  response.writeHead(204)
  response.end()
})
const originalRead = fs.readFileSync
const lag = monitorEventLoopDelay({ resolution: 10 })
try {
  mkdirSync(profile, { recursive: true })
  writeLock(profile, {
    ...emptyLock('bench', '0.1.0'),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: Object.fromEntries(
      ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((name) => [
        name,
        { provider: 'local' },
      ]),
    ),
    policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
  })
  const manager = createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.1.0',
    references: async () => [],
  })
  for (let index = 0; index < 4; index++) {
    const id = `acme/bench-${index}`,
      dir = join(root, `source-${index}`)
    mkdirSync(dir)
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: id,
        version: '1.0.0',
        license: 'MIT',
        dependencies: {},
        exports: './index.mjs',
        agnes: {
          plugins: [
            { apiRange: '^5.0.0', export: 'runtime', id: `ext:bench-${index}/main`, runtime: 'in-process' },
          ],
        },
      }),
    )
    writeFileSync(join(dir, 'index.mjs'), 'export const runtime = { apply() {} }\n')
    for (let file = 0; file < 20; file++)
      writeFileSync(join(dir, `payload-${file}.txt`), 'x'.repeat(32 * 1024))
    const source = parseSource(`file:${dir.split(sep).join('/')}`),
      preview = await manager.inspect(profile, source)
    await manager.install(profile, source, { expectedIntegrity: preview.integrity })
    const row = (await manager.inventory(profile)).packages.find((row) => row.id === id)!
    await manager.trust(profile, id, { integrity: row.entry.integrity, capabilityHash: row.capabilityHash })
    for (let pin = 0; pin < 3; pin++)
      await manager.pinRuntimeSnapshot(profile, {
        pinId: `bench-${index}-${pin}`,
        operationId: `bench-${index}-${pin}`,
        packageId: id,
        purpose: 'candidate',
        selector: {
          kind: 'installed',
          expectedIntegrity: row.entry.integrity,
          expectedTreeIntegrity: row.entry.treeIntegrity!,
        },
      })
  }
  await new Promise<void>((yes) => server.listen(0, '127.0.0.1', yes))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing benchmark listener')
  let reads = 0,
    bytes = 0
  fs.readFileSync = ((...args: Parameters<typeof originalRead>) => {
    const value = originalRead(...args)
    if (typeof args[0] === 'string' && resolve(args[0]).startsWith(`${root}${sep}`)) {
      reads++
      bytes += typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength
    }
    return value
  }) as typeof originalRead
  syncBuiltinESMExports()
  const light: number[] = [],
    inventory: number[] = [],
    pins: number[] = []
  lag.enable()
  for (let round = 0; round < 10; round++) {
    const requests = Array.from({ length: 10 }, async () => {
      const start = performance.now()
      const response = await fetch(`http://127.0.0.1:${address.port}/light`)
      if (response.status !== 204) throw new Error('probe failed')
      light.push(performance.now() - start)
    })
    await setImmediate()
    let start = performance.now()
    const result = await manager.inventory(profile)
    inventory.push(performance.now() - start)
    if (result.packages.length !== 4) throw new Error('lost package')
    start = performance.now()
    const resultPins = await manager.listRuntimePins(profile)
    pins.push(performance.now() - start)
    if (resultPins.length !== 12) throw new Error('lost pin')
    await Promise.all(requests)
  }
  const stats = (values: number[]) => {
    const sorted = values.toSorted((a, b) => a - b)
    return {
      samples: values.length,
      max: sorted.at(-1),
      p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      p99: sorted[Math.ceil(sorted.length * 0.99) - 1],
    }
  }
  console.log(
    JSON.stringify(
      {
        pathSeparator: sep,

        node: process.version,
        packages: 4,
        snapshots: 4,
        pins: 12,
        inventoryMs: stats(inventory),
        pinsMs: stats(pins),
        lightMs: stats(light),
        loopMaxMs: lag.max / 1e6,
        fileReads: reads,
        fileBytes: bytes,
      },
      null,
      2,
    ),
  )
} finally {
  fs.readFileSync = originalRead
  syncBuiltinESMExports()
  lag.disable()
  server.closeAllConnections()
  await new Promise<void>((yes) => server.close(() => yes()))
  cleanup()
}
