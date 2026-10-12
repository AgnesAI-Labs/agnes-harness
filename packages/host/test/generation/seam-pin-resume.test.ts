import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { approvalKind } from '@agnes/extension-api/seams'
import { RuntimeGenerationSnapshotStore } from '@agnes/package-manager'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import { afterEach, expect, it } from 'vitest'
import { createTestHost } from '../../testkit/index.js'

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
        apply: (ctx: {
          providers: { register(kind: unknown, source: string, provider: unknown): unknown }
        }) => {
          ctx.providers.register(approvalKind, '@agnes/code', alternate)
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
    profileInputs: { user: { name: 'local-dev', seams: { approval: { provider: 'alt' } } } },
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
    profileInputs: { user: { name: 'local-dev', seams: { approval: { provider: 'alt' } } } },
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
    await (await second.host.createSession({ key: 'second', cwd: root })).close()
    const store = snapshotsOf(root)
    expect(store.session('second')?.generationId).toBe(store.session('first')?.generationId)
    expect(readdirSync(store.root).filter((name) => /^[a-f0-9-]{36}$/.test(name))).toHaveLength(1)
  } finally {
    await second.host.close()
  }
})
