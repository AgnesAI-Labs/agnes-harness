import { rmSync } from 'node:fs'
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
export async function installerApplyBuild(
  kind: 'default' | 'reference',
  sourceKind: 'local' | 'npm' | 'git' = 'local',
  fault?: 'secret' | 'failure',
  hook?: (phase: string, owner: { directory: string; sandboxRef?: W['SandboxRef'] }) => Promise<void>,
) {
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
      return {
        root: f.roots.workspace,
        request: { ...f.createInput, resourceLimits: input.limits },
        sandbox: {
          ...f.sandbox,
          async create(request, context) {
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
            const outcome = await f.exec.run(request, context)
            if (outcome.ok) await hook?.(`build-executed-${attempt}`, { directory: f.directory })
            return outcome
          },
        },
        call(operation, signal) {
          return f.auth.call(operation === 'stop' ? {} : signal ? { signal } : {})
        },
        async dispose() {
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
  return { input, pkg }
}
