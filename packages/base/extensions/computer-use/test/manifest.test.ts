import { readFileSync } from 'node:fs'
import type { HookHandler } from '@agnes/extension-api'
import { checkToolDef, type ToolDef } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import blockedComputerUseExtension, { createComputerUseExtension } from '../src/index.js'

describe('computer-use extension boundary', () => {
  it('declares and registers only the consolidated computer_use wrapper', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../agnes.extension.json', import.meta.url), 'utf8'),
    ) as { capabilities: { tools: { names: string[] } } }
    expect(manifest.capabilities.tools.names).toEqual(['computer_use'])

    const registered: ToolDef[] = []
    const disposed: string[] = []
    let compact: HookHandler<'compact'> | undefined
    let shutdown: HookHandler<'shutdown'> | undefined
    const disposeProvider = vi.fn(async () => undefined)
    const factory = createComputerUseExtension({
      dispose: disposeProvider,
      acquire: async () => {
        throw new Error('not called during registration')
      },
    })
    const dispose = factory({
      registerTool(tool: ToolDef) {
        registered.push(tool)
        return () => disposed.push(tool.name)
      },
      registerHook(event: string, handler: HookHandler<'compact'> | HookHandler<'shutdown'>) {
        if (event === 'compact') compact = handler as HookHandler<'compact'>
        else if (event === 'shutdown') shutdown = handler as HookHandler<'shutdown'>
        else throw new Error(`unexpected hook ${event}`)
        return () => disposed.push(event)
      },
    } as never)

    expect(registered.map((tool) => tool.name)).toEqual(['computer_use'])
    expect(checkToolDef(registered[0] as ToolDef)).toEqual({ ok: true })
    expect(registered.map((tool) => tool.name)).not.toContain('capture')
    expect(compact).toBeTypeOf('function')
    expect(shutdown).toBeTypeOf('function')
    expect(dispose).toBeTypeOf('function')
    ;(dispose as () => void)()
    expect(disposed).toEqual(['shutdown', 'compact', 'computer_use'])
    expect(disposeProvider).not.toHaveBeenCalled()
  })

  it('releases the departing session without destroying the Host-owned provider', async () => {
    const release = vi.fn(async () => undefined)
    const disposeProvider = vi.fn(async () => undefined)
    let shutdown: HookHandler<'shutdown'> | undefined
    const factory = createComputerUseExtension({
      acquire: async () => {
        throw new Error('not called')
      },
      release,
      dispose: disposeProvider,
    })
    const dispose = factory({
      registerTool: () => () => undefined,
      registerHook(event: string, handler: HookHandler<'shutdown'>) {
        if (event === 'shutdown') shutdown = handler
        return () => undefined
      },
    } as never)
    const session = fakeToolContext().session
    await shutdown?.({} as never, { session } as never)
    ;(dispose as () => void)()
    expect(release).toHaveBeenCalledExactlyOnceWith(session)
    expect(disposeProvider).not.toHaveBeenCalled()
  })

  it('ships the extension entry but keeps direct loading fail-closed without the Host provider', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      agnes?: { extensions?: string[] }
    }
    expect(pkg.agnes?.extensions ?? []).toContain('./extensions/computer-use')
    expect(() => blockedComputerUseExtension({} as never)).toThrow('Host-owned backend provider')
  })

  it('resets screenshot dedup for the compacted session', async () => {
    const registered: ToolDef[] = []
    let compact: HookHandler<'compact'> | undefined
    const factory = createComputerUseExtension({
      acquire: async () => ({
        profileHash: 'profile-a',
        generation: 1,
        runtimePolicy: {
          mode: 'standard',
          authorization: 'driver-standard',
          sessionKey: 'agnes:t:a:cli:dm:x',
          lane: 'main',
        },
        modifierActions: [],
        call: async () => ({
          mode: 'som',
          width: 100,
          height: 80,
          target: { app: 'Notes', pid: 7, window_id: 9 },
          elements: [],
          image: {
            ref: { sha256: 'a'.repeat(64), size: 20, mime: 'image/png' },
            mime: 'image/png',
            width: 100,
            height: 80,
            digest: 'a'.repeat(64),
          },
        }),
      }),
    })
    const dispose = factory({
      registerTool(tool: ToolDef) {
        registered.push(tool)
        return () => undefined
      },
      registerHook(event: string, handler: HookHandler<'compact'>) {
        if (event === 'compact') compact = handler
        return () => undefined
      },
    } as never)
    const ctx = fakeToolContext()
    const tool = registered[0] as ToolDef
    expect(
      (await tool.execute({ action: 'capture' }, ctx)).content.some((part) => part.type === 'image'),
    ).toBe(true)
    expect(
      (await tool.execute({ action: 'capture' }, ctx)).content.some((part) => part.type === 'image'),
    ).toBe(false)
    await compact?.({} as never, { session: ctx.session } as never)
    expect(
      (await tool.execute({ action: 'capture' }, ctx)).content.some((part) => part.type === 'image'),
    ).toBe(true)
    ;(dispose as () => void)()
  })

  it('lets compaction win over an in-flight capture artifact spill', async () => {
    let releaseArtifact: () => void = () => undefined
    let artifactStarted: () => void = () => undefined
    const artifactGate = new Promise<void>((resolve) => {
      releaseArtifact = resolve
    })
    const artifactEntered = new Promise<void>((resolve) => {
      artifactStarted = resolve
    })
    let compact: HookHandler<'compact'> | undefined
    const registered: ToolDef[] = []
    const elements = Array.from({ length: 101 }, (_, index) => ({
      index: index + 1,
      role: 'button',
      label: `button-${index}`,
      bounds: [1, 2, 3, 4],
    }))
    const factory = createComputerUseExtension({
      acquire: async () => ({
        profileHash: 'profile-a',
        generation: 1,
        runtimePolicy: {
          mode: 'standard',
          authorization: 'driver-standard',
          sessionKey: 'agnes:t:a:cli:dm:x',
          lane: 'main',
        },
        modifierActions: [],
        call: async () => ({
          mode: 'som',
          width: 100,
          height: 80,
          target: { app: 'Notes', pid: 7, window_id: 9 },
          elements,
          image: {
            ref: { sha256: 'a'.repeat(64), size: 20, mime: 'image/png' },
            mime: 'image/png',
            width: 100,
            height: 80,
            digest: 'a'.repeat(64),
          },
        }),
      }),
    })
    const dispose = factory({
      registerTool(tool: ToolDef) {
        registered.push(tool)
        return () => undefined
      },
      registerHook(event: string, handler: HookHandler<'compact'>) {
        if (event === 'compact') compact = handler
        return () => undefined
      },
    } as never)
    const blocked = fakeToolContext()
    const originalPut = blocked.artifacts.put
    blocked.artifacts.put = async (...args) => {
      artifactStarted()
      await artifactGate
      return originalPut(...args)
    }
    const tool = registered[0] as ToolDef
    const inFlight = tool.execute({ action: 'capture' }, blocked)
    await artifactEntered
    await compact?.({} as never, { session: blocked.session } as never)
    releaseArtifact()
    await inFlight
    const next = await tool.execute({ action: 'capture' }, fakeToolContext())
    expect(next.content.some((part) => part.type === 'image')).toBe(true)
    ;(dispose as () => void)()
  })
})
