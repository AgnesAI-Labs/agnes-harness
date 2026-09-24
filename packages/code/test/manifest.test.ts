import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Disposer, ExtensionAPI, ToolDef } from '@agnes/extension-api'
import { checkApiRange, checkManifest, checkToolDef, extEventType } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { CODE_MODE_EVENTS, CODE_MODE_EXT_ID, codeModeExtension as factory } from '../src/index.js'

const manifestPath = fileURLToPath(
  new URL('../src/extensions/code-mode/agnes.extension.json', import.meta.url),
)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>

describe('code-mode manifest', () => {
  it('passes the shared manifest check', () => {
    const checked = checkManifest(manifest)
    expect(checked.ok, checked.ok ? '' : checked.problems.join('; ')).toBe(true)
  })

  // R5 (2026-09-09): the stale draft used `"apiRange": "^0.1"`, which the real, shipped
  // API_VERSION ('1.0.0') does not satisfy. `checkApiRange` throws `E_API_RANGE` on a mismatch —
  // not throwing is the assertion that the range actually admits the live version.
  it('declares an apiRange the real, shipped API_VERSION satisfies', () => {
    expect(() => checkApiRange(manifest as { id: string; apiRange: string })).not.toThrow()
  })

  it('declares exactly the capabilities code 稿 §6.1 lists', () => {
    expect(manifest.id).toBe(CODE_MODE_EXT_ID)
    const caps = manifest.capabilities as Record<string, unknown>
    expect((caps.tools as { names: string[] }).names).toEqual(['run_code'])
    expect(caps.hooks).toEqual(['session_start', 'before_compact', 'shutdown'])
    expect(caps['tools.invoke']).toBe(true)
    expect(caps.artifacts).toBe(true)
    expect(caps.subagent).toBe(true)
  })

  // R5: `capabilities.events` is a boolean permission in the real manifest schema
  // (`packages/protocol/schema/extension-manifest.json`), not an array of event names. The stale
  // draft wrote `"events": ["snapshot", "kernel", "sdk-skipped"]`, which the real schema rejects.
  it('declares events as the boolean permission the real manifest schema expects, not an array', () => {
    const caps = manifest.capabilities as Record<string, unknown>
    expect(caps.events).toBe(true)
    expect(Array.isArray(caps.events)).toBe(false)
  })

  // The event *names* this extension may use live in CODE_MODE_EVENTS, a plain code-package
  // constant — entirely separate from the manifest's boolean `events` permission above.
  it('names its events under its own namespace via the separate CODE_MODE_EVENTS whitelist', () => {
    expect(CODE_MODE_EVENTS).toEqual(['snapshot', 'kernel', 'sdk-skipped'])
    expect(extEventType(CODE_MODE_EXT_ID, 'snapshot')).toBe('x/agnes/code-mode/snapshot')
  })

  it('declares no slots and no network', () => {
    const caps = manifest.capabilities as Record<string, unknown>
    expect(caps.slots).toEqual([])
    expect(caps.network).toEqual([])
  })

  it('points at an entry file that actually exists next to it', () => {
    const entry = manifest.entry as string
    expect(entry).toBe('./index.ts')
    const entryPath = fileURLToPath(
      new URL(`../src/extensions/code-mode/${entry.replace(/^\.\//, '')}`, import.meta.url),
    )
    expect(readFileSync(entryPath, 'utf8').length).toBeGreaterThan(0)
  })
})

describe('code-mode extension entry', () => {
  // R5: the stale draft wrote `defineExtension((api, ctx) => {...})`, a two-parameter factory.
  // The real, current signature in `packages/extension-api/src/extension.ts` is
  // `ExtensionFactory = (agnes: ExtensionAPI) => ...` — exactly one parameter; the context comes
  // from `agnes.ctx`, not a second argument.
  it('is a single-parameter factory (agnes: ExtensionAPI), not (api, ctx)', () => {
    expect(factory.length).toBeLessThanOrEqual(1)
  })

  // R5 forbids an empty no-op factory ("不提交无注册工厂为完成"). This verifies the factory
  // registers a real hook and that the hook's handler performs a real, observable action — not a
  // placeholder. Verified at the unit/testkit level here; full production end-to-end verification
  // through the real ext-host is an I5 deliverable (2026-09-10 ruling), not this task's.
  it('registers run_code and a real session_start hook, and disposes both', async () => {
    const registeredHooks: string[] = []
    const registeredTools: ToolDef[] = []
    const appended: Array<{ name: string; data: unknown }> = []
    let disposed = 0
    const api = {
      registerTool: (tool: ToolDef) => {
        registeredTools.push(tool)
        return () => {
          disposed++
        }
      },
      registerHook: (event: string, handler: (payload: unknown, ctx: unknown) => unknown) => {
        registeredHooks.push(event)
        void handler(undefined, undefined)
        return () => {
          disposed++
        }
      },
      events: {
        append: async (name: string, data: unknown) => {
          appended.push({ name, data })
          return 0
        },
      },
    } as unknown as ExtensionAPI

    const dispose = (await factory(api)) as Disposer
    expect(registeredTools.map((tool) => tool.name)).toEqual(['run_code'])
    expect(checkToolDef(registeredTools[0])).toEqual({ ok: true })
    await expect(registeredTools[0]?.execute({ code: 'print(1)' }, {} as never)).rejects.toThrow(
      'E_PRESET_UNSUPPORTED: code runtime lifecycle is not wired yet',
    )
    expect(registeredHooks).toEqual(['session_start'])
    // Let the handler's microtask (the awaited events.append call) settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(appended).toEqual([{ name: 'kernel', data: { alive: false } }])
    expect(typeof dispose).toBe('function')
    dispose()
    expect(disposed).toBe(2)
  })
})

describe('package.json declares the extension', () => {
  // R5: "Task8必须修改code package.json的agnes.extensions声明，真实加载入口" — a manifest file
  // sitting in a directory nobody points at is not discoverable by a real package loader.
  it('lists the code-mode extension under agnes.extensions, following the @agnes/base pattern', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { agnes?: { extensions?: string[] } }
    expect(pkg.agnes?.extensions).toContain('./src/extensions/code-mode')
  })
})
