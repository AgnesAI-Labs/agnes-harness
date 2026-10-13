import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildLegacySession } from '../packages/daemon/test/attachment-open/build.js'
import { measureColdLoad } from '../packages/daemon/test/attachment-open/measure.js'

// Builds a session that carries one large inline attachment, then opens it cold through a real
// supervisor and worker and prints what the open cost, in the shape the end-to-end test records.
// Not a CI gate and no assertion: it exists to take the same measurement on a machine the test
// suite does not run on.
//   pnpm bench:attachment-open --mib 95 --kind zip --dir <path> --out <json> [--queued 2] [--turns 20]
// --mib is the inline payload as the ledger stores it: MiB of base64 text (95 is about 71 MiB raw).
const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const count = (name: string, fallback: number, min: number): number => {
  const value = Number(flag(name) ?? fallback)
  if (!Number.isSafeInteger(value) || value < min)
    throw new Error(`${name} must be an integer of at least ${min}`)
  return value
}
const mib = count('--mib', 95, 1)
const kind = flag('--kind') ?? 'zip'
if (kind !== 'zip' && kind !== 'images') throw new Error('--kind must be zip or images')
const queuedBehind = count('--queued', kind === 'zip' ? 2 : 0, 0)
const prefixTurns = count('--turns', 20, 0)
const given = flag('--dir')
const out = flag('--out')

const dir = given ?? mkdtempSync(join(tmpdir(), 'agh-open-bench-'))
mkdirSync(dir, { recursive: true })
try {
  await buildLegacySession(dir, { attachmentMB: mib, kind, queuedBehind, prefixTurns })
  const result = await measureColdLoad(dir)
  const machine = { platform: process.platform, arch: process.arch } // guards-allow-platform: the report names the machine it was taken on.
  const text = `${JSON.stringify({ ...machine, node: process.versions.node, mib, kind, result }, null, 2)}\n`
  if (out) {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, text)
  }
  process.stdout.write(text)
} finally {
  if (!given) rmSync(dir, { recursive: true, force: true })
}
// The supervisor's worker pool and timers can outlive the measurement.
process.exit(0)
