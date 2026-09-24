import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Disposer, ExtensionAPI, ToolDef } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import factory, { TOOLS_SEARCH } from '../src/index.js'

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../agnes.extension.json', import.meta.url)), 'utf8'),
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

describe('tools-search manifest', () => {
  it('declares the three search tool names with no prefix', () => {
    expect(manifest.id).toBe('agnes/tools-search')
    expect(manifest.capabilities.tools.prefix).toBe('')
    expect(manifest.capabilities.tools.names).toEqual(['grep', 'find', 'ls'])
  })

  it('claims only the capabilities these tools use', () => {
    // Every entry here is an authority the host grants on the strength of this file, so an empty
    // list is a claim in its own right: no hooks, no slots, no resources, and no network of its
    // own — these tools only read the workspace tree.
    expect(manifest.capabilities.hooks).toEqual([])
    expect(manifest.capabilities.slots).toEqual([])
    expect(manifest.capabilities.resources).toEqual([])
    expect(manifest.capabilities.network).toEqual([])
    // Output larger than the guard allows is stored as an artifact, which the shared output guard
    // does on behalf of all three tools here.
    expect(manifest.capabilities.artifacts).toBe(true)
    // None of grep/find/ls appends an extension event.
    expect(manifest.capabilities.events).toBe(false)
  })

  it('points at an entry file that exists, and an api range', () => {
    expect(manifest.entry).toBe('./src/index.ts')
    // Asserting the string alone would certify a manifest pointing at nothing: the host loads this
    // path, so the file has to be there for the declaration to mean anything.
    const entry = fileURLToPath(new URL(`../${manifest.entry.replace(/^\.\//, '')}`, import.meta.url))
    expect(existsSync(entry), entry).toBe(true)
    expect(manifest.apiRange).toBe('^1.0')
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('registers only tool names the manifest declares, and disposes every one', async () => {
    const registered: string[] = []
    const disposed: string[] = []
    const api = {
      registerTool: (d: ToolDef): Disposer => {
        registered.push(d.name)
        return () => {
          disposed.push(d.name)
        }
      },
    } as unknown as ExtensionAPI
    const dispose = (await factory(api)) as Disposer
    expect(registered).toEqual(TOOLS_SEARCH.map((t) => t.name))
    // The manifest is what the host grants authority on, and the code is what claims it. Comparing
    // the two lists whole, in order, is what makes a name declared and never registered - or worse,
    // registered under a name the manifest does not carry - fail here rather than at assembly.
    expect(registered).toEqual(manifest.capabilities.tools.names)
    dispose()
    expect(disposed).toEqual(registered)
  })
})
