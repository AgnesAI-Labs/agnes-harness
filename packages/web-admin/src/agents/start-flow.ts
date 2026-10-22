import type {
  AgentPlan,
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
  | 'list'
  | 'inspect'
  | 'install'
  | 'trust'
  | 'enable'
  | 'enableChecked'
  | 'operation'
  | 'resolveAgent'
  | 'prepareAgent'
  | 'startAgent'
  | 'readAgent'
>

/** Why a step stopped: a stable code the dialog words, plus what the daemon said when it said anything. */
export const START_FAILURE_CODES = [
  'blocked',
  'operation',
  'timeout',
  'trust-unknown',
  'changed',
  'not-running',
  'restart-required',
  'loop-missing',
  'request',
] as const
export type StartFailureCode = (typeof START_FAILURE_CODES)[number]
export type StartFailure = {
  step: StartStep
  code: StartFailureCode
  /** A daemon-authored, already safe message. */
  detail?: string | undefined
  hint?: string | undefined
}
/** What the person reads: the daemon's own safe message when there is one, else the copy for the code. */
export const startFailureText = (failure: StartFailure, t: (key: `reason.${StartFailureCode}`) => string) =>
  `${failure.detail ?? t(`reason.${failure.code}`)}${failure.hint ? ` ${failure.hint}` : ''}`

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
  entry: Pick<PackageCatalogDescriptor, 'id' | 'source' | 'agents'>
  installed: PackageInstalledDescriptor | undefined
  /** Present only when the package still has to be installed. */
  preview: PackagePreview | undefined
  needed: Readonly<Record<StartStep, boolean>>
}
export type StartTarget = AgentPlan & { launchTicket: string }

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
    const aborted = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }, ms)
    signal?.addEventListener('abort', aborted, { once: true })
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
    options.signal?.throwIfAborted()
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
      options.signal?.throwIfAborted()
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
    signal?.throwIfAborted()
    const result = await api.list()
    signal?.throwIfAborted()
    return result.packages.find((item) => item.id === id)
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
  entry: StartPlan['entry'],
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
 * Install → trust → enable the reviewed package. Stops at the first step that
 * fails and leaves completed steps in place: the package stays as far along as it got.
 */
export async function runBusinessPackageInstall(
  api: StartApi,
  plan: StartPlan,
  onProgress: (progress: StartProgress) => void,
  options: StartOptions = {},
): Promise<void> {
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
  const assertReviewed = (step: StartStep, current: PackageInstalledDescriptor | undefined) => {
    if (
      !reviewed ||
      !current ||
      reviewed.id !== current.id ||
      reviewed.version !== current.version ||
      reviewed.integrity !== current.integrity ||
      reviewed.capabilityHash !== current.capabilityHash
    ) {
      mark(step, 'failed')
      throw new StartError({ step, code: 'changed' })
    }
  }
  assertReviewed(installed.trusted ? 'enable' : 'trust', installed)

  if (installed.trusted) mark('trust', 'skipped')
  else {
    const current = installed
    installed = await run('trust', async () => {
      const capabilityHash = current.capabilityHash
      if (!capabilityHash) throw new StartError({ step: 'trust', code: 'trust-unknown' })
      await settle(api, 'trust', () => api.trust(id, current.integrity, capabilityHash), options)
      const next = await installedOf(api, id, 'trust', options.signal)
      assertReviewed('trust', next)
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
      // Executable packages need running rows; declarative packages use backend launch admission.
      const deadline = Date.now() + (options.timeoutMs ?? 120_000)
      for (;;) {
        const next = await installedOf(api, id, 'enable', options.signal)
        assertReviewed('enable', next)
        if (next?.actual === 'running') return
        if (
          next?.trusted &&
          next.desired === 'enabled' &&
          next.actual !== 'failed' &&
          next.actual !== 'restart-required' &&
          !next.contributions.some((row) => row.kind === 'extension' || row.kind === 'surface')
        ) {
          const declared = plan.entry.agents?.length === 1 ? plan.entry.agents[0] : undefined
          if (!declared) throw new StartError({ step: 'enable', code: 'blocked' })
          try {
            await api.resolveAgent(declared.ref)
            return
          } catch (error) {
            throw new StartError({ step: 'enable', code: 'not-running', detail: detailOf(error) })
          }
        }
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
}

/** Install admission is shared with application adoption; neither path starts a session implicitly. */
export async function runBusinessAgentStart(
  api: StartApi,
  plan: StartPlan,
  onProgress: (progress: StartProgress) => void,
  options: StartOptions = {},
): Promise<StartTarget> {
  let progress: StartProgress = {
    install: 'pending',
    trust: 'pending',
    enable: 'pending',
    session: 'pending',
  }
  await runBusinessPackageInstall(
    api,
    plan,
    (next) => {
      progress = next
      onProgress(next)
    },
    options,
  )
  onProgress({ ...progress, session: 'running' })
  try {
    const current = await installedOf(api, plan.entry.id, 'session', options.signal)
    const reviewed = plan.installed ?? plan.preview
    if (
      !current ||
      !reviewed ||
      current.integrity !== reviewed.integrity ||
      current.capabilityHash !== reviewed.capabilityHash
    )
      throw new StartError({ step: 'session', code: 'changed' })
    const declared = plan.entry.agents?.length === 1 ? plan.entry.agents[0] : undefined
    if (!declared) throw new StartError({ step: 'session', code: 'blocked' })
    const prepared = await api.prepareAgent(declared.ref)
    if (prepared.presentation.ref !== declared.ref) throw new Error('agent selection changed')
    options.signal?.throwIfAborted()
    onProgress({ ...progress, session: 'done' })
    return { ...prepared.presentation, launchTicket: prepared.launchTicket }
  } catch (error) {
    onProgress({ ...progress, session: 'failed' })
    if (error instanceof StartError || options.signal?.aborted) throw error
    throw new StartError({ step: 'session', code: 'request', detail: detailOf(error) })
  }
}
