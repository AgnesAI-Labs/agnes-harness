import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { CallContext } from '@agnes/extension-api/runtime'
import type { RuntimeWireTypes as W } from '@agnes/protocol/runtime'
import type { PackageBuildInput, PackageBuildWorkspace } from '../../../src/runtime/package-build.js'
import { inspectLockedPackage, type SourceBuildDeclaration } from '../../../src/runtime/package-inspect.js'

interface NativeFixture {
  directory: string
  roots: { workspace: string }
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
}
const nativeModule = (await import(
  new URL('../../../../host/test/runtime/sandbox-exec-fixture.ts', import.meta.url).href
)) as { fixture(kind: 'default' | 'reference'): Promise<NativeFixture> }
const pluginModule = (await import(
  new URL('../../../../../tools/acceptance/runtime/fixtures/broken-plugin.ts', import.meta.url).href
)) as {
  createBrokenPlugin(mode: 'approved-build', kind: 'local' | 'npm' | 'git'): FixturePackage
  packageBuildProgram(fault?: string): string
}
// Match the build contract's advertised mechanisms. Resource features may only be advertised
// by a backend that can enforce every mandatory limit; a sampling observer cannot qualify.
const qualifications = new Map<string, Promise<boolean>>()
export function buildQualified(kind: 'default' | 'reference'): Promise<boolean> {
  let result = qualifications.get(kind)
  if (!result) {
    result = (async () => {
      const f = await nativeModule.fixture(kind)
      try {
        return (
          ['create', 'stop', 'closed-network', 'live-mount', 'seatbelt'].every((name) =>
            f.sandbox.features.includes(name),
          ) &&
          [
            'run',
            'owner-pipe',
            'lifeline',
            'cooperative-ownership',
            'cpuMs',
            'wallMs',
            'memoryBytes',
            'outputBytes',
            'processes',
            'openFiles',
          ].every((name) => f.exec.features.includes(name))
        )
      } finally {
        await f.release()
        await f.close()
        rmSync(f.directory, { recursive: true, force: true })
      }
    })()
    qualifications.set(kind, result)
  }
  return result
}
export interface BuildObservation {
  directories: string[]
  starts: string[]
  stagedFiles: string[]
}
export async function installerApplyBuild(
  kind: 'default' | 'reference',
  sourceKind: 'local' | 'npm' | 'git' = 'local',
  fault?: 'secret' | 'failure',
  hook?: (phase: string, owner: { directory: string; sandboxRef?: W['SandboxRef'] }) => Promise<void>,
) {
  const observation: BuildObservation = { directories: [], starts: [], stagedFiles: [] }
  const pkg = pluginModule.createBrokenPlugin('approved-build', sourceKind)
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  const build: SourceBuildDeclaration = {
    script:
      fault === 'failure'
        ? 'exit 91'
        : `exec ${quote(process.execPath)} -e ${quote(pluginModule.packageBuildProgram())}`,
    network: [],
    readPaths: ['./'],
    writePaths: ['./'],
    ...(fault === 'secret' ? { secretEnv: ['FIXTURE_SECRET'] } : {}),
  }
  const source = { locator: pkg.locator, content: { archive: pkg.archive }, build }
  const checked = await inspectLockedPackage({
    lock: pkg.lock,
    acquire: async () => ({ ok: true, value: source }),
  })
  if (!checked.ok) throw new Error(checked.detailCode)
  const input: PackageBuildInput = {
    plan: checked.value.buildPlan,
    lock: pkg.lock,
    minimumOwnership: 'cooperative',
    limits: {
      cpuMs: 8000,
      wallMs: 5000,
      memoryBytes: 512 * 1024 * 1024,
      outputBytes: 65536,
      processes: 16,
      openFiles: 256,
    },
    acquire: async () => ({ ok: true, value: source }),
    async openWorkspace(attempt) {
      const f = await nativeModule.fixture(kind)
      observation.directories.push(f.directory)
      return {
        root: f.roots.workspace,
        request: { ...f.createInput, resourceLimits: input.limits },
        sandbox: {
          ...f.sandbox,
          async create(request, context) {
            observation.starts.push('sandbox')
            const outcome = await f.sandbox.create(request, context)
            if (outcome.ok)
              await hook?.(`build-created-${attempt}`, {
                directory: f.directory,
                sandboxRef: outcome.value.sandboxRef,
              })
            return outcome
          },
        },
        exec: {
          ...f.exec,
          async run(request, context) {
            observation.starts.push('exec')
            const outcome = await f.exec.run(request, context)
            if (outcome.ok) await hook?.(`build-executed-${attempt}`, { directory: f.directory })
            return outcome
          },
        },
        call(operation, signal) {
          return f.auth.call(operation === 'stop' ? {} : signal ? { signal } : {})
        },
        async dispose() {
          for (const name of ['source', 'source.archive', 'artifact.tar', 'build-pids'])
            if (existsSync(join(f.roots.workspace, name))) observation.stagedFiles.push(name)
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
  return { input, pkg, observation }
}
