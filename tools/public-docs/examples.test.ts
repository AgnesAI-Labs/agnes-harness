import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { Context } from '../../packages/cordis/src/index.js'
import {
  checkServiceDef,
  checkToolDef,
  type ServiceDef,
  type ToolDef,
} from '../../packages/extension-api/src/index.js'
import { parseAgnesPluginEntries } from '../../packages/package-manager/src/plugin-manifest.js'
import { validateAgainst } from '../../packages/protocol/src/validate.js'
import {
  AgnesClientService,
  type ClientModule,
  CommandService,
  clientModule,
  type HostAgnesClient,
  LocaleService,
  type ModuleIdentity,
  SessionService,
  SlotRegistry,
  ThemeService,
} from '../../packages/web-client/src/index.js'

const exampleUrl = (path: string) => new URL(`../../examples/packages/${path}`, import.meta.url)
const moduleAt = (path: string) => import(exampleUrl(path).href)

async function browserHarness(sessionId?: string, call?: (name: string) => Promise<unknown>) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  // These examples only use the host-provided service relay, never a fabricated network client.
  new AgnesClientService(ctx, {} as HostAgnesClient, async (_module, _session, name) => {
    if (!call) throw new Error('relay unavailable')
    return call(name)
  })
  new CommandService(ctx, async () => false)
  new SessionService(ctx, sessionId)
  new ThemeService(ctx, 'light')
  new LocaleService(ctx, 'zh-CN')
  const slots = ctx.get('slots') as SlotRegistry
  // In the product this declaration belongs to the mounted shell, not to the plugin.
  slots.declare('ui:sidebar', { kind: 'single', scope: 'root' }, 'docs-shell-fixture')
  const text = () =>
    slots.entriesOfSlot('ui:sidebar').map((entry) => {
      if (typeof entry.component !== 'function') throw new Error('expected example function component')
      return (entry.component as () => string)()
    })
  return { ctx, slots, text }
}

const identity = (packageId: string, services: string[] = []): ModuleIdentity => ({
  packageId,
  revision: 'docs-fixture',
  allowedSlots: ['ui:sidebar'],
  services,
})

describe('public documentation examples (no provider, no daemon)', () => {
  it('loads the actual backend export, validates its schema and executes its documented result', async () => {
    const pkg = JSON.parse(await readFile(exampleUrl('hot-tool-plugin/package.json'), 'utf8'))
    const [declaration] = parseAgnesPluginEntries(pkg.name, pkg.agnes.plugins)
    expect(declaration?.inject).toEqual(['extension'])
    const mod = await moduleAt('hot-tool-plugin/index.mjs')
    let tool: ToolDef | undefined
    const hooks: string[] = []
    // Registration capture is a fixture, not a claim of Host authorization or OS isolation.
    mod.textStatsTool.apply({
      extension: () => ({
        registerTool(def: ToolDef) {
          tool = def
        },
        on(event: string) {
          hooks.push(event)
        },
      }),
    })
    if (!tool) throw new Error('example did not register its tool')
    expect(checkToolDef(tool, { prefix: '' })).toMatchObject({ ok: true })
    expect(validateAgainst(tool.parameters, { text: 'hello world' }).ok).toBe(true)
    expect(validateAgainst(tool.parameters, { text: 42 }).ok).toBe(false)
    expect(validateAgainst(tool.parameters, { text: 'a', extra: true }).ok).toBe(false)
    expect(validateAgainst(tool.parameters, { text: 'a'.repeat(8193) }).ok).toBe(false)
    expect((await tool.execute({ text: 'hello world' }, {} as never)).structured).toEqual({
      characters: 11,
      words: 2,
    })
    expect((await tool.execute({ text: '' }, {} as never)).structured).toEqual({ characters: 0, words: 0 })
    expect(hooks).toEqual(['session_start'])
  })

  it.each(['v1', 'v2'])(
    'mounts the shipped %s client panel in a real Cordis fiber and cleans it up',
    async (v) => {
      const h = await browserHarness()
      try {
        const mod: ClientModule = await moduleAt(`client-panel/${v}/extensions/main/client/index.js`)
        const fiber = h.ctx.plugin(clientModule(mod), identity('@agnes-examples/client-panel'))
        await fiber.await()
        expect(h.text()).toContain(`Agnes client module demo · ${v}`)
        await fiber.dispose()
        expect(h.slots.entriesOfSlot('ui:sidebar')).toHaveLength(0)
      } finally {
        await h.ctx.fiber.dispose()
      }
    },
  )

  it('links the actual query handler to the actual client through a local relay fixture', async () => {
    const backend = await moduleAt('client-service-panel/v1/extensions/main/index.mjs')
    let service: ServiceDef | undefined
    backend.runtime.apply({ services: { register: (def: ServiceDef) => (service = def) } })
    if (!service) throw new Error('example did not register its service')
    const definition = service
    expect(checkServiceDef(definition)).toMatchObject({ ok: true })
    const called: string[] = []
    const h = await browserHarness('docs-session', async (name) => {
      called.push(name)
      expect(name).toBe(definition.name)
      return definition.handler({}, {} as never)
    })
    try {
      const mod: ClientModule = await moduleAt('client-service-panel/v1/extensions/main/client/index.js')
      const fiber = h.ctx.plugin(
        clientModule(mod),
        identity('@agnes-examples/client-service-panel', ['panel.version']),
      )
      await fiber.await()
      await expect.poll(() => h.text()).toContain('Agnes client service demo · v1 · backend 1.0.0')
      expect(called).toEqual(['panel.version'])
      await fiber.dispose()
      expect(h.text()).toEqual([])
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it.each(['no-session', 'no-allowlist'])('refuses the client relay with %s', async (failure) => {
    let calls = 0
    const h = await browserHarness(failure === 'no-session' ? undefined : 'docs-session', async () => {
      calls++
      return { version: 'should-not-run' }
    })
    try {
      const mod: ClientModule = await moduleAt('client-service-panel/v1/extensions/main/client/index.js')
      const fiber = h.ctx.plugin(
        clientModule(mod),
        identity('@agnes-examples/client-service-panel', failure === 'no-allowlist' ? [] : ['panel.version']),
      )
      await fiber.await()
      await expect.poll(() => h.text()).toContain('Agnes client service demo · v1 · unavailable')
      expect(calls).toBe(0)
    } finally {
      await h.ctx.fiber.dispose()
    }
  })
})
