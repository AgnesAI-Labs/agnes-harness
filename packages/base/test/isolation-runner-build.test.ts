import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  buildHooksIsolationRunner,
  HOOKS_RUNNER_ENTRY,
  HOOKS_RUNNER_MANIFEST,
} from '../tools/build-isolation-runner.js'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('builds one self-contained runner and a matching immutable manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-runner-build-'))
  directories.push(root)
  const output = join(root, 'isolation')
  const manifest = await buildHooksIsolationRunner(output)
  const bytes = readFileSync(join(output, HOOKS_RUNNER_ENTRY))
  const second = join(root, 'different-depth', 'isolation-second')
  const secondManifest = await buildHooksIsolationRunner(second)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.sha256)
  expect(JSON.parse(readFileSync(join(output, HOOKS_RUNNER_MANIFEST), 'utf8'))).toEqual(manifest)
  expect(secondManifest).toEqual(manifest)
  expect(readFileSync(join(second, HOOKS_RUNNER_ENTRY))).toEqual(bytes)
  // The builder checks actual esbuild import metadata; Babel parser strings also contain "from".
  // Running the artifact below from a fresh temp tree additionally checks its real bootstrap.
  expect(manifest.node).toEqual({ minimum: '24.10.0', major: 24 })
  const environment = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}
  const run = spawnSync(process.execPath, [join(output, HOOKS_RUNNER_ENTRY)], {
    env: environment,
    input: Buffer.alloc(0),
  })
  expect(run.status).toBe(0)
  const length = run.stdout.readUInt32BE(0)
  expect(JSON.parse(run.stdout.subarray(4, length + 4).toString())).toMatchObject({
    protocol: 1,
    kind: 'hello',
  })
}, 15_000)
