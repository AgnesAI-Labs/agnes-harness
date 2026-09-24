import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { checkToolDef, type ExtensionAPI } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import factory from '../src/index.js'
import { compactTool } from '../src/tool.js'

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../agnes.extension.json', import.meta.url)), 'utf8'),
) as {
  entry: string
  capabilities: { tools?: { prefix: string; names: string[] }; hooks: string[]; events: boolean }
}

describe('compact tool', () => {
  it('is valid and requests compaction through the tool context', async () => {
    expect(checkToolDef(compactTool)).toEqual({ ok: true })
    const ctx = fakeToolContext()
    const seen: Array<string | undefined> = []
    ctx.requestCompaction = (instructions) => seen.push(instructions)
    const result = await compactTool.execute({ instructions: 'focus on tests' }, ctx)
    expect(seen).toEqual(['focus on tests'])
    expect(result).toEqual({ content: [{ type: 'text', text: 'compaction requested' }] })
  })
})

describe('staged compaction extension', () => {
  it('registers only the tool before managed Host hook assembly is available', async () => {
    const registered: string[] = []
    const disposed: string[] = []
    const api = {
      registerHook: (event: string) => registered.push(`hook:${event}`),
      registerTool: (tool: { name: string }) => {
        registered.push(`tool:${tool.name}`)
        return () => disposed.push(`tool:${tool.name}`)
      },
    } as unknown as ExtensionAPI

    const dispose = await factory(api)
    expect(registered).toEqual(['tool:compact'])
    expect(manifest.capabilities.hooks).toEqual([])
    expect(manifest.capabilities.tools).toEqual({ prefix: '', names: ['compact'] })
    expect(manifest.capabilities.events).toBe(false)
    expect(manifest.entry).toBe('./src/index.ts')
    dispose?.()
    expect(disposed).toEqual(['tool:compact'])
  })
})
