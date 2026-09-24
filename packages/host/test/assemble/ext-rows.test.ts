import { buildRuntimeTarget, createPluginRow } from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_HOOK_RANKS,
  buildExtensionRow,
  composeExtensionRowTarget,
  createExtensionRowPlugin,
  EXT_ROW_EXTENSION_IDS,
  EXT_ROW_MOUNT_REVISION,
} from '../../src/assemble/ext-rows.js'

it('keeps the early Skills hook rank when Skills is also an ordinary builtin row id', () => {
  expect(BUILTIN_HOOK_RANKS.get('ext:agnes/skills')).toBe(0)
  expect(BUILTIN_HOOK_RANKS.get('ext:agnes/tools-core')).toBe(1)
  expect(BUILTIN_HOOK_RANKS.size).toBe(EXT_ROW_EXTENSION_IDS.size)
})

type Call = string
const fakeLoader = (calls: Call[], failWith?: string) =>
  Object.freeze({
    load: async (id: string) => {
      calls.push(`load:${id}`)
      return failWith
        ? { id, loaded: false, error: { code: 'E_EXT_LOAD', message: failWith } }
        : { id, loaded: true }
    },
    revoke: async (id: string, reason: string) => {
      calls.push(`revoke:${id}:${reason}`)
    },
  })
// `VerifiedRowEntry` only carries an OPAQUE `prepared` (plugin-runtime/src/row-mount.ts:35-39;
// the callback lives in a module-private WeakMap in packages/cordis/src/host.ts:35), so the row's
// apply/effect cannot be driven through the entry. That is why the lifecycle is its own exported
// factory: the test drives THAT, and buildExtensionRow just wraps it.
type RowPlugin = (ctx: unknown, config: unknown) => Promise<() => Promise<void>>
const pluginOf = (input: Parameters<typeof createExtensionRowPlugin>[0]): RowPlugin =>
  createExtensionRowPlugin(input) as unknown as RowPlugin

describe('buildExtensionRow', () => {
  it('builds an ext: row whose identity is the builtin ext-row mount revision', () => {
    const built = buildExtensionRow({
      extensionId: 'agnes/tools-core',
      packageId: '@agnes/base',
      entryRevision: 'r1',
      loader: fakeLoader([]),
      owners: new Map(),
    })
    expect(built.row.id).toBe('ext:agnes/tools-core')
    expect(built.row.mountRevision).toBe(EXT_ROW_MOUNT_REVISION)
    expect(built.row.extrasRevision).toBe('none')
    expect(built.row.inject).toEqual([])
    expect(built.row.runtime).toBe('in-process')
    expect(built.claim.row).toBe(built.row)
    expect(built.claim.extras).toBeUndefined()
  })

  it('apply loads through the managed loader and the disposer revokes', async () => {
    const calls: Call[] = []
    const dispose = await pluginOf({
      extensionId: 'agnes/tools-core',
      loader: fakeLoader(calls),
      owners: new Map(),
    })({}, {})
    expect(calls).toEqual(['load:agnes/tools-core'])
    await dispose()
    expect(calls).toEqual(['load:agnes/tools-core', 'revoke:agnes/tools-core:operator'])
  })

  // D100. managed.load RESOLVES with an error (it never rejects) and already audits
  // `extension.failed`. Throwing here would reject the whole candidate tree, and at assembly there
  // is no last-good tree to fall back to: Host would not exist for one extension that failed to load.
  it('a load error does not fail the row: it mounts empty and owns nothing', async () => {
    const calls: Call[] = []
    const owners = new Map<string, symbol>()
    const dispose = await pluginOf({
      extensionId: 'agnes/tools-core',
      loader: fakeLoader(calls, 'second extension claims this id'),
      owners,
    })({}, {})
    expect(owners.size).toBe(0)
    await dispose()
    // A disposer that owns nothing revokes nothing.
    expect(calls).toEqual(['load:agnes/tools-core'])
  })

  it('a row whose load failed is retried by the next apply, and that apply revokes nothing', async () => {
    const calls: Call[] = []
    const owners = new Map<string, symbol>()
    let failing = true
    const loader = Object.freeze({
      load: async (id: string) => {
        calls.push(`load:${id}`)
        return failing
          ? { id, loaded: false, error: { code: 'E_EXT_LOAD', message: 'boom' } }
          : { id, loaded: true }
      },
      revoke: async (id: string, reason: string) => {
        calls.push(`revoke:${id}:${reason}`)
      },
    })
    const plugin = pluginOf({ extensionId: 'agnes/tools-core', loader, owners })
    await plugin({}, {})
    failing = false
    const dispose = await plugin({}, {})
    expect(owners.has('agnes/tools-core')).toBe(true)
    expect(calls).toEqual(['load:agnes/tools-core', 'load:agnes/tools-core'])
    await dispose()
    expect(calls.at(-1)).toBe('revoke:agnes/tools-core:operator')
  })

  it('the second row evicts the incumbent, and the superseded disposer does not revoke', async () => {
    const calls: Call[] = []
    const owners = new Map<string, symbol>()
    const disposeFirst = await pluginOf({
      extensionId: 'agnes/tools-core',
      owners,
      loader: fakeLoader(calls),
    })({}, {})
    const disposeSecond = await pluginOf({
      extensionId: 'agnes/tools-core',
      owners,
      loader: fakeLoader(calls),
    })({}, {})
    // The new row's apply ran BEFORE the old row's disposer: that is the measured order of
    // applyRuntimeTarget, which builds the whole candidate tree and only then retires the old one.
    await disposeFirst()
    expect(calls).toEqual([
      'load:agnes/tools-core',
      'revoke:agnes/tools-core:operator',
      'load:agnes/tools-core',
    ])
    await disposeSecond()
    expect(calls.at(-1)).toBe('revoke:agnes/tools-core:operator')
  })

  it('a disposer whose revoke fails reports it and still rethrows', async () => {
    const seen: unknown[] = []
    const dispose = await pluginOf({
      extensionId: 'agnes/tools-core',
      owners: new Map(),
      onDisposeError: (error) => seen.push(error),
      loader: Object.freeze({
        load: async (id: string) => ({ id, loaded: true }),
        revoke: async () => {
          throw Object.assign(new Error('seam implementation package cannot be changed'), {
            code: 'E_SEAM_IMMUTABLE',
          })
        },
      }),
    })({}, {})
    await expect(dispose()).rejects.toMatchObject({ code: 'E_SEAM_IMMUTABLE' })
    expect(seen).toHaveLength(1)
  })
})

describe('composeExtensionRowTarget', () => {
  const rev = 'a'.repeat(64)
  const row = (id: string, extra: { disabled?: boolean } = {}) =>
    createPluginRow({
      id,
      // The Host's own rows are builtin; anything else under an owned id is a package's replacement.
      plugin: id.startsWith('ext:agnes/') ? `builtin:test/${id.split('/').pop()}` : `test@${rev}/${id}`,
      snapshotDigest: rev,
      exportName: 'x',
      entryRevision: rev,
      extrasRevision: 'none',
      mountRevision: 'test',
      inject: [],
      provides: [],
      runtime: 'in-process',
      disabled: extra.disabled ?? false,
    })
  const live = () =>
    buildRuntimeTarget({
      rows: [row('examples/third-party'), row('ext:agnes/skills'), row('ext:agnes/tools-core')],
      resources: { mcp: [], skills: { probe: 'live-resource' } },
      resourceRevision: 'b'.repeat(64),
      compositeRevision: 'c'.repeat(64),
    })

  it('keeps every published row and the live resources, and replaces only the ext: rows it owns', () => {
    const next = row('ext:agnes/tools-core', { disabled: true })
    const composed = composeExtensionRowTarget({ live: live(), fallbackRows: [], rows: [next] })
    expect(composed.rows.map((r) => r.id).sort()).toEqual(['examples/third-party', 'ext:agnes/tools-core'])
    // The owned row is the NEW one, not the published one.
    expect(composed.rows.find((r) => r.id === 'ext:agnes/tools-core')?.disabled).toBe(true)
    expect(composed.resources).toEqual({ mcp: [], skills: { probe: 'live-resource' } })
  })

  it('drops an owned row when the caller no longer asks for it', () => {
    const composed = composeExtensionRowTarget({ live: live(), fallbackRows: [], rows: [] })
    expect(composed.rows.map((r) => r.id).sort()).toEqual(['examples/third-party'])
  })

  it('keeps a package row published under an owned id and does not bring the builtin one back', () => {
    const replacement = createPluginRow({
      id: 'ext:agnes/tools-core',
      plugin: `acme@${rev}/replacement`,
      snapshotDigest: rev,
      exportName: 'replacement',
      entryRevision: rev,
      extrasRevision: 'none',
      mountRevision: 'test',
    })
    const published = buildRuntimeTarget({
      rows: [replacement, row('ext:agnes/skills')],
      resources: { mcp: [], skills: {} },
      resourceRevision: 'b'.repeat(64),
      compositeRevision: 'c'.repeat(64),
    })
    const composed = composeExtensionRowTarget({
      live: published,
      fallbackRows: [],
      rows: [row('ext:agnes/tools-core'), row('ext:agnes/hooks-runner')],
    })
    expect(composed.rows.find((r) => r.id === 'ext:agnes/tools-core')?.plugin).toBe(`acme@${rev}/replacement`)
    expect(composed.rows.filter((r) => r.id === 'ext:agnes/tools-core')).toHaveLength(1)
    expect(composed.rows.map((r) => r.id)).toContain('ext:agnes/hooks-runner')
  })

  it('falls back to the given rows and empty resources when nothing is published yet', () => {
    const composed = composeExtensionRowTarget({
      live: undefined,
      fallbackRows: [row('examples/boot')],
      rows: [row('ext:agnes/tools-core')],
    })
    expect(composed.rows.map((r) => r.id)).toEqual(['examples/boot', 'ext:agnes/tools-core'])
    expect(composed.resources).toEqual({ mcp: [], skills: {} })
  })
})
