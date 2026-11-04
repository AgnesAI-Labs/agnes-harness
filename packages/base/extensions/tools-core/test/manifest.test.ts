import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Disposer, ToolDef } from '@agnes/extension-api'
import { bundledExtensionManifest } from '@agnes/extension-api'
import type { ExtensionAPI } from '@agnes/extension-api/host'
import { extensionFactoryOf } from '@agnes/plugin-runtime/bundled'
import { describe, expect, it } from 'vitest'
import { ShellJobs } from '../../jobs/src/registry.js'
import factory, { createToolsCoreExtension, TOOLS_CORE } from '../src/index.js'

const manifest = bundledExtensionManifest(
  JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')),
) as {
  id: string
  version: string
  apiRange: string
  entry: string
  capabilities: {
    tools: { prefix: string; names: string[] }
    hooks: string[]
    slots: string[]
    events: boolean
    resources: string[]
    network: string[]
    artifacts: boolean
  }
}

describe('tools-core manifest', () => {
  it.each([false, true])(
    'registers the descriptions selected by the resolved preset (%s)',
    async (enabled) => {
      const tools = new Map<string, ToolDef>()
      const api = {
        registerHook: () => () => {},
        registerTool: (tool: ToolDef) => {
          tools.set(tool.name, tool)
          return () => {}
        },
      } as unknown as ExtensionAPI
      const plugin = createToolsCoreExtension(new ShellJobs(), undefined, {
        tools: { logical_changes: enabled, ...(enabled ? { shell_observation_ms: 10_000 } : {}) },
      })
      const dispose = await extensionFactoryOf(plugin)(api)
      try {
        if (enabled) {
          expect(tools.get('edit')?.description).toContain('a later edit sees earlier replacements')
          expect(tools.get('shell')?.description).toContain('after 10000ms')
          expect(tools.get('shell')?.description).not.toContain('after 2 minutes')
        } else for (const tool of TOOLS_CORE) expect(tools.get(tool.name)?.description).toBe(tool.description)
      } finally {
        if (typeof dispose === 'function') await dispose()
      }
    },
  )
  it('declares the five core tool names with no prefix', () => {
    expect(manifest.id).toBe('agnes/tools-core')
    expect(manifest.capabilities.tools.prefix).toBe('')
    expect(manifest.capabilities.tools.names).toEqual(['read', 'write', 'edit', 'shell', 'todo'])
  })

  it('claims only the capabilities these tools use', () => {
    // Every entry here is an authority the host grants on the strength of this file, so an empty
    // list is a claim in its own right: shutdown cleans jobs; no slots, resources or network of its
    // own — the tools reach the network only through a command the model runs.
    expect(manifest.capabilities.hooks).toEqual(['shutdown'])
    expect(manifest.capabilities.slots).toEqual([])
    expect(manifest.capabilities.resources).toEqual([])
    expect(manifest.capabilities.network).toEqual([])
    // Output larger than the guard allows is stored as an artifact.
    expect(manifest.capabilities.artifacts).toBe(true)
    expect(manifest.capabilities.events).toBe(true)
  })

  it('points at an entry file that exists, and an api range', () => {
    expect(manifest.entry).toBe('./src/index.ts')
    // Asserting the string alone would certify a manifest pointing at nothing: the host loads this
    // path, so the file has to be there for the declaration to mean anything.
    const entry = fileURLToPath(new URL(`../${manifest.entry.replace(/^\.\//, '')}`, import.meta.url))
    expect(existsSync(entry), entry).toBe(true)
    expect(manifest.apiRange).toBe('^5.0.0')
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('registers only tool names the manifest declares, and disposes every one', async () => {
    const registered: string[] = []
    const disposed: string[] = []
    const hooks: string[] = []
    const api = {
      registerHook: (name: string) => {
        hooks.push(name)
        return () => {}
      },
      registerTool: (d: ToolDef): Disposer => {
        registered.push(d.name)
        return () => {
          disposed.push(d.name)
        }
      },
    } as unknown as ExtensionAPI
    const dispose = (await extensionFactoryOf(factory)(api)) as Disposer
    expect(registered).toEqual(TOOLS_CORE.map((t) => t.name))
    // The manifest is what the host grants authority on, and the code is what claims it. Comparing
    // the two lists whole, in order, is what makes a name declared and never registered - or worse,
    // registered under a name the manifest does not carry - fail here rather than at assembly.
    expect(registered).toEqual(manifest.capabilities.tools.names)
    expect(hooks).toEqual(manifest.capabilities.hooks)
    await dispose()
    expect(disposed).toEqual(registered)
  })
})
