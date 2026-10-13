import type {
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  PackageOperation,
  PackagePreview,
} from '@agnes/protocol'
import type { PluginAdminApi } from '../admin/plugins/api.js'

/** The four things one-click start does, in order. A step already satisfied is skipped, never redone. */
export const START_STEPS = ['install', 'trust', 'enable', 'session'] as const
export type StartStep = (typeof START_STEPS)[number]
export type StartStepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed'
export type StartProgress = Readonly<Record<StartStep, StartStepState>>

export type StartApi = Pick<
  PluginAdminApi,
  'list' | 'inspect' | 'install' | 'trust' | 'enable' | 'enableChecked' | 'operation' | 'loops' | 'runtime'
>

/** Why a step stopped: a stable code the dialog words, plus what the daemon said when it said anything. */
export type StartFailure = {
  step: StartStep
  code:
    | 'blocked'
    | 'operation'
    | 'timeout'
    | 'trust-unknown'
    | 'changed'
    | 'not-running'
    | 'restart-required'
    | 'loop-missing'
    | 'request'
  /** A daemon-authored, already safe message. */
  detail?: string | undefined
  hint?: string | undefined
}
export class StartError extends Error {
  readonly failure: StartFailure
  constructor(failure: StartFailure) {
    super(failure.detail ?? failure.code)
    this.name = 'StartError'
    this.failure = failure
  }
}

/** What the confirmation shows and the run needs: the package as inspected or as installed. */
export type StartPlan = {
  entry: PackageCatalogDescriptor
  installed: PackageInstalledDescriptor | undefined
  /** Present only when the package still has to be installed. */
  preview: PackagePreview | undefined
  needed: Readonly<Record<StartStep, boolean>>
}
export type StartTarget = {
  loop: { id: string; version: string }
  /** Session-scope bundle ids of this package, as the runtime catalog names them. */
  bundles: string[]
}

export type StartOptions = {
  signal?: AbortSignal
  /** Feature flags of the admin context; `packages.runtime-identity.v1` selects the checked enable. */
  features?: readonly string[] | undefined
  pollMs?: number
  timeoutMs?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

const TERMINAL = new Set<PackageOperation['state']>(['completed', 'failed', 'cancelled', 'rolled-back'])
const RUNTIME_IDENTITY = 'packages.runtime-identity.v1'

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })

const detailOf = (error: unknown) => (error instanceof Error && error.message ? error.message : undefined)

/** Follows one package operation to its end; anything but `completed` is that step's failure. */
async function settle(
  api: StartApi,
  step: StartStep,
  submit: () => Promise<{ operationId: string }>,
  options: StartOptions,
): Promise<PackageOperation> {
  const sleep = options.sleep ?? pause
  const deadline = Date.now() + (options.timeoutMs ?? 120_000)
  let operationId: string
  try {
    operationId = (await submit()).operationId
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new StartError({ step, code: 'request', detail: detailOf(error) })
  }
  for (;;) {
    options.signal?.throwIfAborted()
    let operation: PackageOperation
    try {
      operation = await api.operation(operationId)
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new StartError({ step, code: 'request', detail: detailOf(error) })
    }
    if (operation.state === 'completed') return operation
    if (TERMINAL.has(operation.state))
      throw new StartError({
        step,
        code: operation.error?.blockers.length ? 'blocked' : 'operation',
        detail: operation.error?.safeMessage,
        hint: operation.error?.fixHint,
      })
    if (Date.now() >= deadline) throw new StartError({ step, code: 'timeout' })
    await sleep(options.pollMs ?? 400, options.signal)
  }
}

async function installedOf(api: StartApi, id: string, step: StartStep, signal?: AbortSignal) {
  try {
    return (await api.list()).packages.find((item) => item.id === id)
  } catch (error) {
    if (signal?.aborted) throw error
    throw new StartError({ step, code: 'request', detail: detailOf(error) })
  }
}

const neededFor = (installed: PackageInstalledDescriptor | undefined): StartPlan['needed'] => ({
  install: !installed,
  trust: !installed?.trusted,
  enable: installed?.desired !== 'enabled' || installed.actual !== 'running',
  session: true,
})

/**
 * Reads what one-click start would do before anything changes: the installed package, or the
 * inspection of a package that still has to be installed. Inspection writes nothing.
 */
export async function planBusinessAgentStart(
  api: StartApi,
  entry: PackageCatalogDescriptor,
  options: StartOptions = {},
): Promise<StartPlan> {
  const installed = await installedOf(api, entry.id, 'install', options.signal)
  if (installed) return { entry, installed, preview: undefined, needed: neededFor(installed) }
  const operation = await settle(api, 'install', () => api.inspect(entry.source), options)
  const preview = operation.preview
  if (!preview) throw new StartError({ step: 'install', code: 'operation' })
  return { entry, installed: undefined, preview, needed: neededFor(undefined) }
}

/** A plan may start only when inspection found nothing that forbids the install. */
export const planBlocked = (plan: StartPlan): boolean =>
  (plan.preview?.blockers.length ?? 0) > 0 || (plan.installed?.blockers.length ?? 0) > 0

/**
 * Install → trust → enable → find the loop to open a session with. Stops at the first step that
 * fails and leaves completed steps in place: the package stays as far along as it got.
 */
export async function runBusinessAgentStart(
  api: StartApi,
  plan: StartPlan,
  onProgress: (progress: StartProgress) => void,
  options: StartOptions = {},
): Promise<StartTarget> {
  const id = plan.entry.id
  const sleep = options.sleep ?? pause
  const progress: Record<StartStep, StartStepState> = {
    install: 'pending',
    trust: 'pending',
    enable: 'pending',
    session: 'pending',
  }
  const mark = (step: StartStep, state: StartStepState) => {
    progress[step] = state
    onProgress({ ...progress })
  }
  const run = async <T>(step: StartStep, work: () => Promise<T>): Promise<T> => {
    mark(step, 'running')
    try {
      const value = await work()
      mark(step, 'done')
      return value
    } catch (error) {
      if (!options.signal?.aborted) mark(step, 'failed')
      throw error
    }
  }

  // The state is read again here: the plan may be minutes old, or a retry after a partial run.
  let installed = await installedOf(api, id, 'install', options.signal)
  if (installed) mark('install', 'skipped')
  else {
    const preview = plan.preview
    installed = await run('install', async () => {
      if (!preview) throw new StartError({ step: 'install', code: 'changed' })
      if (preview.blockers.length) throw new StartError({ step: 'install', code: 'blocked' })
      await settle(api, 'install', () => api.install(preview.source, preview.integrity), options)
      const current = await installedOf(api, id, 'install', options.signal)
      if (!current) throw new StartError({ step: 'install', code: 'operation' })
      return current
    })
  }

  // Consent covers the version and capability scope the dialog showed, nothing later.
  const reviewed = plan.installed ?? plan.preview
  if (
    reviewed &&
    (reviewed.integrity !== installed.integrity ||
      (reviewed.capabilityHash !== undefined && reviewed.capabilityHash !== installed.capabilityHash))
  ) {
    mark(installed.trusted ? 'enable' : 'trust', 'failed')
    throw new StartError({ step: installed.trusted ? 'enable' : 'trust', code: 'changed' })
  }

  if (installed.trusted) mark('trust', 'skipped')
  else {
    const current = installed
    installed = await run('trust', async () => {
      const capabilityHash = current.capabilityHash
      if (!capabilityHash) throw new StartError({ step: 'trust', code: 'trust-unknown' })
      await settle(api, 'trust', () => api.trust(id, current.integrity, capabilityHash), options)
      const next = await installedOf(api, id, 'trust', options.signal)
      if (!next?.trusted) throw new StartError({ step: 'trust', code: 'operation' })
      return next
    })
  }

  if (installed.desired === 'enabled' && installed.actual === 'running') mark('enable', 'skipped')
  else {
    const current = installed
    await run('enable', async () => {
      if (current.desired !== 'enabled') {
        const active = !options.features?.includes(RUNTIME_IDENTITY)
          ? undefined
          : (current.actualIntegrity ?? (current.actual === 'not-running' ? null : undefined))
        await settle(
          api,
          'enable',
          () => (active === undefined ? api.enable(id) : api.enableChecked(id, current.integrity, active)),
          options,
        )
      }
      // Enabled is a wish; the session needs the plugin actually running.
      const deadline = Date.now() + (options.timeoutMs ?? 120_000)
      for (;;) {
        const next = await installedOf(api, id, 'enable', options.signal)
        if (next?.actual === 'running') return
        if (next?.actual === 'restart-required')
          throw new StartError({ step: 'enable', code: 'restart-required', hint: next.failureHint })
        if (!next || next.actual === 'failed' || next.actual === 'unavailable')
          throw new StartError({
            step: 'enable',
            code: 'not-running',
            detail: next?.failureHint ?? next?.actualReason,
          })
        if (Date.now() >= deadline) throw new StartError({ step: 'enable', code: 'timeout' })
        await sleep(options.pollMs ?? 400, options.signal)
      }
    })
  }

  return run('session', async () => {
    let loops: Awaited<ReturnType<StartApi['loops']>>['loops']
    try {
      loops = (await api.loops()).loops
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new StartError({ step: 'session', code: 'request', detail: detailOf(error) })
    }
    const loop = loops.find((item) => item.sourcePackage === id)
    if (!loop) throw new StartError({ step: 'session', code: 'loop-missing' })
    // The package's bundle carries its presets and tool policy into the session. A package that
    // ships one may take a moment to list it after enabling; a daemon that never lists it still
    // starts the loop, without that policy.
    const expected = plan.entry.kinds?.includes('bundle') === true
    let bundles: { id: string }[] = []
    for (let attempt = 0; attempt < (expected ? 8 : 1); attempt++) {
      if (attempt > 0) await sleep(options.pollMs ?? 400, options.signal)
      bundles = await api
        .runtime()
        .then((snapshot) => (snapshot.bundles ?? []).filter((bundle) => bundle.sourcePackage === id))
        .catch(() => [])
      if (bundles.length) break
    }
    return { loop: { id: loop.id, version: loop.version }, bundles: bundles.map((bundle) => bundle.id) }
  })
}
