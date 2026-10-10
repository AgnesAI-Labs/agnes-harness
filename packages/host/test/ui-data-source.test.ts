import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import {
  capabilityHash,
  hashDirectory,
  lockPath,
  RuntimeGenerationSnapshotStore,
  readDevelopmentPlugin,
} from '@agnes/package-manager'
import { createPluginRow } from '@agnes/plugin-runtime/host'
import { type JsonValue, jcs, type UiActionParams, type UiSurface } from '@agnes/protocol'
import { X_AGNES_UI_LIMITS } from '@agnes/protocol/gen/intelligent-ui'
import { describe, expect, it } from 'vitest'
import {
  loadUiDataSourceGrant,
  lookupUiDataSource,
  resolveUiDataSources,
  type UiDataSourceCacheEntry,
  type UiDataSourceCatalogView,
  type UiDataSourceGrant,
  type UiDataSourceRegistration,
  type UiDataSourceResolverDeps,
  type UiSourceResolveInput,
  uiDataSourceDecision,
} from '../src/runtime/sessions/ui-data-source.js'

const rows = [{ id: 'a', amount: 12 }]
const binding = { $source: 'finance/differences', params: {} }
const schema = { type: 'object', additionalProperties: false, properties: {} }
const registration: UiDataSourceRegistration = {
  id: 'finance/differences',
  sourcePackage: '@agnes-fde/finance-reconcile',
  permission: 'finance.differences.read',
  result: 'rows',
  paramsSchema: schema,
}
const signal = new AbortController().signal

function sha(value: unknown): string {
  return createHash('sha256').update(jcs(value)).digest('hex')
}
function allow(patch: Partial<UiDataSourceGrant> = {}): UiDataSourceGrant {
  return {
    enabled: true,
    trusted: true,
    hashMatches: true,
    inGeneration: true,
    atoms: ['uiData:finance.differences.read'],
    ...patch,
  }
}
function tableSurface(id = 'reconcile', data: UiSurface['data'] = { rows: binding }): UiSurface {
  return {
    id,
    revision: 1,
    title: 'Differences',
    placement: { inline: true, workbench: true },
    data,
    components: [
      {
        id: 'differences',
        kind: 'table',
        dataKey: 'rows',
        rowKey: 'id',
        columns: [
          { key: 'id', label: 'Id' },
          { key: 'amount', label: 'Amount' },
        ],
        selection: 'multiple',
        rowActionIds: ['confirm'],
      },
    ],
    actions: [
      {
        id: 'confirm',
        label: 'Confirm',
        tool: 'adjust',
        argsTemplate: { rows: { from: 'selection', key: 'differences' } },
        paramsSchema: schema,
      },
    ],
  }
}
function withChart(value: UiSurface, sourceId: string): UiSurface {
  return {
    ...value,
    data: { ...value.data, chart: { $source: sourceId, params: {} } },
    components: [
      ...value.components,
      {
        id: 'amounts',
        kind: 'chart',
        chartType: 'bar',
        dataKey: 'chart',
        categoryKey: 'label',
        series: [{ key: 'amount', label: 'Amount' }],
      },
    ],
  }
}
function action(sources?: Record<string, string>): UiActionParams {
  return {
    sessionId: 'session',
    surfaceId: 'reconcile',
    revision: 1,
    actionId: 'confirm',
    commandId: 'one',
    input: {},
    selection: { differences: ['a'] },
    confirmed: true,
    ...(sources ? { sources } : {}),
  }
}
function harness(
  options: {
    find?: UiDataSourceResolverDeps['find']
    grant?: UiDataSourceResolverDeps['grant']
    query?: (params: JsonValue, signal: AbortSignal) => Promise<unknown>
    dispose?: () => Promise<void>
    declarations?: UiDataSourceResolverDeps['declarations']
    timeoutMs?: number
    resultBytes?: number
    actorId?: string
    sessionKey?: string
    generationId?: string
  } = {},
) {
  const cache = new Map<string, UiDataSourceCacheEntry>()
  const opened: string[] = []
  let opens = 0
  const deps: UiDataSourceResolverDeps = {
    actor: {
      id: options.actorId ?? 'operator',
      org: 'synthetic',
      role: 'owner',
      deptPath: [],
      attrs: {},
    },
    generationId: options.generationId ?? 'gen-1',
    session: {
      key: options.sessionKey ?? 'session',
      lane: 'main',
      workspaceRoot: '/synthetic',
    },
    cache,
    validators: new Map(),
    find:
      options.find ??
      ((id) => (id === registration.id ? { status: 'ready', registration } : { status: 'unknown' })),
    grant: options.grant ?? (() => allow()),
    declarations: options.declarations ?? (() => []),
    now: () => 1_000,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.resultBytes === undefined ? {} : { resultBytes: options.resultBytes }),
    open: async (source) => {
      opened.push(source.id)
      opens += 1
      return {
        query: async (params, querySignal) => {
          const data = await (options.query ?? (async () => rows))(params, querySignal)
          return data as JsonValue
        },
        dispose: async () => {
          await options.dispose?.()
        },
      }
    },
  }
  return { deps, cache, opened: () => opened, opens: () => opens }
}
function run(
  h: ReturnType<typeof harness>,
  purpose: UiSourceResolveInput['purpose'],
  value: UiSurface = tableSurface(),
  extra: { openSurfaceIds?: readonly string[]; signal?: AbortSignal; action?: UiActionParams } = {},
) {
  return resolveUiDataSources(
    {
      purpose,
      surface: value,
      openSurfaceIds: extra.openSurfaceIds ?? [value.id],
      signal: extra.signal ?? signal,
      ...(extra.action ? { action: extra.action } : {}),
    },
    h.deps,
  )
}
function seed(cache: Map<string, UiDataSourceCacheEntry>, sessionKey = 'session'): void {
  cache.set('stale', {
    sessionKey,
    actorId: 'operator',
    generationId: 'gen-1',
    surfaceId: 'reconcile',
    revision: 1,
    sourceId: registration.id,
    paramsHash: 'p',
    resultHash: 'r',
    data: [{ id: 'stale-row', amount: 1 }],
    bytes: 1,
    rows: 1,
    at: 1,
  })
}

describe('ui data source resolution', () => {
  it('returns rows on a cache miss and does not audit the next read', async () => {
    const h = harness()
    const first = await run(h, 'read')
    if (!first.ok) throw new Error('expected rows')
    expect(first.surface.data.rows).toEqual(rows)
    expect(first.sources.rows).toEqual({ status: 'ready', resultHash: sha(rows) })
    expect(first.audits).toEqual([
      {
        name: 'source.resolved',
        data: {
          sourceId: registration.id,
          paramsHash: sha({}),
          resultHash: sha(rows),
          bytes: Buffer.byteLength(jcs(rows)),
          rows: 1,
          durationMs: 0,
          generationId: 'gen-1',
          actorId: 'operator',
        },
      },
    ])
    expect(JSON.stringify(first.audits)).not.toContain('amount')
    const second = await run(h, 'read')
    if (!second.ok) throw new Error('expected cached rows')
    expect(second.surface.data.rows).toEqual(rows)
    expect(second.audits).toEqual([])
    expect(h.opens()).toBe(1)
  })

  it('accepts an empty row set', async () => {
    const h = harness({ query: async () => [] })
    const result = await run(h, 'read')
    if (!result.ok) throw new Error('expected an empty set')
    expect(result.surface.data.rows).toEqual([])
    expect(result.sources.rows).toEqual({ status: 'ready', resultHash: sha([]) })
    expect(result.audits[0]?.data.rows).toBe(0)
  })

  it.each([
    ['disabled', { enabled: false }],
    ['untrusted', { trusted: false }],
    ['hash mismatch', { hashMatches: false }],
    ['outside this generation', { inGeneration: false }],
    ['missing its uiData atom', { atoms: [] as string[] }],
  ])('refuses a source that is %s and drops cached rows', async (_name, patch) => {
    const h = harness({ grant: () => allow(patch) })
    seed(h.cache)
    const result = await run(h, 'write')
    expect(result).toMatchObject({ ok: false, code: 'UI_SOURCE_DENIED', dataKey: 'rows' })
    expect(h.opens()).toBe(0)
    expect(h.cache.size).toBe(0)
    expect(JSON.stringify(result.audits)).not.toContain('stale-row')
  })

  it('reports an unknown id without treating it as a grant failure', async () => {
    const h = harness()
    const result = await run(
      h,
      'read',
      tableSurface('reconcile', { rows: { $source: 'missing/source', params: {} } }),
    )
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.sources.rows).toEqual({ status: 'error', code: 'UI_SOURCE_UNKNOWN' })
    expect(result.audits[0]?.name).toBe('source.refused')
    expect(h.opens()).toBe(0)
    expect(uiDataSourceDecision(undefined, allow())).toBe('UI_SOURCE_UNKNOWN')
  })

  it('rejects a widened param and a schema that cannot compile', async () => {
    const widened = await run(
      harness(),
      'write',
      tableSurface('reconcile', { rows: { $source: registration.id, params: { extra: 1 } } }),
    )
    expect(widened).toMatchObject({ ok: false, code: 'UI_SOURCE_INVALID', dataKey: 'rows' })
    expect(JSON.stringify(widened.audits)).not.toContain('extra')
    const compiled = await run(
      harness({
        find: () => ({
          status: 'ready',
          registration: { ...registration, paramsSchema: { $ref: '#/$defs/missing' } },
        }),
      }),
      'write',
    )
    expect(compiled).toMatchObject({ ok: false, code: 'UI_SOURCE_INVALID' })
    expect(compiled.audits[0]?.name).toBe('source.refused')
  })

  it('rejects an invalid binding before opening a source', async () => {
    const h = harness()
    const result = await run(
      h,
      'write',
      tableSurface('reconcile', { rows: { $source: 'Nope', extra: true } }),
    )
    expect(result).toMatchObject({ ok: false, code: 'UI_SOURCE_INVALID', dataKey: 'rows' })
    expect(result.audits[0]?.data.sourceId).toBe('invalid')
    expect(result.audits[0]?.data.paramsHash).toBe(sha(null))
    expect(h.opens()).toBe(0)
  })

  it('rejects a result whose kind or component shape does not match', async () => {
    const kind = await run(harness({ query: async () => ({ id: 'a' }) }), 'write')
    expect(kind).toMatchObject({ ok: false, code: 'UI_SOURCE_SHAPE' })
    const shape = await run(harness({ query: async () => [{ id: 'a' }] }), 'read')
    if (!shape.ok) throw new Error('expected a degraded component')
    expect(shape.sources.rows).toEqual({ status: 'error', code: 'UI_SOURCE_SHAPE' })
    expect(shape.surface.data.rows).toEqual(binding)
  })

  it('rejects an oversized result without keeping a truncated copy', async () => {
    const h = harness({ resultBytes: 4 })
    const result = await run(h, 'read')
    if (!result.ok) throw new Error('expected a degraded component')
    expect(result.sources.rows).toEqual({ status: 'error', code: 'UI_SOURCE_TOO_LARGE' })
    expect(result.surface.data.rows).toEqual(binding)
    expect(h.cache.size).toBe(0)
  })

  it('times out a source and still disposes it', async () => {
    const h = harness({
      timeoutMs: 20,
      query: (_params, querySignal) =>
        new Promise((_resolve, reject) => {
          querySignal.addEventListener('abort', () => reject(querySignal.reason), { once: true })
        }),
      dispose: async () => {
        throw new Error('DISPOSE_SECRET')
      },
    })
    const result = await run(h, 'read')
    if (!result.ok) throw new Error('expected a degraded component')
    expect(result.sources.rows).toEqual({ status: 'error', code: 'UI_SOURCE_TIMEOUT' })
    expect(JSON.stringify(result)).not.toContain('DISPOSE_SECRET')
    expect(h.opens()).toBe(1)
  })

  it('hides source and declaration failures behind an unavailable code', async () => {
    const query = await run(
      harness({
        query: async () => {
          throw new Error('SECRET_INTERNAL_DSN')
        },
      }),
      'read',
    )
    if (!query.ok) throw new Error('expected a degraded component')
    expect(query.sources.rows).toEqual({ status: 'error', code: 'UI_SOURCE_UNAVAILABLE' })
    expect(JSON.stringify(query)).not.toContain('SECRET_INTERNAL_DSN')
    const declarations = await run(
      harness({
        declarations: () => {
          throw new Error('DECL_SECRET')
        },
      }),
      'read',
    )
    if (!declarations.ok) throw new Error('expected a degraded component')
    expect(declarations.sources.rows).toEqual({ status: 'error', code: 'UI_SOURCE_UNAVAILABLE' })
    expect(JSON.stringify(declarations)).not.toContain('DECL_SECRET')
  })

  it('rethrows the caller abort and does not turn it into a source failure', async () => {
    const early = new AbortController()
    early.abort(new Error('stop-now'))
    const idle = harness()
    await expect(run(idle, 'read', tableSurface(), { signal: early.signal })).rejects.toThrow('stop-now')
    expect(idle.opens()).toBe(0)
    const mid = new AbortController()
    const busy = harness({
      query: async () => {
        mid.abort(new Error('stop-mid'))
        throw new Error('SECRET_SHOULD_NOT_LEAK')
      },
    })
    await expect(run(busy, 'read', tableSurface(), { signal: mid.signal })).rejects.toThrow('stop-mid')
    expect(busy.opens()).toBe(1)
  })

  it('drops cached rows when a refresh fails', async () => {
    let fail = false
    const h = harness({
      query: async () => {
        if (fail) throw new Error('refresh down')
        return rows
      },
    })
    const first = await run(h, 'read')
    if (!first.ok) throw new Error('expected rows')
    expect(first.surface.data.rows).toEqual(rows)
    expect(h.cache.size).toBe(1)
    fail = true
    const refresh = await run(h, 'refresh')
    if (!refresh.ok) throw new Error('expected a degraded refresh')
    expect(refresh.sources.rows).toEqual({ status: 'error', code: 'UI_SOURCE_UNAVAILABLE' })
    expect(refresh.surface.data.rows).toEqual(binding)
    expect(refresh.audits[0]?.name).toBe('source.refused')
    expect(h.cache.size).toBe(0)
    const again = await run(h, 'read')
    if (!again.ok) throw new Error('expected a degraded read')
    expect(again.sources.rows).toEqual({ status: 'error', code: 'UI_SOURCE_UNAVAILABLE' })
    expect(again.surface.data.rows).toEqual(binding)
    expect(again.audits.map((item) => item.name)).toEqual(['source.refused'])
    expect(JSON.stringify(again)).not.toContain('id":"a"')
    expect(h.cache.size).toBe(0)
    fail = false
    const recovered = await run(h, 'read')
    if (!recovered.ok) throw new Error('expected a fresh query')
    expect(recovered.surface.data.rows).toEqual(rows)
    expect(recovered.audits.map((item) => item.name)).toEqual(['source.resolved'])
    expect(h.cache.size).toBe(1)
  })

  it('refreshes past the cache and names that audit', async () => {
    const h = harness()
    await run(h, 'read')
    const refreshed = await run(h, 'refresh')
    if (!refreshed.ok) throw new Error('expected refreshed rows')
    expect(refreshed.audits.map((item) => item.name)).toEqual(['source.refreshed'])
    expect(refreshed.surface.data.rows).toEqual(rows)
    expect(h.opens()).toBe(2)
  })

  it('does not share cached rows across sessions or actors', async () => {
    const h = harness()
    await run(h, 'read')
    await resolveUiDataSources(
      { purpose: 'read', surface: tableSurface(), openSurfaceIds: ['reconcile'], signal },
      { ...h.deps, session: { ...h.deps.session, key: 'other-session' } },
    )
    await resolveUiDataSources(
      { purpose: 'read', surface: tableSurface(), openSurfaceIds: ['reconcile'], signal },
      { ...h.deps, actor: { ...h.deps.actor, id: 'reader' } },
    )
    expect(h.opens()).toBe(3)
  })

  it('drops cached rows when trust is revoked on the next read', async () => {
    let enabled = true
    const h = harness({ grant: () => allow({ enabled }) })
    await run(h, 'read')
    enabled = false
    const result = await run(h, 'read')
    if (!result.ok) throw new Error('expected a degraded component')
    expect(result.sources.rows).toEqual({ status: 'error', code: 'UI_SOURCE_DENIED' })
    expect(result.surface.data.rows).toEqual(binding)
    expect(result.audits[0]?.name).toBe('source.refused')
    expect(h.opens()).toBe(1)
    expect(h.cache.size).toBe(0)
  })

  it('checks an action hash only for dependent keys', async () => {
    const stale = await run(harness(), 'action', tableSurface(), { action: action() })
    expect(stale).toMatchObject({ ok: false, code: 'UI_STALE', dataKey: 'rows' })
    expect(stale.audits[0]?.name).toBe('source.resolved')
    const fresh = await run(harness(), 'action', tableSurface(), { action: action({ rows: sha(rows) }) })
    expect(fresh.ok).toBe(true)
    const denied = harness({
      find: (id) => {
        if (id === registration.id) return { status: 'ready', registration }
        if (id === 'ledger/other') return { status: 'denied' }
        return { status: 'unknown' }
      },
    })
    const skipped = await run(denied, 'action', withChart(tableSurface(), 'ledger/other'), {
      action: action({ rows: sha(rows) }),
    })
    expect(skipped.ok).toBe(true)
    expect(denied.opened()).toEqual([registration.id])
  })

  it('stops a write at the first failed binding', async () => {
    const h = harness()
    const result = await run(
      h,
      'write',
      tableSurface('reconcile', {
        rows: { $source: 'missing/source', params: {} },
        chart: binding,
      }),
    )
    expect(result).toMatchObject({ ok: false, code: 'UI_SOURCE_UNKNOWN', dataKey: 'rows' })
    expect(result.audits).toHaveLength(1)
    expect(h.opens()).toBe(0)
  })

  it('forgets a closed surface and a surface from an older generation', async () => {
    const h = harness()
    await run(h, 'read', tableSurface('open-a'), { openSurfaceIds: ['open-a'] })
    await run(h, 'read', tableSurface('open-b'), { openSurfaceIds: ['open-b'] })
    expect([...h.cache.values()].map((entry) => entry.surfaceId)).toEqual(['open-b'])
    await resolveUiDataSources(
      { purpose: 'read', surface: tableSurface('open-b'), openSurfaceIds: ['open-b'], signal },
      { ...h.deps, generationId: 'gen-2' },
    )
    expect([...h.cache.values()].map((entry) => entry.generationId)).toEqual(['gen-2'])
  })

  it('keeps another session and evicts the oldest surface past the live limit', async () => {
    const h = harness()
    seed(h.cache, 'other-session')
    const ids: string[] = []
    for (let index = 0; index < X_AGNES_UI_LIMITS.liveSurfaces + 1; index += 1) {
      const id = `surface-${index}`
      ids.push(id)
      await run(h, 'read', tableSurface(id), { openSurfaceIds: ids })
    }
    const own = [...h.cache.values()].filter((entry) => entry.sessionKey === 'session')
    expect(own.map((entry) => entry.surfaceId)).not.toContain('surface-0')
    expect(own.map((entry) => entry.surfaceId)).toContain(`surface-${X_AGNES_UI_LIMITS.liveSurfaces}`)
    expect(own).toHaveLength(X_AGNES_UI_LIMITS.liveSurfaces)
    expect([...h.cache.values()].some((entry) => entry.sessionKey === 'other-session')).toBe(true)
  })

  it('does not cache rows when the grant is revoked during the query', async () => {
    let calls = 0
    const h = harness({
      grant: () => allow(calls++ > 0 ? { enabled: false } : {}),
    })
    const result = await run(h, 'read')
    expect(h.opens()).toBe(1)
    expect(h.cache.size).toBe(0)
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.sources.rows).toEqual({ status: 'error', code: 'UI_SOURCE_DENIED' })
    expect(result.surface.data.rows).toEqual(binding)
    expect(JSON.stringify(result.audits)).not.toContain('id":"a"')
  })

  it('returns a denied grant when the pinned generation is missing', () => {
    const profile = mkdtempSync(join(tmpdir(), 'agh-ui-source-'))
    try {
      expect(
        loadUiDataSourceGrant({
          profileDir: profile,
          profile: 'test',
          agnesVersion: '0.0.0',
          generationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          packageId: '@agnes-fde/finance-reconcile',
        }),
      ).toEqual({
        enabled: false,
        trusted: false,
        hashMatches: false,
        inGeneration: false,
        atoms: [],
      })
      expect(existsSync(join(profile, '.runtime-generations'))).toBe(false)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  })

  it('accepts a trusted generation when the author host has no lock, and keeps a lock authoritative', () => {
    const root = mkdtempSync(join(tmpdir(), 'agh-ui-source-grant-'))
    const profile = join(root, 'profile')
    const packageDir = join(root, 'pkg')
    mkdirSync(profile, { recursive: true })
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@agnes-fde/finance-reconcile',
        version: '1.1.0',
        agnes: { capabilities: { uiData: ['finance.differences.read'] } },
      }),
    )
    const packageId = '@agnes-fde/finance-reconcile'
    const declaredCapabilities = { uiData: ['finance.differences.read'] }
    const dependencies = {}
    const contributions: [] = []
    const integrity = hashDirectory(packageDir, { exclude: [] })
    const source = {
      snapshot: {
        packageId,
        profile: 'local-dev',
        version: '1.1.0',
        directory: packageDir,
        snapshotId: integrity,
        integrity,
        treeIntegrity: integrity,
        capabilityHash: capabilityHash({ contributions, dependencies, declaredCapabilities }),
        contributions,
        dependencies,
        declaredCapabilities,
      },
      generation: 1,
      trusted: true,
    }
    const row = (disabled: boolean) =>
      createPluginRow({
        id: 'ext:finance/main',
        plugin: `${packageId}@${integrity}/main`,
        snapshotDigest: integrity,
        exportName: 'main',
        entryRevision: '1',
        extrasRevision: 'none',
        mountRevision: '1',
        disabled,
      })
    const pin = (disabled: boolean) =>
      new RuntimeGenerationSnapshotStore(profile).create(
        buildCompleteRuntimeTarget({ rows: [row(disabled)], resources: { mcp: [], skills: {} } }).target,
        [source],
        'test',
      )
    const ask = (generationId: string) =>
      loadUiDataSourceGrant({
        profileDir: profile,
        profile: 'local-dev',
        agnesVersion: '0.0.0',
        generationId,
        packageId,
      })
    try {
      const open = pin(false)
      expect(ask(open.id)).toEqual({
        enabled: true,
        trusted: true,
        hashMatches: true,
        inGeneration: true,
        atoms: ['uiData:finance.differences.read'],
      })
      expect(existsSync(lockPath(profile))).toBe(false)
      const disabled = pin(true)
      expect(ask(disabled.id)).toMatchObject({
        enabled: false,
        trusted: true,
        hashMatches: true,
        inGeneration: false,
        atoms: ['uiData:finance.differences.read'],
      })
      const copy = join(profile, '.runtime-generations', open.id, '0')
      const manifest = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8')) as {
        agnes: { capabilities: { uiData: string[] } }
      }
      manifest.agnes.capabilities.uiData.push('finance.other.read')
      writeFileSync(join(copy, 'package.json'), JSON.stringify(manifest))
      const recordPath = join(profile, '.runtime-generations', open.id, 'generation.json')
      const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
        sources: { snapshot: { treeIntegrity: string; declaredCapabilities: { uiData: string[] } } }[]
      }
      const snap = record.sources[0]?.snapshot
      if (!snap) throw new Error('missing generation source')
      snap.treeIntegrity = hashDirectory(copy, { exclude: [] })
      writeFileSync(recordPath, JSON.stringify(record))
      expect(ask(open.id).atoms).toEqual(['uiData:finance.differences.read'])
      snap.declaredCapabilities.uiData.push('finance.other.read')
      writeFileSync(recordPath, JSON.stringify(record))
      expect(ask(open.id)).toMatchObject({ hashMatches: false, atoms: [] })
      writeFileSync(lockPath(profile), 'not-a-lock')
      expect(ask(open.id)).toEqual({
        enabled: false,
        trusted: false,
        hashMatches: false,
        inGeneration: false,
        atoms: [],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('denies a uiData atom added to a development package after the snapshot was sealed', () => {
    const root = mkdtempSync(join(tmpdir(), 'agh-ui-source-dev-'))
    const profile = join(root, 'profile')
    mkdirSync(profile, { recursive: true })
    const packageDir = fileURLToPath(new URL('../../../examples/fde/finance-reconcile/', import.meta.url))
    const source = readDevelopmentPlugin(packageDir, 'local-dev')
    const packageId = source.snapshot.packageId
    const row = createPluginRow({
      id: 'ext:finance/main',
      plugin: `${packageId}@${source.snapshot.integrity}/main`,
      snapshotDigest: source.snapshot.integrity,
      exportName: 'main',
      entryRevision: '1',
      extrasRevision: 'none',
      mountRevision: '1',
      disabled: false,
    })
    const generation = new RuntimeGenerationSnapshotStore(profile).create(
      buildCompleteRuntimeTarget({ rows: [row], resources: { mcp: [], skills: {} } }).target,
      [source],
      'test',
    )
    const ask = () =>
      loadUiDataSourceGrant({
        profileDir: profile,
        profile: 'local-dev',
        agnesVersion: '0.0.0',
        generationId: generation.id,
        packageId,
      })
    try {
      expect(ask().atoms).toContain('uiData:finance.differences.read')
      expect(ask().atoms).not.toContain('uiData:finance.other.read')
      const copy = join(profile, '.runtime-generations', generation.id, '0')
      const manifestPath = join(copy, 'package.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        agnes: { capabilities: { uiData: string[] } }
      }
      manifest.agnes.capabilities.uiData.push('finance.other.read')
      writeFileSync(manifestPath, JSON.stringify(manifest))
      const recordPath = join(profile, '.runtime-generations', generation.id, 'generation.json')
      const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
        sources: { snapshot: { treeIntegrity: string } }[]
      }
      const snap = record.sources[0]?.snapshot
      if (!snap) throw new Error('missing generation source')
      snap.treeIntegrity = hashDirectory(copy, { exclude: [] })
      writeFileSync(recordPath, JSON.stringify(record))
      const granted = ask()
      expect(granted.hashMatches).toBe(true)
      expect(granted.atoms).toContain('uiData:finance.differences.read')
      expect(granted.atoms).not.toContain('uiData:finance.other.read')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('turns catalog cardinality into unknown or denied', () => {
    const entry = {
      kind: 'ui-data-source',
      id: registration.id,
      version: '1',
      sourcePackage: registration.sourcePackage,
    }
    const provider = {
      id: registration.id,
      version: '1',
      permission: registration.permission,
      result: 'rows',
      paramsSchema: schema,
    }
    const catalog = (
      entries: readonly (typeof entry)[],
      resolve: UiDataSourceCatalogView['resolve'] = () => provider,
    ): UiDataSourceCatalogView => ({
      catalog: () => entries,
      resolve,
    })
    expect(lookupUiDataSource(catalog([entry]), registration.id)).toMatchObject({
      status: 'ready',
      registration: { sourcePackage: registration.sourcePackage, permission: registration.permission },
    })
    expect(lookupUiDataSource(catalog([]), registration.id).status).toBe('unknown')
    expect(lookupUiDataSource(catalog([{ ...entry, kind: 'other' }]), registration.id).status).toBe('unknown')
    expect(lookupUiDataSource(catalog([entry, { ...entry, version: '2' }]), registration.id).status).toBe(
      'denied',
    )
    expect(
      lookupUiDataSource(
        {
          catalog: () => {
            throw new Error('catalog down')
          },
          resolve: () => provider,
        },
        registration.id,
      ).status,
    ).toBe('unknown')
    expect(
      lookupUiDataSource(
        catalog([entry], () => {
          throw new Error('resolve down')
        }),
        registration.id,
      ).status,
    ).toBe('denied')
    expect(
      lookupUiDataSource(
        catalog([entry], () => ({ ...provider, permission: 1 })),
        registration.id,
      ).status,
    ).toBe('denied')
    expect(
      lookupUiDataSource(
        catalog([entry], () => ({ ...provider, result: 'nope' })),
        registration.id,
      ).status,
    ).toBe('denied')
  })
})
