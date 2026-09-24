import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import { fakeSeams, testFsPolicy } from '@agnes/core/testkit'
import type { ExtensionManifest } from '@agnes/extension-api'
import type { InferenceEvent } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillRuntimeInput } from '../../src/resources/skills.js'
import { createTestHost } from '../../testkit/index.js'

// The package directory, not an import: this is a real assemble()-based integration test - the host
// loads @agnes/base's real bundled `agnes/skills` and `agnes/mcp-search` extensions off disk, exactly the way
// createTestHost's other production-path cases do (see test/ext-host/base-tools.test.ts).
const baseDir = fileURLToPath(new URL('../../../base', import.meta.url))
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agnes-reload-ecosystem-'))
  dirs.push(d)
  return d
}

/** One ready Skill resource, matching the fixture shape test/ext-host/base-tools.test.ts already uses. */
const fakeSkillRuntimeInput = (hexChar: string): SkillRuntimeInput => {
  const resourceId = `skill/user/user-agnes/${hexChar.repeat(64)}`
  return {
    list: () => [
      {
        kind: 'skill',
        resourceId,
        name: `skill-${hexChar}`,
        description: 'A test skill.',
        revision: 'b'.repeat(64),
        sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: 'c'.repeat(64) },
        priority: 400,
        resolution: { winner: true, shadowed: [] },
        trust: 'trusted',
        desired: 'enabled',
        actual: 'ready',
        stale: false,
      },
    ],
    read: (id) =>
      id === resourceId ? { ok: true, content: 'skill body' } : { ok: false, code: 'NOT_FOUND' },
    readFile: () => ({ ok: false, code: 'NOT_FOUND' as const }),
  }
}

// Every shipped template (templates/local-dev.yaml, templates/enterprise.yaml) routes almost every
// seam to @agnes/base, the same package that bundles agnes/skills. managed-host's
// own E_SEAM_IMMUTABLE guard (see managed-host.ts's `mutable()`, tested in
// managed-host.test.ts: "protects the owning seam package even when its extension id differs")
// refuses to revoke *any* extension owned by a package that supplies a seam, deliberately and by
// package identity - not only the seam factory itself. Task 3 found this was a real conflict with
// reloading agnes/mcp-client (retired in MCP rows step 4) and agnes/skills in a default deployment
// (see task-3-report.md); Task 3b resolved it with a narrow allowlist naming exactly those extension
// ids (see task-3b-report.md and the "reloads agnes/skills end-to-end under the real default
// template" test below, which exercises the real unmodified template). The two tests immediately below still use this
// seam-rerouted fixture on purpose: they isolate the reload *plumbing* question (manifest re-lookup,
// spec reconstruction, fresh ecosystemContext, sequential revoke-then-load genuinely swapping the
// registered set rather than appending to it) from the seam-immutability allowlist question, so a
// regression in either one fails a different, more specific test.
const SEAM_NAMES = [
  'approval',
  'checkpoint',
  'ledger',
  'sandbox',
  'verifier',
  'repair',
  'artifacts',
  'principals',
  'harness',
] as const

/**
 * Reroutes every seam from @agnes/base to @agnes/code, so agnes/skills (bundled by @agnes/base)
 * is not seam-protected in this fixture. The sandbox fake must still report the real workspace root
 * or assemble()'s `adapters.bindFsPolicy` refuses the whole host at startup (matching the same fix
 * createTestHost applies to its own default @agnes/base sandbox fake).
 */
const seamsOnCode = (
  dataDir: string,
): Pick<Parameters<typeof createTestHost>[0], 'profileInputs' | 'packages'> => {
  const seamsImpl = fakeSeams({})
  const testExec = seamsImpl.sandbox.exec.bind(seamsImpl.sandbox)
  const forWorkspace: NonNullable<typeof seamsImpl.sandbox.forWorkspace> = async (workspace) => ({
    forWorkspace,
    exec: testExec,
    confine: async (argv) => [...argv],
    fsPolicy: () => workspace.policy,
    enforcement: () => ({ level: 'full', scope: ['file', 'network', 'process'] }),
  })
  seamsImpl.sandbox = {
    ...seamsImpl.sandbox,
    forWorkspace,
    fsPolicy: () => {
      const policy = testFsPolicy('/workspace')
      const workspaceRoot = realpathSync(dataDir)
      const rules = policy.rules.map((rule) => ({
        ...rule,
        path: join(workspaceRoot, ...rule.path.slice(policy.workspaceRoot.length).split('/')),
      }))
      const content = { ...policy, workspaceRoot, rules }
      return { ...content, digest: createHash('sha256').update(JSON.stringify(content)).digest('hex') }
    },
  }
  return {
    profileInputs: {
      user: { name: 'local-dev', seams: Object.fromEntries(SEAM_NAMES.map((n) => [n, '@agnes/code'])) },
    },
    packages: {
      '@agnes/code': {
        sandboxWorkspaceProbe: async () => ({
          name: 'bwrap',
          execBackend: 'l1',
          enforcement: { level: 'full', scope: ['file', 'network', 'process'] },
          degraded: false,
          confine: ({ argv }) => argv,
        }),
        seams: Object.fromEntries(SEAM_NAMES.map((n) => [n, async () => seamsImpl[n]])),
      },
    },
  }
}

describe('Host.reloadEcosystemExtension', () => {
  // Design §3.9 (D123): agnes/mcp-search's tool_search lists the Skills generation agnes/skills
  // currently serves. Reloading agnes/skills alone changes what it lists; the search extension itself
  // is never reloaded, which is why a resource reload no longer has to touch it.
  it('tool_search follows the Skills generation agnes/skills serves, without reloading agnes/mcp-search', async () => {
    const dataDir = scratch()
    const searchSkills: InferenceEvent[] = [
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'tool_search', args: { query: 'skill' }, ordinal: 0 },
        via: 'native',
      },
      { type: 'done', reason: 'toolUse' },
    ]
    const done: InferenceEvent[] = [
      { type: 'text_delta', delta: 'done' },
      { type: 'done', reason: 'stop' },
    ]
    const provider = new ScriptedProvider({
      models: [fakeModel({ route: 'gw', id: 'm1' })],
      scripts: [searchSkills, done, searchSkills, done],
      onExhausted: 'error',
    })
    const { host, audit } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      provider,
      disableSessionTitle: true,
      skillResources: fakeSkillRuntimeInput('a'),
    })
    try {
      const session = await host.createSession({ cwd: dataDir })
      const searchTurn = async () => {
        const from = session.lastSeq + 1
        await session.enqueue('next-turn', {
          content: [{ type: 'text', text: 'Which Skills do I have?' }],
          actor: session.d.actor,
          kind: 'prompt',
        })
        await expect(
          session.run({ until: 'turn-end', signal: new AbortController().signal }),
        ).resolves.toMatchObject({ reason: 'completed' })
        const rows = await session.scan({ fromSeq: from, toSeq: session.lastSeq })
        return JSON.stringify(rows.filter((row) => row.type === 'tool/result'))
      }
      const before = await searchTurn()
      expect(before).toContain('skill-a')

      const mark = audit.events.length
      const status = await host.reloadEcosystemExtension('agnes/skills', {
        skillResources: fakeSkillRuntimeInput('e'),
      })
      expect(status).toMatchObject({ id: 'agnes/skills', loaded: true })

      const after = await searchTurn()
      expect(after).toContain('skill-e')
      expect(after).not.toContain('skill-a')
      // Only agnes/skills was reloaded; agnes/mcp-search kept running the whole time.
      const reloaded = audit.events
        .slice(mark)
        .filter((event) => event.kind.startsWith('extension.'))
        .map((event) => (event.detail as { id?: string }).id)
      expect(reloaded).not.toContain('agnes/mcp-search')
      expect(reloaded).toContain('agnes/skills')
    } finally {
      await host.close()
    }
  })

  // agnes/skills goes through the bundled-extension reload pipeline (owner gating in assemble.ts's
  // ecosystemContext, loadBundledExtensions/manifest mechanism, declared in @agnes/base's own
  // package.json `agnes.extensions` array).
  // Skills are now session-scoped and deliberately absent from the worker-global resource registry.
  // Verify the same reload pipeline through the context hook a live session actually consumes.
  it("swaps agnes/skills' session-scoped catalog", async () => {
    const dataDir = scratch()
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      disableSessionTitle: true,
      skillResources: fakeSkillRuntimeInput('a'),
      ...seamsOnCode(dataDir),
    })
    try {
      expect(host.extensions().find((s) => s.id === 'agnes/skills')).toMatchObject({ loaded: true })
      const before = await host.createSession({ key: 'skills-before', cwd: dataDir })
      const catalog = async (session: typeof before) =>
        (await session.hooks.context([])).map((section) => section.text).join('\n')
      expect(await catalog(before)).toContain('skill-a')
      expect(await catalog(before)).not.toContain('skill-e')

      const status = await host.reloadEcosystemExtension('agnes/skills', {
        skillResources: fakeSkillRuntimeInput('e'),
      })

      expect(status).toMatchObject({ id: 'agnes/skills', loaded: true })
      const after = await host.createSession({ key: 'skills-after', cwd: dataDir })
      expect(await catalog(after)).not.toContain('skill-a')
      expect(await catalog(after)).toContain('skill-e')
    } finally {
      await host.close()
    }
  })

  it('refuses to reload an extension id that is not a bundled ecosystem extension', async () => {
    const dataDir = scratch()
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      disableSessionTitle: true,
      ...seamsOnCode(dataDir),
    })
    try {
      await expect(host.reloadEcosystemExtension('agnes/not-a-real-extension', {})).rejects.toThrow()
    } finally {
      await host.close()
    }
  })

  // Task 8: a packaged build (tools/build-local.ts's SEA) has no `extensions/` subdirectories or
  // package.json beside its own packageDirectory - only the compiled-in `embeddedExtensions` manifest
  // array (see packages/cli/launch/packaged-host.ts's AGNES_BASE_EXTENSION_MANIFESTS). Task 3's
  // findBundledExtension only ever implemented the filesystem-scan path (readBundledExtensionDirs +
  // readAuthorManifest), so it never found a reloadable extension (then agnes/mcp-client, now
  // agnes/skills) under this shape and
  // reloadEcosystemExtension always threw E_EXT_LOAD - safely (Task 7 confirmed), but the reload
  // never actually took effect on a real packaged build. This test reproduces that shape without a
  // real SEA build: no `packageDirs` override for @agnes/base, so it defaults to `dataDir`, which
  // has no package.json (path 1 finds nothing); `embeddedExtensions` supplies the manifest instead,
  // exactly the way loadBundledExtensions' embeddedExtensions loop at assemble time does.
  it('reloads a builtin extension that is only reachable via embeddedExtensions (packaged-build shape)', async () => {
    const dataDir = scratch()
    const skillsManifest = JSON.parse(
      readFileSync(new URL('../../../base/extensions/skills/agnes.extension.json', import.meta.url), 'utf8'),
    ) as ExtensionManifest
    // seamsOnCode's own `packages` overlay (for @agnes/code) must be spread before adding the
    // @agnes/base overlay below - a later `packages:` key in the same object literal replaces the
    // earlier one outright rather than merging, since this is plain object-literal key overwrite.
    const seams = seamsOnCode(dataDir)
    const { host } = await createTestHost({
      dataDir,
      disableSessionTitle: true,
      skillResources: fakeSkillRuntimeInput('a'),
      ...seams,
      packages: { ...seams.packages, '@agnes/base': { embeddedExtensions: [skillsManifest] } },
    })
    try {
      expect(host.extensions().find((s) => s.id === 'agnes/skills')).toMatchObject({ loaded: true })
      const catalog = async (key: string) =>
        (await (await host.createSession({ key, cwd: dataDir })).hooks.context([]))
          .map((section) => section.text)
          .join('\n')
      expect(await catalog('embedded-before')).toContain('skill-a')

      const status = await host.reloadEcosystemExtension('agnes/skills', {
        skillResources: fakeSkillRuntimeInput('b'),
      })

      expect(status).toMatchObject({ id: 'agnes/skills', loaded: true })
      // The reload actually took effect with the fresh resources, not just "did not throw" - this is
      // the distinction between "fails safely" (Task 7) and "genuinely succeeds" (Task 8).
      const after = await catalog('embedded-after')
      expect(after).toContain('skill-b')
      expect(after).not.toContain('skill-a')
      expect(host.extensions().filter((s) => s.id === 'agnes/skills')).toHaveLength(1)
    } finally {
      await host.close()
    }
  })

  it('reloads agnes/skills end-to-end under the real default template, now that it is allowlisted', async () => {
    const dataDir = scratch()
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      disableSessionTitle: true,
      skillResources: fakeSkillRuntimeInput('a'),
    })
    try {
      expect(host.extensions().find((s) => s.id === 'agnes/skills')).toMatchObject({
        loaded: true,
        package: '@agnes/base',
      })
      const before = await host.createSession({ key: 'skills-before', cwd: dataDir })
      const catalog = async (session: typeof before) =>
        (await session.hooks.context([])).map((section) => section.text).join('\n')
      expect(await catalog(before)).toContain('skill-a')
      expect(await catalog(before)).not.toContain('skill-b')

      const status = await host.reloadEcosystemExtension('agnes/skills', {
        skillResources: fakeSkillRuntimeInput('b'),
      })

      expect(status).toMatchObject({ id: 'agnes/skills', loaded: true })
      // The old generation's catalog is genuinely gone from the live session.
      const after = await host.createSession({ key: 'skills-after', cwd: dataDir })
      expect(await catalog(after)).not.toContain('skill-a')
      expect(await catalog(after)).toContain('skill-b')
      // Reload replaced the existing record in place; it did not add a second one.
      expect(host.extensions().filter((s) => s.id === 'agnes/skills')).toHaveLength(1)
    } finally {
      await host.close()
    }
  })
})
