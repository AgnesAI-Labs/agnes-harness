import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildLegacySession } from '../packages/daemon/test/attachment-open/build.js'
import { measureColdLoad } from '../packages/daemon/test/attachment-open/measure.js'

// Builds a session that carries one large inline attachment, then opens it cold through a real
// supervisor and worker and prints what the open cost, in the shape the end-to-end test records.
// Not a CI gate and no assertion: it exists to take the same measurement on a machine the test
// suite does not run on.
//   pnpm bench:attachment-open --mb 95 --kind zip --dir <path> --out <json>
const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const mb = Number(flag('--mb') ?? 95)
if (!Number.isSafeInteger(mb) || mb <= 0) throw new Error('--mb must be a positive integer')
const kind = flag('--kind') ?? 'zip'
if (kind !== 'zip' && kind !== 'images') throw new Error('--kind must be zip or images')
const queuedBehind = Number(flag('--queued') ?? (kind === 'zip' ? 2 : 0))
const prefixTurns = Number(flag('--turns') ?? 20)
const given = flag('--dir')
const out = flag('--out')

const dir = given ?? mkdtempSync(join(tmpdir(), 'agh-open-bench-'))
mkdirSync(dir, { recursive: true })
try {
  await buildLegacySession(dir, { attachmentMB: mb, kind, queuedBehind, prefixTurns })
  const result = await measureColdLoad(dir)
  const machine = { platform: process.platform, arch: process.arch } // guards-allow-platform: the report names the machine it was taken on.
  const text = `${JSON.stringify({ ...machine, node: process.versions.node, mb, kind, result }, null, 2)}\n`
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
