import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimes } from '@agnes/code'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import type { InferenceEvent, JsonValue } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { parse } from 'yaml'
import { createTestHost } from '../testkit/index.js'

const dirs = ['../../base/presets/', '../../code/presets/'].map((p) => new URL(p, import.meta.url))
const docs: Record<string, PresetDoc> = Object.fromEntries(
  dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith('.yaml'))
      .map((name) => {
        const doc = parse(readFileSync(new URL(name, dir), 'utf8')) as PresetDoc
        return [doc.name, doc] as const
      }),
  ),
)

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const call = (name: string, args: Record<string, JsonValue>): InferenceEvent[] => [
  { type: 'toolcall_end', call: { toolUseId: '', name, args, ordinal: 0 }, via: 'native' },
  { type: 'done', reason: 'toolUse' },
]
const finish: InferenceEvent[] = [
  { type: 'text_delta', delta: 'done' },
  { type: 'done', reason: 'stop' },
]

it('shows the minimal recipe only the read tools and runs nothing else', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-minimal-tools-'))
  roots.push(dataDir)
  const target = join(dataDir, 'blocked.txt')
  const { base, ...product } = docs
  const { host } = await createTestHost({
    dataDir,
    allowed: Object.keys(product),
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
    packages: {
      '@agnes/base': { presets: { base: base as PresetDoc } },
      '@agnes/code': { presets: product, runtimes },
    },
    script: [call('write', { path: target, content: 'x' }), finish],
  })
  const minimal = await host.createSession({ cwd: dataDir, preset: 'minimal' })
  expect(
    minimal
      .currentTools()
      .list()
      .map((tool) => tool.name)
      .sort(),
  ).toEqual(['find', 'grep', 'ls', 'read'])
  expect(minimal.currentTools().resolve('write')).toBeUndefined()
  // A model that asks for a hidden tool anyway is refused by the loop, and nothing is written.
  await minimal.enqueue('next-turn', {
    content: [{ type: 'text', text: 'write blocked.txt' }],
    actor: minimal.d.actor,
    kind: 'prompt',
  })
  await minimal.run({ until: 'turn-end', signal: new AbortController().signal })
  expect(existsSync(target)).toBe(false)
  await minimal.close()
  const standard = await host.createSession({ key: 'standard-tools', cwd: dataDir, preset: 'standard' })
  expect(standard.currentTools().resolve('write')).toBeDefined()
  await standard.close()
  await host.close()
})
