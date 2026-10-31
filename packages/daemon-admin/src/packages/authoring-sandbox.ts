import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { detectBackend } from '@agnes/base/sandbox'
import {
  agnesHome,
  compileWorkspacePolicy,
  createExec,
  createFs,
  createPlatform,
  createSandboxSeam,
  prepareSandboxWorkspaceAncestor,
  sandboxReadPaths,
} from '@agnes/host'
import { runIsolatedCommand } from '@agnes/package-isolation'

/** Supplied only by Host/daemon composition, never by tool arguments or RPC parameters. */
export type AuthoringSandboxContext = {
  home: string
  admission?: import('@agnes/protocol').PermissionEffectAdmission
  session?: NonNullable<ReturnType<NonNullable<import('@agnes/host').HostSession['commandSandboxPolicy']>>>
}

/** Use the same Host policy compiler, OS probe and sandbox seam as session commands. */
export async function authoringSandbox(
  context: AuthoringSandboxContext,
  directory: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  if (context.session?.local === false) throw new Error('Local candidate tests require a local sandbox')
  const platform = createPlatform()
  const root = realpathSync(directory)
  if (platform.os === 'linux') await prepareSandboxWorkspaceAncestor(root)
  const fs = createFs(() => ({
    policy: { workspaceRoot: root, rules: [], networkAllow: [], digest: '0'.repeat(64) },
    caseSensitive: platform.fs().caseSensitive,
  }))
  const source = context.session
  const denied = source?.policy.rules.filter((rule) => rule.effect === 'deny').map((rule) => rule.path) ?? []
  const plan = await compileWorkspacePolicy({
    canonicalRoot: root,
    // No data-tmp or extra write grant: the disposable candidate is the sole write domain.
    dataDir: root,
    homeDir: homedir(),
    protectedPaths: [context.home, ...denied],
    semantics: {
      flavor: platform.os === 'win32' ? 'win32' : 'posix',
      caseSensitive: platform.fs().caseSensitive,
    },
    staticConfig: {
      level: 'L1',
      access: 'workspace-write',
      required: false,
      onUnavailable: 'deny',
      extraPaths: [],
      denyPaths: [],
      networkAllow: source?.policy.networkAllow ?? [],
    },
    canonicalize: (path, options) => fs.canonicalize(path, options),
  })
  const exec = createExec({ baseEnv: { PATH: process.env.PATH ?? '' } })
  // Same read view as session commands: on Linux, `--ro-bind / /` cannot host a mount point for a
  // protected path that does not exist yet (such as a missing ~/.ssh), so bwrap would refuse the
  // probe. Recomputed per use, so a private tree created later is still masked.
  const options = (cwd: string) => ({
    ...plan.backendOptions,
    cwd,
    network: source?.network ?? 'deny',
    ...(platform.os === 'linux' ? { readPaths: sandboxReadPaths(plan.backendOptions.denyPaths) } : {}),
  })
  const backend = await detectBackend({
    level: 'L1',
    platform: platform.os,
    shell: platform.shell(),
    options: options(plan.backendOptions.cwd),
    probeExec: exec.run,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    signal,
  })
  signal.throwIfAborted()
  const isolated = backend.name !== 'none'
  // Only Windows has an approved unisolated fallback. POSIX probe failure is a refusal.
  if (!isolated && platform.os !== 'win32')
    throw new Error('SANDBOX_UNAVAILABLE: candidate tests require OS isolation')
  const sandbox = await createSandboxSeam().forWorkspace({
    root,
    policy: plan.policy,
    shell: platform.shell(),
    signal,
    execBackend: isolated ? 'l1' : 'none',
    enforcement: backend.enforcement,
    readiness: {
      ready: async () => ({
        confine: ({ argv, cwd }) => (isolated ? backend.confine(argv, options(cwd)) : [...argv]),
      }),
    },
    binding: () => ({ policyDigest: plan.policy.digest }),
    exec: async (argv, options) => {
      const [command, ...args] = argv
      if (!command) throw new Error('Missing candidate test executable')
      await context.admission?.verify()
      context.admission?.assertActive()
      signal.throwIfAborted()
      const result = await runIsolatedCommand(command, args, {
        cwd: options.cwd,
        env: options.env ?? {},
        signal,
        timeoutMs: options.timeoutMs ?? 60_000,
        maxOutputBytes: options.maxOutputBytes ?? 16384,
      })
      return { ...result, code: 0, stderr: '', truncated: false, timedOut: false }
    },
  })
  return { sandbox, isolated, scope: 'candidate-directory', network: source?.network ?? 'deny' } as const
}

export const defaultAuthoringSandboxContext = (): AuthoringSandboxContext => ({
  home: agnesHome(process.env),
})
