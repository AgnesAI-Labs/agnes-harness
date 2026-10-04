import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { kill } from 'node:process'
import type { CallContext } from '@agnes/extension-api/runtime'
import type { RuntimeWireTypes as W } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import {
  buildLockedPackage,
  type PackageBuildInput,
  type PackageBuildWorkspace,
  packageBuildApprovalDigest,
} from '../../src/runtime/package-build.js'
import { inspectLockedPackage, type SourceBuildDeclaration } from '../../src/runtime/package-inspect.js'
import { sha256Hex } from '../../src/runtime/source-snapshot.js'
import { buildQualified } from './fixtures/installer-apply-build.js'

type Kind = 'default' | 'reference'
interface NativeFixture {
  directory: string
  roots: { workspace: string; home: string; data: string }
  createInput: W['SandboxCreateRequest']
  sandbox: PackageBuildWorkspace['sandbox']
  exec: PackageBuildWorkspace['exec']
  auth: { call(patch?: Partial<CallContext>): CallContext }
  release(): Promise<void>
  close(): Promise<void>
}
interface FixturePackage {
  lock: W['PackageLockEntry']
  locator: W['PackageLocator']
  archive: Buffer
  files: readonly { path: string; bytes: Buffer }[]
}
const nativeModule = new URL('../../../host/test/runtime/sandbox-exec-fixture.ts', import.meta.url)
const pluginModule = new URL(
  '../../../../tools/acceptance/runtime/fixtures/broken-plugin.ts',
  import.meta.url,
)
const { fixture: native } = (await import(nativeModule.href)) as {
  fixture(kind: Kind): Promise<NativeFixture>
}
const { createBrokenPlugin, writeBrokenPlugin, packageBuildProgram } = (await import(pluginModule.href)) as {
  createBrokenPlugin(mode: 'approved-build', kind: 'local' | 'npm' | 'git'): FixturePackage
  writeBrokenPlugin(root: string, fixture: FixturePackage): void
  packageBuildProgram(fault?: string): string
}
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
const script = (program: string): string => `exec ${quote(process.execPath)} -e ${quote(program)}`
const limits: W['ResourceLimits'] = {
  cpuMs: 8000,
  wallMs: 5000,
  memoryBytes: 512 * 1024 * 1024,
  outputBytes: 65536,
  processes: 16,
  openFiles: 256,
}
const alive = (pid: number): boolean => {
  try {
    kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function waitForTrace(path: string, run: () => void): Promise<void> {
  const end = Date.now() + 4000
  while (Date.now() < end) {
    if (existsSync(path) && readFileSync(path, 'utf8').trim().split(' ').length === 2) {
      run()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Build did not start')
}

async function inputFor(
  options: {
    kind?: Kind
    rootSource?: boolean
    sourceKind?: 'local' | 'npm' | 'git'
    program?: string
    declaration?: Partial<SourceBuildDeclaration>
    signal?: AbortSignal
    interrupt?: 'kill'
    onStart?: () => void
    ceilings?: W['ResourceLimits']
  } = {},
) {
  const pkg = createBrokenPlugin('approved-build', options.sourceKind ?? 'local')
  const build: SourceBuildDeclaration = {
    script: script(options.program ?? packageBuildProgram()),
    network: [],
    readPaths: ['./'],
    writePaths: ['./'],
    ...options.declaration,
  }
  const sourceRoot = options.rootSource ? mkdtempSync(join(tmpdir(), 'agh-build-source-')) : undefined
  if (sourceRoot) writeBrokenPlugin(sourceRoot, pkg)
  const acquired = {
    locator: pkg.locator,
    content: sourceRoot ? { root: sourceRoot } : { archive: pkg.archive },
    build,
  }
  const inspected = await inspectLockedPackage({
    lock: pkg.lock,
    acquire: async () => ({ ok: true, value: acquired }),
  })
  if (!inspected.ok) throw new Error(inspected.detailCode)
  const kind = options.kind ?? 'default'
  const starts: string[] = []
  const staged: string[] = []
  const directories: string[] = [],
    observedPids: number[] = [],
    outsideWrites: boolean[] = []
  const expected = packageBuildApprovalDigest(
    inspected.value.buildPlan,
    options.ceilings ?? limits,
    'cooperative',
  )
  const input: PackageBuildInput = {
    plan: inspected.value.buildPlan,
    lock: pkg.lock,
    limits: options.ceilings ?? limits,
    minimumOwnership: 'cooperative',
    ...(options.signal ? { signal: options.signal } : {}),
    acquire: async () => ({ ok: true, value: acquired }),
    authorize: async (digest) => digest === expected,
    async openWorkspace() {
      const f = await native(options.kind ?? 'default')
      directories.push(f.directory)
      const trace = join(f.roots.workspace, 'build-pids')
      return {
        root: f.roots.workspace,
        request:
          f.createInput.resourceLimits === input.limits
            ? f.createInput
            : { ...f.createInput, resourceLimits: input.limits },
        sandbox: {
          ...f.sandbox,
          async create(body, context) {
            starts.push('sandbox')
            return f.sandbox.create(body, context)
          },
        },
        exec: {
          ...f.exec,
          async run(body, context) {
            starts.push('exec')
            const pending = f.exec.run(body, context)
            if (options.interrupt === 'kill')
              await waitForTrace(trace, () => {
                const [pid] = readFileSync(trace, 'utf8').trim().split(' ').map(Number)
                if (!pid || pid < 2) throw new Error('Invalid workload PID')
                kill(pid, 'SIGKILL')
              })
            if (options.onStart) await waitForTrace(trace, options.onStart)
            return pending
          },
        },
        call(operation, signal) {
          return f.auth.call(operation === 'stop' ? {} : signal ? { signal } : {})
        },
        async dispose() {
          for (const name of ['source', 'source.archive', 'artifact.tar', 'build-pids'])
            if (existsSync(join(f.roots.workspace, name))) staged.push(name)
          outsideWrites.push(existsSync(join(f.directory, 'outside-build')))
          if (existsSync(trace))
            observedPids.push(...readFileSync(trace, 'utf8').trim().split(' ').map(Number))
          try {
            await f.release()
          } finally {
            try {
              await f.close()
            } finally {
              rmSync(f.directory, { recursive: true, force: true })
            }
          }
        },
      }
    },
  }
  return { input, pkg, kind, starts, staged, directories, observedPids, outsideWrites, sourceRoot }
}

const cleanup = (f: Awaited<ReturnType<typeof inputFor>>) => {
  expect(f.directories.every((path) => !existsSync(path))).toBe(true)
  if (f.sourceRoot) rmSync(f.sourceRoot, { recursive: true, force: true })
  expect(f.observedPids.every((pid) => Number.isSafeInteger(pid) && pid > 1 && !alive(pid))).toBe(true)
}

async function refusesUnqualified(f: Awaited<ReturnType<typeof inputFor>>, input = f.input) {
  if (await buildQualified(f.kind)) return false
  expect(await buildLockedPackage(input)).toMatchObject({
    ok: false,
    error: { code: 'incompatible', detailCode: 'build_mechanism_unqualified' },
  })
  expect(f.starts).toEqual([])
  expect(f.staged).toEqual([])
  expect(f.observedPids).toEqual([])
  expect(f.outsideWrites).toEqual([false])
  expect(f.directories).toHaveLength(1)
  cleanup(f)
  return true
}

describe('package build approval and qualification', () => {
  it.each([
    ['no approval reader', 'build_unapproved'],
    ['strong ownership', 'build_ownership_unqualified'],
    ['secret environment', 'secret_consumer_unavailable'],
    ['requested network', 'build_network_unqualified'],
    ['zero ceiling', 'build_limits_invalid'],
    ['changed plan', 'build_plan_changed'],
    ['changed source declaration', 'build_plan_changed'],
  ])('refuses %s before any script runs', async (mode, detailCode) => {
    const f = await inputFor({
      declaration:
        mode === 'secret environment'
          ? { secretEnv: ['FIXTURE_SECRET'] }
          : mode === 'requested network'
            ? { network: ['https://example.invalid'] }
            : {},
    })
    let input = f.input
    if (mode === 'no approval reader') {
      const { authorize: _authorize, ...rest } = input
      input = rest
    }
    if (mode === 'strong ownership') input = { ...input, minimumOwnership: 'strong' }
    if (mode === 'zero ceiling') input = { ...input, limits: { ...input.limits, wallMs: 0 } }
    if (mode === 'changed plan')
      input = { ...input, plan: { ...input.plan, steps: [{ ...input.plan.steps[0]!, script: 'exit 0' }] } }
    if (mode === 'changed source declaration')
      input = {
        ...input,
        acquire: async () => ({
          ok: true,
          value: {
            locator: f.pkg.locator,
            content: { archive: f.pkg.archive },
            build: { ...input.plan.steps[0]!, script: 'exit 0' },
          },
        }),
      }
    expect(await buildLockedPackage(input)).toMatchObject({ ok: false, error: { detailCode } })
    expect(f.directories).toEqual([])
  })
  it.each(['default', 'reference'] as const)(
    'requires complete hard-limit qualification for the %s service before launch',
    async (kind) => {
      const f = await inputFor({ kind })
      if (await refusesUnqualified(f)) return
      expect(await buildLockedPackage(f.input)).toMatchObject({ ok: true })
      cleanup(f)
    },
  )
})

describe.each(['default', 'reference'] as const)(
  '%s isolated builds require qualified hard limits and cooperative ownership',
  (kind) => {
    it.each(['local', 'npm', 'git'] as const)(
      'rebuilds locked %s content twice and keeps all three identities',
      async (sourceKind) => {
        const f = await inputFor({ kind, sourceKind })
        if (await refusesUnqualified(f)) return
        const outcome = await buildLockedPackage(f.input)
        expect(outcome).toMatchObject({
          ok: true,
          value: { ownership: 'cooperative', reproducibility: { verified: true } },
        })
        if (!outcome.ok) throw new Error(outcome.error.detailCode)
        expect(outcome.value.reproducibility.attempts).toHaveLength(2)
        for (const identity of outcome.value.reproducibility.attempts) {
          expect(identity.packageDigest).toBe(f.pkg.lock.digest)
          expect(identity.manifestDigest).toBe(
            f.pkg.lock.manifestRef.kind === 'inline' ? f.pkg.lock.manifestRef.digest : '',
          )
          expect(identity.archiveIntegrity).toBe(
            sourceKind === 'npm' && f.pkg.locator.kind === 'npm'
              ? f.pkg.locator.integrity
              : `sha256-${sha256Hex(outcome.value.archive)}`,
          )
          expect(new Set(Object.values(identity)).size).toBe(3)
        }
        expect(outcome.value.audit).toHaveLength(2)
        for (const row of outcome.value.audit) {
          expect(row.sandbox.achievedIsolation).toBe('isolated-process')
          expect(row.sandbox.limits).toEqual(f.input.limits)
          expect(row.execution).toMatchObject({ state: 'exited', exitCode: 0, effectStatus: 'confirmed' })
        }
        expect(f.directories).toHaveLength(2)
        expect(outcome.value.inspection.manifest.build.reproducible).toBe(false)
        cleanup(f)
      },
      30000,
    )

    it('rebuilds an acquired local directory without changing it', async () => {
      const f = await inputFor({ kind, rootSource: true })
      if (await refusesUnqualified(f)) return
      const result = await buildLockedPackage(f.input)
      expect(result).toMatchObject({ ok: true, value: { reproducibility: { verified: true } } })
      if (!f.sourceRoot) throw new Error('Missing source root')
      expect(readFileSync(join(f.sourceRoot, 'src/runtime.txt'), 'utf8')).toBe(
        'fixture entry must never execute',
      )
      cleanup(f)
    }, 30000)

    it.each([
      ['entry-missing', 'entry_missing'],
      ['malicious-manifest', 'manifest_invalid'],
      ['corrupt', 'file_digest_mismatch'],
      ['archive-corrupt', 'archive_invalid'],
    ])(
      'refuses built %s and discards staging',
      async (fault, detailCode) => {
        const f = await inputFor({ kind, program: packageBuildProgram(fault) })
        if (await refusesUnqualified(f)) return
        expect(await buildLockedPackage(f.input)).toMatchObject({ ok: false, error: { detailCode } })
        cleanup(f)
      },
      30000,
    )

    it('denies writing outside the build root', async () => {
      const hostile = await inputFor({
        kind,
        program: "require('node:fs').writeFileSync('../outside-build', 'escape')",
      })
      if (await refusesUnqualified(hostile)) return
      expect(await buildLockedPackage(hostile.input)).toMatchObject({
        ok: false,
        error: { detailCode: 'build_execution_failed' },
      })
      expect(hostile.outsideWrites).toEqual([false])
      cleanup(hostile)
    })

    it('denies an undeclared real loopback connection', async () => {
      let accepted = 0
      const server = createServer((socket) => {
        accepted++
        socket.destroy()
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      try {
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Missing server address')
        const f = await inputFor({
          kind,
          program: `const net=require('node:net'); const s=net.connect(${address.port},'127.0.0.1'); s.on('error',()=>process.exit(23)); s.on('connect',()=>process.exit(0));`,
        })
        if (await refusesUnqualified(f)) return
        expect(await buildLockedPackage(f.input)).toMatchObject({
          ok: false,
          error: { detailCode: 'build_execution_failed' },
        })
        expect(accepted).toBe(0)
        cleanup(f)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })

    it.each(['wallMs', 'outputBytes'] as const)(
      'enforces %s through Exec and harvests descendants',
      async (field) => {
        const f = await inputFor({
          kind,
          ceilings: { ...limits, [field]: field === 'wallMs' ? 700 : 1024 },
          program: `
        const fs=require('node:fs'), cp=require('node:child_process');
        const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},100)'],{detached:true,stdio:['ignore','ignore','ignore',3]});
        fs.writeFileSync('build-pids', process.pid+' '+child.pid);
        ${field === 'outputBytes' ? "setInterval(()=>process.stdout.write('x'.repeat(256)),10);" : 'setInterval(()=>{},100);'}
      `,
        })
        if (await refusesUnqualified(f)) return
        expect(await buildLockedPackage(f.input)).toMatchObject({
          ok: false,
          error: { code: 'quota', detailCode: `exec_limit_${field}` },
        })
        expect(f.observedPids).toHaveLength(2)
        cleanup(f)
      },
      30000,
    )

    it('fails a killed builder and harvests its detached child and partial output', async () => {
      const f = await inputFor({
        kind,
        interrupt: 'kill',
        program: `
        const fs=require('node:fs'), cp=require('node:child_process');
        const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},100)'],{detached:true,stdio:['ignore','ignore','ignore',3]});
        fs.writeFileSync('artifact.tar','partial');
        fs.writeFileSync('build-pids', process.pid+' '+child.pid);
        setInterval(()=>{},100);
      `,
      })
      if (await refusesUnqualified(f)) return
      const result = await buildLockedPackage(f.input)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('Killed build succeeded')
      expect(['build_execution_failed', 'exec_residual', 'exec_unknown']).toContain(result.error.detailCode)
      expect(f.observedPids).toHaveLength(2)
      cleanup(f)
    }, 30000)

    it('cancels an active build, reaps descendants and discards partial output', async () => {
      const controller = new AbortController()
      const f = await inputFor({
        kind,
        signal: controller.signal,
        onStart: () => controller.abort(),
        program: `
        const fs=require('node:fs'), cp=require('node:child_process');
        const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},100)'],{detached:true,stdio:['ignore','ignore','ignore',3]});
        fs.writeFileSync('artifact.tar','partial');
        fs.writeFileSync('build-pids', process.pid+' '+child.pid);
        setInterval(()=>{},100);
      `,
      })
      if (await refusesUnqualified(f)) return
      const result = await buildLockedPackage(f.input)
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'unknown_effect', detailCode: 'exec_unknown' },
      })
      expect(f.observedPids).toHaveLength(2)
      cleanup(f)
    }, 30000)

    it.each([
      ["require('node:fs').symlinkSync('source.archive', 'artifact.tar')", 'build_artifact_invalid'],
      ['', 'build_artifact_missing'],
    ])('rejects invalid artifact output (%s) and retains no staging files', async (program, detailCode) => {
      const f = await inputFor({
        kind,
        program,
      })
      if (await refusesUnqualified(f)) return
      expect(await buildLockedPackage(f.input)).toMatchObject({
        ok: false,
        error: { detailCode },
      })
      cleanup(f)
    })

    it.each(['mechanism', 'proof', 'cleanup'] as const)(
      'refuses an unproven %s instead of producing a successful artifact',
      async (mode) => {
        const f = await inputFor({ kind })
        const open = f.input.openWorkspace
        if (await refusesUnqualified(f)) return
        const result = await buildLockedPackage({
          ...f.input,
          async openWorkspace(attempt, signal) {
            const workspace = await open(attempt, signal)
            return {
              ...workspace,
              exec: {
                ...workspace.exec,
                features:
                  mode === 'mechanism'
                    ? workspace.exec.features.filter((feature) => feature !== 'outputBytes')
                    : workspace.exec.features,
              },
              sandbox: {
                ...workspace.sandbox,
                async create(body, context) {
                  const created = await workspace.sandbox.create(body, context)
                  if (!created.ok || mode !== 'proof') return created
                  return {
                    ok: true,
                    value: {
                      ...created.value,
                      filesystemProof: { ...created.value.filesystemProof, digest: '0'.repeat(64) },
                    },
                  }
                },
                async stop(body, context) {
                  const stopped = await workspace.sandbox.stop(body, context)
                  if (!stopped.ok || mode !== 'cleanup') return stopped
                  return { ok: true, value: { ...stopped.value, effectStatus: 'unknown' } }
                },
              },
            }
          },
        })
        expect(result).toMatchObject({
          ok: false,
          error: {
            detailCode:
              mode === 'mechanism'
                ? 'build_mechanism_unqualified'
                : mode === 'proof'
                  ? 'build_sandbox_proof'
                  : 'build_cleanup_unknown',
          },
        })
        cleanup(f)
      },
    )

    it('rejects a directory changed after inspection before executing its script', async () => {
      const f = await inputFor({ kind, rootSource: true })
      const open = f.input.openWorkspace
      if (await refusesUnqualified(f)) return
      const result = await buildLockedPackage({
        ...f.input,
        async openWorkspace(attempt, signal) {
          const workspace = await open(attempt, signal)
          if (!f.sourceRoot) throw new Error('Missing source directory')
          writeFileSync(join(f.sourceRoot, 'src/runtime.txt'), 'changed source')
          return workspace
        },
      })
      expect(result).toMatchObject({ ok: false, error: { detailCode: 'file_digest_mismatch' } })
      cleanup(f)
    })

    it('checks transport integrity separately from canonical reproducibility', async () => {
      const f = await inputFor({ kind, program: packageBuildProgram('transport-metadata') })
      if (await refusesUnqualified(f)) return
      const result = await buildLockedPackage(f.input)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.error.detailCode)
      const [a, b] = result.value.reproducibility.attempts
      expect(a.packageDigest).toBe(b.packageDigest)
      expect(a.manifestDigest).toBe(b.manifestDigest)
      expect(a.archiveIntegrity).not.toBe(b.archiveIntegrity)
      expect(a.archiveIntegrity).toBe('sha256-' + sha256Hex(result.value.archive))
      cleanup(f)
    })

    it('rejects rebuilt npm bytes that violate the locked archive integrity', async () => {
      const f = await inputFor({
        kind,
        sourceKind: 'npm',
        program: packageBuildProgram('transport-metadata'),
      })
      if (await refusesUnqualified(f)) return
      expect(await buildLockedPackage(f.input)).toMatchObject({
        ok: false,
        error: { detailCode: 'archive_integrity_mismatch' },
      })
      cleanup(f)
    })

    it('requires current approval after sandbox creation', async () => {
      const f = await inputFor({ kind })
      let revoked = false
      const open = f.input.openWorkspace
      if (await refusesUnqualified(f)) return
      const result = await buildLockedPackage({
        ...f.input,
        authorize: async () => !revoked,
        openWorkspace: async (attempt, signal) => {
          const w = await open(attempt, signal)
          return {
            ...w,
            sandbox: {
              ...w.sandbox,
              async create(body, context) {
                const created = await w.sandbox.create(body, context)
                revoked = true
                return created
              },
            },
          }
        },
      })
      expect(result).toMatchObject({ ok: false, error: { detailCode: 'build_unapproved' } })
      cleanup(f)
    })

    it('refuses changed resource authorization and narrower filesystem grants', async () => {
      for (const mode of ['approval', 'filesystem']) {
        const f = await inputFor({
          kind,
          ...(mode === 'filesystem' ? { declaration: { writePaths: ['./dist'] } } : {}),
        })
        const changedLimits = { ...limits, wallMs: 4000 }
        const changedInput: PackageBuildInput = {
          ...f.input,
          limits: changedLimits,
          async openWorkspace(attempt, signal) {
            const workspace = await f.input.openWorkspace(attempt, signal)
            return {
              ...workspace,
              request: { ...workspace.request, resourceLimits: changedLimits },
            }
          },
        }
        if (await refusesUnqualified(f, mode === 'approval' ? changedInput : f.input)) continue
        expect(await buildLockedPackage(mode === 'approval' ? changedInput : f.input)).toMatchObject({
          ok: false,
          error: { detailCode: mode === 'approval' ? 'build_unapproved' : 'build_filesystem_unqualified' },
        })
        cleanup(f)
      }
    })
  },
)
