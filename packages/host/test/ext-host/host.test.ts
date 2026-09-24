import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Disposer, ExtensionAPI, ToolDef } from '@agnes/extension-api'
import { beforeEach, describe, expect, it } from 'vitest'
import { createExtHost, type ExtHostOptions } from '../../src/ext-host/host.js'
import type { ToolPort } from '../../src/ext-host/index.js'
import { fixtureTool } from '../fixtures/tool.js'

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url))
const quiet = { debug() {}, info() {}, warn() {}, error() {} }

/** A tool table with the one method the extension host is given, and a way to read it back. */
class FakePort implements ToolPort {
  readonly table = new Map<string, ToolDef>()
  add(def: ToolDef): Disposer {
    if (this.table.has(def.name)) throw new Error(`duplicate ${def.name}`)
    this.table.set(def.name, def)
    return () => {
      this.table.delete(def.name)
    }
  }
  get names(): string[] {
    return [...this.table.keys()].sort()
  }
}

let port: FakePort
let events: Array<{ kind: string; detail: Record<string, unknown> }>
beforeEach(() => {
  port = new FakePort()
  events = []
})

const open = (packages: Record<string, string>, over: Partial<ExtHostOptions> = {}) =>
  createExtHost({
    packages: new Map(Object.entries(packages)),
    tools: port,
    log: quiet,
    audit: (kind, detail) => events.push({ kind, detail }),
    ...over,
  })

const byId = (status: ReturnType<Awaited<ReturnType<typeof open>>['status']>, id: string) => {
  const found = status.find((s) => s.id === id)
  if (!found) throw new Error(`no status for ${id}`)
  return found
}

describe('createExtHost', () => {
  it('loads a bundled extension and registers the tool its entry claimed', async () => {
    const ext = await open({ 'fixture/pkg': `${fixtures}/pkg-exts` })
    const ok = byId(ext.status(), 'fixture/ok')
    expect(ok.loaded).toBe(true)
    expect(ok.registered).toEqual(['fx_one'])
    expect(port.table.has('fx_one')).toBe(true)
    expect(events.some((e) => e.kind === 'extension.loaded' && e.detail.id === 'fixture/ok')).toBe(true)
  })

  it('a package that declares no extensions, or none at all, loads nothing and says nothing', async () => {
    const ext = await open({ '@agnes/nothing': fixtures })
    expect(ext.status()).toEqual([])
    expect(port.names).toEqual([])
  })

  it('records the package rather than the host when the declaration itself is malformed', async () => {
    const ext = await open({ 'fixture/bad': `${fixtures}/pkg-bad` })
    expect(byId(ext.status(), 'fixture/bad').error?.code).toBe('E_EXT_LOAD')
    expect(events.some((e) => e.kind === 'extension.failed')).toBe(true)
  })

  describe('the manifest is an upper bound', () => {
    it('a declared name nothing registers is simply not a tool', async () => {
      const ext = await open({ 'fixture/pkg': `${fixtures}/pkg-exts` })
      const ok = byId(ext.status(), 'fixture/ok')
      expect(ok.declared).toEqual(['fx_one', 'fx_two'])
      expect(ok.registered).toEqual(['fx_one'])
      expect(port.table.has('fx_two')).toBe(false)
    })

    it('a registered name the manifest does not declare voids the whole extension', async () => {
      const ext = await open({ 'fixture/pkg': `${fixtures}/pkg-exts` })
      const bad = byId(ext.status(), 'fixture/undeclared')
      expect(bad.loaded).toBe(false)
      expect(bad.error?.code).toBe('E_CAPABILITY_UNDECLARED')
      expect(bad.error?.message).toBe('extension capability not declared')
      // Not only the rogue name: the declared one it managed to register first is gone too, or the
      // refusal would have left half an extension standing.
      expect(port.table.has('fx_rogue')).toBe(false)
      expect(port.table.has('fx_declared')).toBe(false)
      expect(ext.residue('fixture/undeclared')).toEqual([])
    })

    it('refuses a name that misses the declared prefix even when nothing else is declared', async () => {
      const importModule = async () => ({
        default: (agnes: { registerTool: (d: ToolDef) => Disposer }) =>
          agnes.registerTool(fixtureTool('nope')),
      })
      const ext = await open({ 'fixture/pkg': `${fixtures}/pkg-exts` }, { importModule })
      expect(byId(ext.status(), 'fixture/throws').error?.code).toBe('E_CAPABILITY_UNDECLARED')
      expect(port.names).toEqual([])
    })
  })

  it('an entry that throws leaves nothing of that extension, and the others still load', async () => {
    const ext = await open({ 'fixture/pkg': `${fixtures}/pkg-exts` })
    const threw = byId(ext.status(), 'fixture/throws')
    expect(threw.loaded).toBe(false)
    expect(threw.error?.message).toBe('extension factory failed')
    expect(port.table.has('tx_one')).toBe(false)
    expect(ext.residue('fixture/throws')).toEqual([])
    // The one that loaded before it and the host itself are untouched.
    expect(byId(ext.status(), 'fixture/ok').loaded).toBe(true)
    expect(port.names).toEqual(['fx_one'])
  })

  it('refuses an entry that points outside its own extension directory', async () => {
    const ext = await open({ 'fixture/pkg': `${fixtures}/pkg-exts` })
    const escaped = byId(ext.status(), 'escape')
    expect(escaped.loaded).toBe(false)
    expect(escaped.error?.code).toBe('E_EXT_LOAD')
    expect(escaped.error?.message).toBe('invalid extension manifest')
  })

  it('refuses a second extension claiming an id already taken, and keeps the first', async () => {
    const ext = await open({
      'fixture/one': `${fixtures}/pkg-exts`,
      'fixture/two': `${fixtures}/pkg-exts`,
    })
    const dupes = ext.status().filter((s) => s.id === 'fixture/ok')
    expect(dupes.map((d) => d.loaded)).toEqual([true, false])
    expect(dupes[1]?.error?.message).toContain('second extension claims this id')
    expect(port.names).toEqual(['fx_one'])
    expect(ext.residue('fixture/ok')).toEqual(['fx_one'])
  })

  it('disposes every registration on disposeAll and leaves no residue', async () => {
    const ext = await open({ 'fixture/pkg': `${fixtures}/pkg-exts` })
    expect(port.names).toEqual(['fx_one'])
    await ext.disposeAll()
    expect(port.names).toEqual([])
    expect(ext.residue('fixture/ok')).toEqual([])
    expect(ext.status().every((s) => !s.loaded)).toBe(true)
    expect(ext.status().flatMap((s) => s.registered)).toEqual([])
  })

  it('grants registerTool and nothing else', async () => {
    const reached: string[] = []
    const importModule = async () => ({
      default: (agnes: Record<string, unknown>) => {
        for (const member of ['registerHook', 'registerSlot', 'registerResource']) {
          try {
            ;(agnes[member] as () => void)()
          } catch (e) {
            reached.push(`${member}:${(e as { code?: string }).code}`)
          }
        }
        for (const member of ['events', 'ctx']) {
          try {
            void agnes[member]
          } catch (e) {
            reached.push(`${member}:${(e as { code?: string }).code}`)
          }
        }
      },
    })
    await open({ 'fixture/pkg': `${fixtures}/pkg-exts` }, { importModule })
    // The stub entry is handed to every extension in the fixture package, so the same five
    // refusals arrive once per extension.
    expect([...new Set(reached)]).toEqual([
      'registerHook:E_CAPABILITY_UNDECLARED',
      'registerSlot:E_CAPABILITY_UNDECLARED',
      'registerResource:E_CAPABILITY_UNDECLARED',
      'events:E_CAPABILITY_UNDECLARED',
      'ctx:E_CAPABILITY_UNDECLARED',
    ])
  })

  it('refuses an entry module with no default export to call', async () => {
    const ext = await open(
      { 'fixture/pkg': `${fixtures}/pkg-exts` },
      { importModule: async () => ({ TOOLS: [] }) },
    )
    expect(byId(ext.status(), 'fixture/ok').error?.message).toContain('no default export')
  })
})

describe('extension cleanup accounting', () => {
  it('does not call the same returned registration disposer twice', async () => {
    const calls = new Map<string, number>()
    const tools: ToolPort = {
      add(def) {
        const off = port.add(def)
        return () => {
          calls.set(def.name, (calls.get(def.name) ?? 0) + 1)
          off()
        }
      },
    }
    const ext = await open({ 'fixture/pkg': `${fixtures}/pkg-exts` }, { tools })
    await ext.disposeAll()
    expect(calls.get('fx_one')).toBe(1)
    expect(port.names).toEqual([])
  })

  it('reports failed cleanup despite a throwing logger and retries it without losing residue', async () => {
    let failing = true
    const tools: ToolPort = {
      add(def) {
        const off = port.add(def)
        return () => {
          if (def.name === 'fx_one' && failing) throw new Error('release failed')
          off()
        }
      },
    }
    const ext = await open(
      { 'fixture/pkg': `${fixtures}/pkg-exts` },
      {
        tools,
        log: {
          ...quiet,
          warn: () => {
            throw new Error('logger failed')
          },
        },
      },
    )
    await expect(ext.disposeAll()).rejects.toThrow('extension cleanup incomplete')
    expect(ext.residue('fixture/ok')).toContain('fx_one')
    expect(ext.residue('fixture/ok')).toContain('disposer:pending')
    expect(port.names).toEqual(['fx_one'])
    expect(byId(ext.status(), 'fixture/ok').loaded).toBe(false)
    failing = false
    await ext.disposeAll()
    expect(ext.residue('fixture/ok')).toEqual([])
    expect(port.names).toEqual([])
  })

  it('retains partial load cleanup failures and retries them on disposeAll', async () => {
    let failing = true
    const tools: ToolPort = {
      add(def) {
        const off = port.add(def)
        return () => {
          if (def.name === 'tx_one' && failing) throw new Error('release failed')
          off()
        }
      },
    }
    const ext = await open({ 'fixture/pkg': `${fixtures}/pkg-exts` }, { tools })
    expect(byId(ext.status(), 'fixture/throws').loaded).toBe(false)
    expect(ext.residue('fixture/throws')).toContain('tx_one')
    expect(port.table.has('tx_one')).toBe(true)
    failing = false
    await ext.disposeAll()
    expect(port.names).toEqual([])
    expect(ext.residue('fixture/throws')).toEqual([])
  })
})

it('awaits asynchronous extension factory cleanup before disposeAll resolves', async () => {
  let released = 0
  const ext = await open(
    { 'fixture/pkg': `${fixtures}/pkg-exts` },
    {
      importModule: async () => ({
        default: () => async () => {
          await Promise.resolve()
          released++
        },
      }),
    },
  )
  const loaded = ext.status().filter((status) => status.loaded).length
  expect(loaded).toBeGreaterThan(0)
  await ext.disposeAll()
  expect(released).toBe(loaded)
  expect(ext.status().every((status) => !status.loaded)).toBe(true)
})

describe('factory registration lifetime', () => {
  it('allows async factory registration but closes the retained API after settlement', async () => {
    let retained: ExtensionAPI | undefined
    const ext = await open(
      { 'fixture/pkg': `${fixtures}/pkg-exts` },
      {
        importModule: async () => ({
          default: async (api: ExtensionAPI) => {
            if (retained) return
            retained = api
            await Promise.resolve()
            api.registerTool(fixtureTool('fx_one'))
          },
        }),
      },
    )
    expect(port.names).toEqual(['fx_one'])
    expect(() => retained?.registerTool(fixtureTool('fx_two'))).toThrow('outside factory')
    expect(port.names).toEqual(['fx_one'])
    await ext.disposeAll()
    expect(port.names).toEqual([])
  })

  it('closes a synchronous factory before its queued microtask can register', async () => {
    let scheduled = false
    const errors: unknown[] = []
    const ext = await open(
      { 'fixture/pkg': `${fixtures}/pkg-exts` },
      {
        importModule: async () => ({
          default: (api: ExtensionAPI) => {
            if (scheduled) return
            scheduled = true
            queueMicrotask(() => {
              try {
                api.registerTool(fixtureTool('fx_two'))
              } catch (error) {
                errors.push(error)
              }
            })
          },
        }),
      },
    )
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('outside factory')
    expect(port.names).toEqual([])
    await ext.disposeAll()
  })

  it.each(['throw', 'reject'])(
    'closes registration after factory %s and rolls back partial work',
    async (failure) => {
      let retained: ExtensionAPI | undefined
      const ext = await open(
        { 'fixture/pkg': `${fixtures}/pkg-exts` },
        {
          importModule: async () => ({
            default: (api: ExtensionAPI) => {
              if (retained) return
              retained = api
              api.registerTool(fixtureTool('fx_one'))
              if (failure === 'reject') return Promise.reject(new Error('factory failed'))
              throw new Error('factory failed')
            },
          }),
        },
      )
      expect(byId(ext.status(), 'fixture/ok').loaded).toBe(false)
      expect(port.names).toEqual([])
      expect(() => retained?.registerTool(fixtureTool('fx_two'))).toThrow('outside factory')
      await ext.disposeAll()
    },
  )
})

it('keeps arbitrary factory failures out of status, logger and audit while continuing other entries', async () => {
  const marker = 'synthetic-private-payload'
  const logged: unknown[] = []
  const ext = await open(
    { 'fixture/pkg': `${fixtures}/pkg-exts` },
    {
      importModule: async (file) => ({
        default: (api: ExtensionAPI) => {
          if (basename(dirname(file)) === 'ok') throw new Error(marker)
          if (basename(dirname(file)) === 'undeclared') api.registerTool(fixtureTool('fx_declared'))
        },
      }),
      log: {
        ...quiet,
        error: (...args) => {
          logged.push(args)
        },
      },
    },
  )
  expect(byId(ext.status(), 'fixture/ok').error).toEqual({
    code: 'E_EXT_LOAD',
    message: 'extension factory failed',
  })
  expect(byId(ext.status(), 'fixture/undeclared').loaded).toBe(true)
  expect(JSON.stringify({ status: ext.status(), logged, events })).not.toContain(marker)
  await ext.disposeAll()
})

it('does not inspect error accessors or coercion hooks', async () => {
  let reads = 0
  const failure = {
    get code() {
      reads++
      throw new Error('private code')
    },
    get message() {
      reads++
      throw new Error('private message')
    },
    toString() {
      reads++
      throw new Error('private coercion')
    },
  }
  const ext = await open(
    { 'fixture/pkg': `${fixtures}/pkg-exts` },
    {
      importModule: async () => {
        throw failure
      },
    },
  )
  expect(reads).toBe(0)
  expect(byId(ext.status(), 'fixture/ok').error).toEqual({
    code: 'E_EXT_LOAD',
    message: 'extension module evaluation failed',
  })
  await ext.disposeAll()
})

it('contains hostile error proxies and unknown error codes', async () => {
  let proxyInjected = false
  const ext = await open(
    { 'fixture/pkg': `${fixtures}/pkg-exts` },
    {
      importModule: async (file) => {
        if (basename(dirname(file)) === 'ok') {
          proxyInjected = true
          throw new Proxy(
            {},
            {
              getOwnPropertyDescriptor() {
                throw new Error('private proxy')
              },
            },
          )
        }
        throw { code: 'private-code', message: 'private-message' }
      },
    },
  )
  expect(proxyInjected).toBe(true)
  expect(byId(ext.status(), 'fixture/ok').error?.code).toBe('E_EXT_LOAD')
  expect(byId(ext.status(), 'fixture/throws').error?.code).toBe('E_EXT_LOAD')
  for (const marker of ['private-code', 'private-message', 'private proxy'])
    expect(JSON.stringify(ext.status())).not.toContain(marker)
  await ext.disposeAll()
})

it('isolates throwing and rejecting diagnostic sinks from loading and cleanup', async () => {
  const ext = await open(
    { 'fixture/pkg': `${fixtures}/pkg-exts` },
    {
      audit: () => {
        throw new Error('sink failed')
      },
      log: { ...quiet, error: () => Promise.reject(new Error('sink failed')) },
    },
  )
  expect(byId(ext.status(), 'fixture/ok').loaded).toBe(true)
  expect(byId(ext.status(), 'fixture/throws').loaded).toBe(false)
  await ext.disposeAll()
  expect(port.names).toEqual([])
})
