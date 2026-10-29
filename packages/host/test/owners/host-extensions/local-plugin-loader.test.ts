import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from '@agnes/cordis'
import { createPluginTestRegistration } from '@agnes/host/testkit'
import { createLoader } from '@agnes/host-extensions/ext-host/loader'
import { stageLocalPlugin } from '@agnes/package-manager'
import { createPluginTestHost } from '@agnes/plugin-runtime/testkit'
import { expect, it } from 'vitest'

it('loads zero-build TS tools and JS plugins through shared author helpers with independent activations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-local-loader-'))
  const source = join(root, 'author')
  mkdirSync(source)
  const loader = createLoader({ cacheDir: join(root, 'cache'), hostRoot: root, agnesVersion: '0.0.0' })
  const tool = (value: string) => `import { defineTool } from "@agnes/plugin-runtime"
import { Type } from "@sinclair/typebox"
export default defineTool({ name: "local_echo", description: "echo", parameters: Type.Object({}),
meta: { isReadOnly: true, isDestructive: false, isConcurrencySafe: true, isOpenWorld: false, replay: "safe", costHint: undefined, deferLoading: undefined, requiresApproval: "never" },
async execute() { const text: string = ${JSON.stringify(value)}; return { content: [{ type: "text", text }] } } })`
  try {
    writeFileSync(join(source, 'plugin.ts'), tool('old'))
    const candidate = {
      name: 'hello',
      directory: source,
      source: { type: 'local' as const, ref: 'local:home/hello' },
    }
    stageLocalPlugin(candidate, join(root, 'v1'))
    const old = await createPluginTestHost(
      (await loader.import(join(root, 'v1', '.agnes-local-entry.mjs'))).main as Plugin,
      { registration: createPluginTestRegistration() },
    )
    writeFileSync(join(source, 'plugin.ts'), tool('new'))
    stageLocalPlugin(candidate, join(root, 'v2'))
    const next = await createPluginTestHost(
      (await loader.import(join(root, 'v2', '.agnes-local-entry.mjs'))).main as Plugin,
      { registration: createPluginTestRegistration() },
    )
    try {
      expect((await old.invoke('local_echo', {})).content).toEqual([{ type: 'text', text: 'old' }])
      expect((await next.invoke('local_echo', {})).content).toEqual([{ type: 'text', text: 'new' }])
    } finally {
      await old.dispose()
      await next.dispose()
    }
    rmSync(join(source, 'plugin.ts'))
    writeFileSync(
      join(source, 'plugin.js'),
      'import { defineAgnesPlugin } from "@agnes/plugin-runtime"; export default defineAgnesPlugin({ apply() {} })',
    )
    stageLocalPlugin(candidate, join(root, 'v3'))
    const js = await createPluginTestHost(
      (await loader.import(join(root, 'v3', '.agnes-local-entry.mjs'))).main as Plugin,
      { registration: createPluginTestRegistration() },
    )
    await js.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
