import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { approvalKind } from '@agnes/extension-api/seams'
import { HostError } from '@agnes/host-common/errors'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import { RuntimeGenerationSnapshotStore } from '@agnes/package-manager'
import {
  decodeRuntimeTargetArtifact,
  encodeRuntimeTargetArtifact,
  normalizePluginExport,
} from '@agnes/plugin-runtime/host'
import { afterEach, expect, it } from 'vitest'
import { createTestHost, type TestHostOptions } from '../../testkit/index.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-seam-pin-'))
  roots.push(root)
  return root
}

/** A second approval implementation, registered by another package through the ordinary path. */
const alternate = {
  id: 'alt',
  version: '1.0.0',
  create: async () => ({ ask: async () => 'rejected' as const }),
}
const altPackage = {
  plugins: [
    {
      declaration: {
        export: 'altApprovalPlugin',
        apiRange: '^2.0.0',
        id: 'seam-providers:alt',
        inject: ['providers'],
        runtime: 'in-process' as const,
        default: true,
      },
      entry: normalizePluginExport({
        inject: ['providers'],
        apply: (ctx: { providers: { register(kind: unknown, provider: unknown): unknown } }) => {
          ctx.providers.register(approvalKind, alternate)
        },
      } as never),
    },
  ],
}

const snapshotsOf = (root: string) => new RuntimeGenerationSnapshotStore(join(root, 'profiles/local-dev'))
const ledgerFiles = (root: string) =>
  readdirSync(root, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('sessions.db'))
    .map((name) => join(root, name))

it('records the pinned seam implementations when a session is bound and the selections in its generation', async () => {
  const root = scratch()
  const { host } = await createTestHost({ dataDir: root, disableSessionTitle: true })
  try {
    const session = await host.createSession({ key: 'pinned', cwd: root })
    const store = snapshotsOf(root)
    const pin = store.session('pinned')
    expect(pin?.formatVersion).toBe(1)
    expect(pin?.seams?.map((seam) => seam.kind)).toEqual([
      'approval',
      'principals',
      'billing',
      'checkpoint',
      'artifacts',
    ])
    expect(pin?.seams?.[0]).toMatchObject({
      kind: 'approval',
      provider: 'local-prompt',
      version: '1.0.0',
      sourcePackage: '@agnes/base',
      integrity: expect.any(String),
    })
    const generation = store.read(pin?.generationId as string)
    expect(generation.seams).toMatchObject({
      formatVersion: 1,
      selections: { approval: { provider: 'local-prompt' }, repair: { provider: 'default' } },
    })
    await session.close()
  } finally {
    await host.close()
  }
})

it('resumes an old session on the implementation it was bound to after the configured selection changed', async () => {
  const root = scratch()
  const first = await createTestHost({ dataDir: root, disableSessionTitle: true })
  try {
    await (await first.host.createSession({ key: 'old', cwd: root })).close()
  } finally {
    await first.host.close()
  }
  const second = await createTestHost({
    dataDir: root,
    disableSessionTitle: true,
    packages: { '@agnes/code': altPackage as never },
    profileInputs: { user: { name: 'local-dev', providers: { approval: { provider: 'alt' } } } },
  })
  try {
    // The old session is rebuilt from its generation's recorded selection, not from today's profile.
    const resumed = await second.host.createSession({ key: 'old', cwd: root })
    expect(snapshotsOf(root).session('old')?.seams?.[0]).toMatchObject({ provider: 'local-prompt' })
    await resumed.close()
    // A new session binds the newly selected implementation.
    const fresh = await second.host.createSession({ key: 'fresh', cwd: root })
    expect(snapshotsOf(root).session('fresh')?.seams?.[0]).toMatchObject({
      provider: 'alt',
      sourcePackage: '@agnes/code',
    })
    await fresh.close()
  } finally {
    await second.host.close()
  }
})

it('refuses a session whose pinned implementation no longer matches, in the person’s language and without changing anything', async () => {
  const root = scratch()
  const first = await createTestHost({ dataDir: root, disableSessionTitle: true })
  try {
    await (await first.host.createSession({ key: 'tampered', cwd: root })).close()
  } finally {
    await first.host.close()
  }
  const store = snapshotsOf(root)
  const pinFile = readdirSync(join(root, 'profiles/local-dev/.runtime-generations/sessions'))
    .map((name) => join(root, 'profiles/local-dev/.runtime-generations/sessions', name))
    .at(0) as string
  const record = JSON.parse(readFileSync(pinFile, 'utf8')) as { seams: { provider: string }[] }
  record.seams[0] = { ...record.seams[0]!, provider: 'something-else' }
  writeFileSync(pinFile, JSON.stringify(record))
  const before = {
    pin: readFileSync(pinFile, 'utf8'),
    ledgers: ledgerFiles(root).map((file) => statSignature(file)),
  }

  const second = await createTestHost({ dataDir: root, disableSessionTitle: true })
  try {
    const failure = await second.host.createSession({ key: 'tampered', cwd: root }).then(
      () => undefined,
      (error: unknown) => error as { code: string; message: string; detail: Record<string, unknown> },
    )
    expect(failure?.code).toBe('E_SESSION_VERSION_OLDER')
    expect(failure?.message).toContain('E_SEAM_PIN_MISMATCH')
    expect(failure?.detail).toMatchObject({
      sessionKey: 'tampered',
      issue: 'older',
      actions: ['new-session', 'repin'],
      localized: { 'zh-CN': expect.stringContaining('你') },
    })
    expect(readFileSync(pinFile, 'utf8')).toBe(before.pin)
    expect(ledgerFiles(root).map((file) => statSignature(file))).toEqual(before.ledgers)
    expect(existsSync(pinFile)).toBe(true)
    expect(store.session('tampered')?.seams?.[0]?.provider).toBe('something-else')
  } finally {
    await second.host.close()
  }
})

const statSignature = (file: string): string => `${file}:${statSync(file).size}`

it('migrates a session to the current generation only when the request names the pinned kinds it replaces', async () => {
  const root = scratch()
  const first = await createTestHost({ dataDir: root, disableSessionTitle: true })
  try {
    await (await first.host.createSession({ key: 'moved', cwd: root })).close()
  } finally {
    await first.host.close()
  }
  const second = await createTestHost({
    dataDir: root,
    disableSessionTitle: true,
    packages: { '@agnes/code': altPackage as never },
    profileInputs: { user: { name: 'local-dev', providers: { approval: { provider: 'alt' } } } },
  })
  try {
    const migrate = second.host.migrateSessionGeneration
    if (!migrate) throw new Error('generation host expected')
    const store = snapshotsOf(root)
    const pinBefore = JSON.stringify(store.session('moved'))
    await expect(migrate('moved')).rejects.toMatchObject({
      code: 'E_SESSION_VERSION_OLDER',
      detail: { cause: 'E_SEAM_PIN_CHANGE', kinds: ['approval'] },
    })
    // A refusal leaves the pin exactly as it was.
    expect(JSON.stringify(store.session('moved'))).toBe(pinBefore)
    expect(second.audit.events.some((event) => event.kind === 'session.seams.repinned')).toBe(false)

    const result = await migrate('moved', { repin: ['approval'], operator: 'admin-1' })
    expect(result).toMatchObject({ changed: true, repinned: ['approval'] })
    expect(store.session('moved')?.seams?.find((seam) => seam.kind === 'approval')).toMatchObject({
      provider: 'alt',
      sourcePackage: '@agnes/code',
    })
    expect(
      second.audit.events.find((event) => event.kind === 'session.seams.repinned')?.detail,
    ).toMatchObject({
      sessionKey: 'moved',
      operator: 'admin-1',
      kinds: ['approval'],
    })
  } finally {
    await second.host.close()
  }
})

const generationDir = (root: string, id: string) => join(root, 'profiles/local-dev/.runtime-generations', id)
const pinPathOf = (root: string) => {
  const directory = join(root, 'profiles/local-dev/.runtime-generations/sessions')
  return join(directory, readdirSync(directory)[0] as string)
}

/**
 * The real worker passes runtime plugin sources, which selects the composition host; a session on a
 * non-default preset is reopened in its own container, so its pin is read before any Host exists.
 */
const hostOptions = (composition: boolean) => ({
  disableSessionTitle: true,
  ...(composition
    ? {
        runtimePluginSources: async () => [],
        packageDirs: { '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)) },
        presets: {
          reader: { name: 'reader', extends: 'standard', composition: { tools: ['read'] } },
          writer: { name: 'writer', extends: 'standard', composition: { tools: ['write'] } },
        },
        profileInputs: {
          user: {
            name: 'local-dev',
            composition: {},
            presets: { default: 'reader', allowed: ['reader', 'writer'] },
          },
        },
      }
    : {}),
})
const presetOf = (composition: boolean) => (composition ? { preset: 'writer' } : {})

/** One closed, pinned session whose stored records the case then damages in a named way. */
async function pinnedSessionRoot(composition = false) {
  const root = scratch()
  const first = await createTestHost({ dataDir: root, ...hostOptions(composition) })
  try {
    await (await first.host.createSession({ key: 'victim', cwd: root, ...presetOf(composition) })).close()
  } finally {
    await first.host.close()
  }
  const pinFile = pinPathOf(root)
  const generationId = (JSON.parse(readFileSync(pinFile, 'utf8')) as { generationId: string }).generationId
  return { root, pinFile, generationFile: join(generationDir(root, generationId), 'generation.json') }
}

const damageCases = [
  [
    'a snapshot written before seams were recorded',
    'E_SESSION_VERSION_OLDER',
    'E_GENERATION_SEAMS_MISSING',
    (generation: Record<string, unknown>) => {
      delete generation.seams
      generation.version = 1
    },
  ],
  [
    'a snapshot written by a newer AGH',
    'E_SESSION_VERSION_NEWER',
    'E_GENERATION_SNAPSHOT_NEWER',
    (generation: Record<string, unknown>) => {
      generation.version = 9
    },
  ],
  [
    'a snapshot that fails its integrity check',
    'E_SESSION_CORRUPT',
    'E_GENERATION_INTEGRITY',
    (generation: Record<string, unknown>) => {
      generation.compatibility = 42
    },
  ],
  [
    'a snapshot whose JSON is damaged',
    'E_SESSION_CORRUPT',
    'E_GENERATION_INTEGRITY',
    (_generation: Record<string, unknown>, files: { generationFile: string }) => {
      writeFileSync(files.generationFile, '{"version":')
    },
  ],
  [
    'a session pin whose JSON is damaged',
    'E_SESSION_CORRUPT',
    'E_GENERATION_INTEGRITY',
    (_generation: Record<string, unknown>, files: { pinFile: string }) => {
      writeFileSync(files.pinFile, '{"sessionKey":')
    },
  ],
] as const

it.each(
  damageCases.flatMap(([name, ...rest]) => [
    [`${name} (single container)`, ...rest, false] as const,
    [`${name} (composition)`, ...rest, true] as const,
  ]),
)(
  'tells the person which direction %s fails in and leaves the ledger and pin untouched',
  // Composition cases assemble both the pinned Host and a fresh recovery Host.
  { timeout: 60_000 },
  async (_name, code, cause, damage, composition) => {
    const { root, pinFile, generationFile } = await pinnedSessionRoot(composition)
    const generation = JSON.parse(readFileSync(generationFile, 'utf8')) as Record<string, unknown>
    damage(generation, { pinFile, generationFile })
    if (!damage.toString().includes('writeFileSync'))
      writeFileSync(generationFile, JSON.stringify(generation))
    const before = {
      pin: readFileSync(pinFile, 'utf8'),
      generation: readFileSync(generationFile, 'utf8'),
      ledgers: ledgerFiles(root).map(statSignature),
    }
    const again = await createTestHost({ dataDir: root, ...hostOptions(composition) })
    try {
      const failure = await again.host.createSession({ key: 'victim', cwd: root }).then(
        () => undefined,
        (error: unknown) => error as { code: string; detail: Record<string, unknown> },
      )
      expect(failure?.code).toBe(code)
      expect(failure?.detail).toMatchObject({
        cause,
        sessionKey: 'victim',
        localized: { en: expect.stringContaining('victim'), 'zh-CN': expect.stringContaining('你') },
      })
      // The session cannot continue, but its record is still readable without restoring anything.
      const rows = await again.host.readSessionRows('victim', { limit: 50 })
      expect(rows[0]?.type).toBe('session/start')
      // The same holds for the projected view the clients render: read-only, no notice, no writes.
      const view = await again.host.readSessionView('victim')
      expect(view).toMatchObject({ sessionId: 'victim', readOnly: true, lastSeq: rows.length })
      expect(view.notice).toBeUndefined()
      expect(readFileSync(pinFile, 'utf8')).toBe(before.pin)
      expect(readFileSync(generationFile, 'utf8')).toBe(before.generation)
      expect(ledgerFiles(root).map(statSignature)).toEqual(before.ledgers)
    } finally {
      await again.host.close()
    }
  },
)

it('reports a pin written by a newer AGH as newer, not as a generic failure', async () => {
  const { root, pinFile } = await pinnedSessionRoot()
  const record = JSON.parse(readFileSync(pinFile, 'utf8')) as Record<string, unknown>
  record.formatVersion = 7
  writeFileSync(pinFile, JSON.stringify(record))
  const again = await createTestHost({ dataDir: root, disableSessionTitle: true })
  try {
    await expect(again.host.createSession({ key: 'victim', cwd: root })).rejects.toMatchObject({
      code: 'E_SESSION_VERSION_NEWER',
      detail: { cause: 'E_GENERATION_PIN_NEWER', actions: ['upgrade'] },
    })
  } finally {
    await again.host.close()
  }
})

it('starts a later worker on the recorded head instead of snapshotting the same target again', async () => {
  const root = scratch()
  const first = await createTestHost({ dataDir: root, disableSessionTitle: true })
  try {
    await (await first.host.createSession({ key: 'first', cwd: root })).close()
  } finally {
    await first.host.close()
  }
  const second = await createTestHost({ dataDir: root, disableSessionTitle: true })
  try {
    const fresh = await second.host.createSession({ key: 'second', cwd: root })
    await fresh.close()
    const store = snapshotsOf(root)
    expect(store.session('second')?.generationId).toBe(store.session('first')?.generationId)
    expect(readdirSync(store.root).filter((name) => /^[a-f0-9-]{36}$/.test(name))).toHaveLength(1)
    const snapshot = store.read(store.session('second')!.generationId)
    const duplicate = store.create(
      decodeRuntimeTargetArtifact(snapshot.artifact),
      snapshot.sources,
      snapshot.compatibility,
      snapshot.packages,
      snapshot.resources,
      snapshot.seams,
    )
    store.pin('equivalent', duplicate.id, store.session('second')!.seams!)
    await store.collect(new Set())
    const resumed = await second.host.createSession({ key: 'equivalent', cwd: root })
    expect(resumed.pluginGenerationId).toBe(duplicate.id)
    expect(resumed.d.provider).toBeDefined()
    expect(resumed.d.provider).toBe(fresh.d.provider)
    const child = await second.host.createSession({
      key: 'equivalent-child',
      cwd: root,
      parent: { key: resumed.key, boundarySeq: resumed.lastSeq },
    })
    expect(child.pluginGenerationId).toBe(duplicate.id)
    expect(store.session(child.key)?.generationId).toBe(duplicate.id)
    await child.close()
    await second.host.releaseSessionGeneration?.(child.key)
    await resumed.close()
    const file = join(store.root, duplicate.id, 'generation.json')
    const saved = readFileSync(file, 'utf8')
    writeFileSync(file, JSON.stringify({ ...JSON.parse(saved), compatibility: 'tampered' }))
    await expect(second.host.createSession({ key: 'equivalent', cwd: root })).rejects.toMatchObject({
      code: 'E_SESSION_CORRUPT',
      detail: { cause: 'E_GENERATION_INTEGRITY' },
    })
    writeFileSync(file, saved)
    const recovered = await second.host.createSession({ key: 'equivalent', cwd: root })
    expect(recovered.pluginGenerationId).toBe(duplicate.id)
    await recovered.close()
    await second.host.releaseSessionGeneration?.('equivalent')
    expect(() => store.read(duplicate.id)).toThrow('E_GENERATION_SNAPSHOT_MISSING')
  } finally {
    await second.host.close()
  }
})

it('publishes a delivered target on the generation an earlier worker recorded for it', async () => {
  const root = scratch()
  // Like the daemon's, this target names no Host-default rows, so it differs from every boot target.
  const delivered = buildCompleteRuntimeTarget({ rows: [], resources: { mcp: [], skills: {} } }).target
  const generations = () =>
    readdirSync(snapshotsOf(root).root)
      .filter((name) => /^[a-f0-9-]{36}$/.test(name))
      .sort()
  const first = await createTestHost({ dataDir: root, disableSessionTitle: true })
  let published: string | undefined
  try {
    await first.host.applyRuntimeTarget(delivered)
    published = first.host.lastChange?.()?.generationId
    await (await first.host.createSession({ key: 'first', cwd: root })).close()
  } finally {
    await first.host.close()
  }
  const before = generations()
  expect(snapshotsOf(root).session('first')?.generationId).toBe(published)
  const second = await createTestHost({ dataDir: root, disableSessionTitle: true })
  try {
    // The new worker snapshots its own boot target first; the delivery then matches the earlier one.
    await second.host.applyRuntimeTarget(delivered)
    expect(second.host.lastChange?.()).toMatchObject({ outcome: 'in-place', generationId: published })
    const resumed = await second.host.createSession({ key: 'first', cwd: root })
    expect(resumed.pluginGenerationId).toBe(published)
    await resumed.close()
  } finally {
    await second.host.close()
  }
  expect(generations()).toEqual(before)
})

it('fences two Hosts through a failed candidate, live config, collection and reopen', async () => {
  const root = scratch()
  const delivered = buildCompleteRuntimeTarget({ rows: [], resources: { mcp: [], skills: {} } }).target
  let refuseProvider = false
  const options = {
    dataDir: root,
    disableSessionTitle: true,
    provider: (profile) => {
      if (refuseProvider)
        throw new HostError('E_SEAM_INIT', 'refused E_LEASE_EXPIRED is diagnostic text', {
          detail: { reason: 'provider-unavailable' },
        })
      return new ScriptedProvider({
        scripts: [],
        models: profile.provider.routes?.flatMap((route) => route.models ?? []) ?? [],
      })
    },
  } satisfies TestHostOptions
  const first = await createTestHost(options)
  let second: Awaited<ReturnType<typeof createTestHost>> | undefined
  let reopened: Awaited<ReturnType<typeof createTestHost>> | undefined
  const sessions: Awaited<ReturnType<typeof first.host.createSession>>[] = []
  try {
    await first.host.applyRuntimeTarget(delivered)
    const running = first.host.lastChange?.()?.generationId
    const firstSession = await first.host.createSession({ key: 'first', cwd: root })
    sessions.push(firstSession)
    // The second boot replaces the durable head while the first Host still runs it.
    second = await createTestHost(options)
    const boot = second.host.runtimeTargetSnapshot!()
    await second.host.applyRuntimeTarget(delivered)
    const published = second.host.lastChange?.()?.generationId
    expect(published).toBeDefined()
    expect(published).not.toBe(running)
    const secondSession = await second.host.createSession({ key: 'second', cwd: root })
    sessions.push(secondSession)
    refuseProvider = true
    await expect(second.host.applyRuntimeTarget(boot)).rejects.toMatchObject({ code: 'E_SEAM_INIT' })
    expect(second.host.lastChange?.()).toMatchObject({
      outcome: 'rejected',
      recovered: true,
      failures: [{ code: 'E_SEAM_INIT', reason: 'provider-unavailable' }],
    })
    const failed = second.host.pluginGenerationStatus?.().generations.find((g) => g.state === 'failed')
    expect(failed).toMatchObject({ error: 'E_SEAM_INIT', boundSessions: 0, live: false })
    expect(second.host.kernel.get('second')).toBe(secondSession)
    refuseProvider = false
    await second.host.applyRuntimeTarget(boot)
    const recovered = second.host.lastChange?.()?.generationId
    expect(recovered).toBeDefined()
    expect(recovered).not.toBe(failed?.id)
    // Keep an equivalent archive by a durable pin, with accepted live config. It must not
    // become a publication candidate even after its live holder has closed.
    const store = snapshotsOf(root)
    const snapshot = store.read(published!)
    const configured = store.create(
      decodeRuntimeTargetArtifact(snapshot.artifact),
      snapshot.sources,
      snapshot.compatibility,
      snapshot.packages,
      snapshot.resources,
      snapshot.seams,
    )
    store.saveLiveConfig(published!, encodeRuntimeTargetArtifact(delivered))
    store.pin('configured', configured.id, store.session('second')!.seams!)
    store.saveLiveConfig(configured.id, encodeRuntimeTargetArtifact(delivered))
    for (const session of sessions.splice(0)) await session.close()
    await second.host.close()
    second = undefined
    await store.collect(new Set())
    expect(store.read(configured.id).id).toBe(configured.id)
    expect(store.session('first')?.generationId).toBe(running)
    reopened = await createTestHost(options)
    await reopened.host.applyRuntimeTarget(delivered)
    expect(reopened.host.lastChange?.()?.generationId).not.toBe(running)
    expect(reopened.host.lastChange?.()?.generationId).not.toBe(configured.id)
    expect(reopened.host.lastChange?.()?.generationId).not.toBe(published)
    const resumed = await reopened.host.createSession({ key: 'second', cwd: root })
    sessions.push(resumed)
    expect(resumed.pluginGenerationId).toBe(published)
    expect(store.liveConfig(configured.id)?.digest).toBe(encodeRuntimeTargetArtifact(delivered).digest)
    expect(() => store.read(failed!.id)).toThrow('E_GENERATION_SNAPSHOT_MISSING')
  } finally {
    refuseProvider = false
    for (const session of sessions) await session.close()
    await reopened?.host.close()
    await second?.host.close()
    await first.host.close()
  }
})

it('never publishes on a generation this host still runs for an open session', async () => {
  const root = scratch()
  const delivered = buildCompleteRuntimeTarget({ rows: [], resources: { mcp: [], skills: {} } }).target
  const { host } = await createTestHost({ dataDir: root, disableSessionTitle: true })
  try {
    const boot = host.runtimeTargetSnapshot?.()
    if (!boot) throw new Error('test host has no runtime target')
    await host.applyRuntimeTarget(delivered)
    const open = await host.createSession({ key: 'open', cwd: root })
    const pinned = open.pluginGenerationId
    // A code change with a bound session forks a container; the open session stays on the old one.
    await host.applyRuntimeTarget(boot)
    expect(host.lastChange?.()).toMatchObject({ outcome: 'forked' })
    // Publishing the first target again matches the generation the open session still runs on.
    await host.applyRuntimeTarget(delivered)
    expect(host.lastChange?.()?.generationId).not.toBe(pinned)
    expect(host.kernel.get(open.key)).toBe(open)
    await open.close()
  } finally {
    await host.close()
  }
})
