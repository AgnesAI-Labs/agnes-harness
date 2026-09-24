import type { ComputerUseRescueAction, ComputerUseRescueReport } from '@agnes/host'
import type {
  ComputerUseDoctorParams,
  ComputerUseDoctorResult,
  ComputerUseOperationResult,
  ComputerUsePermissionsStatusResult,
  ComputerUseStatusResult,
} from '@agnes/protocol'
import type { ParsedArgs } from '../args.js'
import { UsageError } from '../errors.js'

type ComputerUseClient = Readonly<{
  call<T>(method: string, params: unknown): Promise<T>
}>

export type ComputerUseCommandResult<T> = Readonly<{
  text: string
  report: T
  exitCode: 0 | 1 | 2
}>

export function validateComputerUseRescueArgs(parsed: ParsedArgs): ComputerUseRescueAction {
  if (parsed.command !== 'computer-use' || parsed.positional[0] !== 'rescue')
    throw new UsageError('computer-use rescue command expected')
  const action = parsed.positional[1]
  if (!['status', 'install', 'repair'].includes(action ?? '') || parsed.positional.length !== 2)
    throw new UsageError('computer-use rescue requires exactly: status, install, or repair')
  const unsupported =
    parsed.rest.length > 0 ||
    parsed.print ||
    parsed.mode !== undefined ||
    parsed.help ||
    parsed.version ||
    parsed.preset !== undefined ||
    parsed.continue ||
    parsed.resume !== undefined ||
    parsed.connect !== undefined ||
    parsed.model !== undefined ||
    parsed.park ||
    parsed.meta ||
    parsed.ephemeral ||
    parsed.standalone !== undefined ||
    parsed.repair ||
    parsed.upgrade ||
    parsed.format !== undefined ||
    parsed.html ||
    parsed.raw ||
    parsed.out !== undefined ||
    parsed.from !== undefined ||
    parsed.key !== undefined ||
    parsed.resolved ||
    parsed.include !== undefined ||
    parsed.skip !== undefined
  if (unsupported)
    throw new UsageError('computer-use rescue accepts only --profile, --cwd, --data-dir, and --json')
  return action as ComputerUseRescueAction
}

function renderComputerUseRescue(report: ComputerUseRescueReport): string {
  return [
    `computer-use rescue: ${report.status}`,
    `action: ${report.action}`,
    `platform: ${report.platform}`,
    `generation: ${report.generation}`,
    ...(report.activeVersion ? [`active: ${report.activeVersion}`] : []),
    ...(report.lastKnownGoodVersion ? [`lkg: ${report.lastKnownGoodVersion}`] : []),
    ...(report.outcome ? [`outcome: ${report.outcome}`] : []),
  ].join('\n')
}

export async function computerUseRescueCommand(
  parsed: ParsedArgs,
  input: Readonly<{
    dataDir: string
    daemonRunning: boolean
    signal?: AbortSignal
    run(request: {
      action: ComputerUseRescueAction
      dataDir: string
      signal?: AbortSignal
    }): Promise<ComputerUseRescueReport>
  }>,
): Promise<ComputerUseCommandResult<ComputerUseRescueReport>> {
  const action = validateComputerUseRescueArgs(parsed)
  if (input.daemonRunning && action !== 'status')
    throw new Error('Computer Use rescue refused because this data directory has a live daemon')
  const report = await input.run({
    action,
    dataDir: input.dataDir,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  return {
    text: parsed.json ? JSON.stringify(report, null, 2) : renderComputerUseRescue(report),
    report,
    exitCode: 0,
  }
}

function validateReadOnlyComputerUseFlags(parsed: ParsedArgs, label: string): void {
  if (parsed.repair) throw new UsageError(`${label} is read-only; --repair is not supported`)
  const unsupported =
    parsed.rest.length > 0 ||
    parsed.print ||
    parsed.mode !== undefined ||
    parsed.help ||
    parsed.version ||
    parsed.profile !== undefined ||
    parsed.preset !== undefined ||
    parsed.cwd !== undefined ||
    parsed.continue ||
    parsed.resume !== undefined ||
    parsed.connect !== undefined ||
    parsed.model !== undefined ||
    parsed.park ||
    parsed.meta ||
    parsed.ephemeral ||
    parsed.standalone !== undefined ||
    parsed.format !== undefined ||
    parsed.html ||
    parsed.raw ||
    parsed.out !== undefined ||
    parsed.from !== undefined ||
    parsed.key !== undefined ||
    parsed.resolved ||
    parsed.upgrade ||
    parsed.include !== undefined ||
    parsed.skip !== undefined
  if (unsupported) throw new UsageError(`${label} accepts only --json`)
}

function validateCommonComputerUseFlags(parsed: ParsedArgs, label: string): void {
  if (parsed.repair) throw new UsageError(`${label} is read-only; --repair is not supported`)
  const unsupported =
    parsed.rest.length > 0 ||
    parsed.print ||
    parsed.mode !== undefined ||
    parsed.help ||
    parsed.version ||
    parsed.profile !== undefined ||
    parsed.preset !== undefined ||
    parsed.cwd !== undefined ||
    parsed.continue ||
    parsed.resume !== undefined ||
    parsed.connect !== undefined ||
    parsed.model !== undefined ||
    parsed.park ||
    parsed.meta ||
    parsed.ephemeral ||
    parsed.standalone !== undefined ||
    parsed.format !== undefined ||
    parsed.html ||
    parsed.raw ||
    parsed.out !== undefined ||
    parsed.from !== undefined ||
    parsed.key !== undefined ||
    parsed.resolved ||
    parsed.upgrade
  if (unsupported) throw new UsageError(`${label} accepts only --json, --include <check>, or --skip <check>`)
}

export function validateComputerUseStatusArgs(parsed: ParsedArgs): void {
  if (
    parsed.command !== 'computer-use' ||
    parsed.positional.length !== 1 ||
    parsed.positional[0] !== 'status'
  )
    throw new UsageError('agh computer-use requires exactly: status')
  validateReadOnlyComputerUseFlags(parsed, 'computer-use status')
}

export function validateComputerUsePermissionsStatusArgs(parsed: ParsedArgs): void {
  if (
    parsed.command !== 'computer-use' ||
    parsed.positional.length !== 2 ||
    parsed.positional[0] !== 'permissions' ||
    parsed.positional[1] !== 'status'
  )
    throw new UsageError('agh computer-use permissions requires exactly: status')
  validateReadOnlyComputerUseFlags(parsed, 'computer-use permissions status')
}

export function validateComputerUsePermissionsGrantArgs(parsed: ParsedArgs): void {
  if (
    parsed.command !== 'computer-use' ||
    parsed.positional.length !== 2 ||
    parsed.positional[0] !== 'permissions' ||
    parsed.positional[1] !== 'grant'
  )
    throw new UsageError('agh computer-use permissions grant accepts no additional arguments')
  validateReadOnlyComputerUseFlags(parsed, 'computer-use permissions grant')
}

export function isComputerUsePermissionsStatus(parsed: ParsedArgs): boolean {
  return parsed.positional[0] === 'permissions'
}

export function validateDoctorComputerUseArgs(parsed: ParsedArgs): void {
  if (
    parsed.command !== 'doctor' ||
    parsed.positional.length !== 1 ||
    parsed.positional[0] !== 'computer-use'
  )
    throw new UsageError('doctor computer-use accepts no additional arguments')
  validateCommonComputerUseFlags(parsed, 'doctor computer-use')
}

export type ComputerUseOperationAction =
  | Readonly<{ action: 'start'; kind: 'install' | 'update' | 'restart' }>
  | Readonly<{ action: 'status'; operationId?: string }>
  | Readonly<{ action: 'cancel'; operationId: string }>

export function validateComputerUseOperationArgs(parsed: ParsedArgs): ComputerUseOperationAction {
  if (parsed.command !== 'computer-use') throw new UsageError('computer-use operation command expected')
  const unsupported =
    parsed.rest.length > 0 ||
    parsed.print ||
    parsed.mode !== undefined ||
    parsed.help ||
    parsed.version ||
    parsed.profile !== undefined ||
    parsed.preset !== undefined ||
    parsed.cwd !== undefined ||
    parsed.continue ||
    parsed.resume !== undefined ||
    parsed.connect !== undefined ||
    parsed.model !== undefined ||
    parsed.park ||
    parsed.meta ||
    parsed.ephemeral ||
    parsed.standalone !== undefined ||
    parsed.repair ||
    parsed.format !== undefined ||
    parsed.html ||
    parsed.raw ||
    parsed.out !== undefined ||
    parsed.from !== undefined ||
    parsed.key !== undefined ||
    parsed.resolved ||
    parsed.include !== undefined ||
    parsed.skip !== undefined
  if (unsupported)
    throw new UsageError('computer-use driver operations accept only --json and install --upgrade')
  const [verb, id, extra] = parsed.positional
  if (extra !== undefined) throw new UsageError('computer-use driver operation has too many arguments')
  if (verb === 'install' && id === undefined)
    return { action: 'start', kind: parsed.upgrade ? 'update' : 'install' }
  if (parsed.upgrade) throw new UsageError('--upgrade is supported only by computer-use install')
  if (verb === 'restart' && id === undefined) return { action: 'start', kind: 'restart' }
  if (verb === 'operation') return { action: 'status', ...(id === undefined ? {} : { operationId: id }) }
  if (verb === 'cancel' && id !== undefined) return { action: 'cancel', operationId: id }
  throw new UsageError('computer-use requires install, restart, operation [id], or cancel <id>')
}

function renderComputerUseOperation(report: ComputerUseOperationResult): string {
  if (report.status === 'not-found') return 'computer-use operation: not-found'
  return [
    `computer-use operation: ${report.state}`,
    `id: ${report.operationId}`,
    `kind: ${report.kind}`,
    `phase: ${report.phase}`,
    ...('outcome' in report ? [`outcome: ${report.outcome}`] : []),
    ...('failure' in report ? [`failure: ${report.failure}`] : []),
  ].join('\n')
}

function operationExitCode(report: ComputerUseOperationResult): 0 | 1 | 2 {
  if (report.status === 'not-found') return 2
  if (report.state === 'failed' || report.state === 'cancelled') return 1
  return 0
}

export async function computerUseOperationCommand(
  parsed: ParsedArgs,
  client: ComputerUseClient,
  options: Readonly<{
    pollIntervalMs?: number
    maxPolls?: number
    wait?: (ms: number) => Promise<void>
  }> = {},
): Promise<ComputerUseCommandResult<ComputerUseOperationResult>> {
  const action = validateComputerUseOperationArgs(parsed)
  let report: ComputerUseOperationResult
  if (action.action === 'start') {
    report = await client.call<ComputerUseOperationResult>('_agnes/v1/computerUse.operation.start', {
      kind: action.kind,
    })
    const wait = options.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
    const maxPolls = options.maxPolls ?? 2_400
    const interval = options.pollIntervalMs ?? 250
    let polls = 0
    while (
      report.status === 'found' &&
      (report.state === 'queued' || report.state === 'running' || report.state === 'cancelling') &&
      polls < maxPolls
    ) {
      await wait(interval)
      report = await client.call<ComputerUseOperationResult>('_agnes/v1/computerUse.operation.status', {
        operationId: report.operationId,
      })
      polls += 1
    }
    if (
      report.status === 'found' &&
      (report.state === 'queued' || report.state === 'running' || report.state === 'cancelling')
    )
      return {
        text: parsed.json ? JSON.stringify(report, null, 2) : renderComputerUseOperation(report),
        report,
        exitCode: 2,
      }
  } else if (action.action === 'status') {
    report = await client.call<ComputerUseOperationResult>('_agnes/v1/computerUse.operation.status', {
      ...(action.operationId ? { operationId: action.operationId } : {}),
    })
  } else {
    report = await client.call<ComputerUseOperationResult>('_agnes/v1/computerUse.operation.cancel', {
      operationId: action.operationId,
    })
  }
  return {
    text: parsed.json ? JSON.stringify(report, null, 2) : renderComputerUseOperation(report),
    report,
    exitCode: operationExitCode(report),
  }
}

export async function computerUsePermissionsStatusCommand(
  parsed: ParsedArgs,
  client: ComputerUseClient,
): Promise<ComputerUseCommandResult<ComputerUsePermissionsStatusResult>> {
  validateComputerUsePermissionsStatusArgs(parsed)
  const report = await client.call<ComputerUsePermissionsStatusResult>(
    '_agnes/v1/computerUse.permissions.status',
    {},
  )
  return {
    text: parsed.json
      ? JSON.stringify(report, null, 2)
      : [
          `computer-use permissions: ${report.status}`,
          `admission: ${report.admission.state} (${report.admission.reason})`,
          `probe: ${report.probe.state} (${report.probe.reason})`,
        ].join('\n'),
    report,
    exitCode: report.status === 'not-required' || report.status === 'granted' ? 0 : 1,
  }
}

export async function computerUsePermissionsGrantCommand(
  parsed: ParsedArgs,
  client: ComputerUseClient,
): Promise<ComputerUseCommandResult<ComputerUsePermissionsStatusResult>> {
  validateComputerUsePermissionsGrantArgs(parsed)
  const report = await client.call<ComputerUsePermissionsStatusResult>(
    '_agnes/v1/computerUse.permissions.grant',
    {},
  )
  return {
    text: parsed.json
      ? JSON.stringify(report, null, 2)
      : [
          `computer-use permissions: ${report.status}`,
          `admission: ${report.admission.state} (${report.admission.reason})`,
          `probe: ${report.probe.state} (${report.probe.reason})`,
        ].join('\n'),
    report,
    exitCode: report.status === 'not-required' || report.status === 'granted' ? 0 : 1,
  }
}

export async function readComputerUseStatus(client: ComputerUseClient): Promise<ComputerUseStatusResult> {
  return client.call<ComputerUseStatusResult>('_agnes/v1/computerUse.status', {})
}

export function renderComputerUseStatus(report: ComputerUseStatusResult): string {
  const mutations = report.lockedPackageMutations
  return [
    `computer-use: ${report.status}`,
    `admission: ${report.admission.state} (${report.admission.reason})`,
    `runtime: ${report.runtime.state}; start attempted: ${String(report.runtime.startAttempted)}`,
    ...(report.status === 'ready'
      ? [
          `active sessions: ${report.runtime.activeSessions}`,
          `driver: ${report.driver.version} (${report.driver.publisher})`,
        ]
      : []),
    'blockers:',
    ...report.blockers.map((blocker) => `  - ${blocker}`),
    mutations
      ? `locked-package mutations: activation=${String(mutations.activationReady)} recovery=${String(mutations.recoveryReady)}`
      : 'locked-package mutations: unknown',
    ...(mutations ? mutations.blockers.map((blocker) => `  - ${blocker}`) : []),
  ].join('\n')
}

export async function computerUseStatusCommand(
  parsed: ParsedArgs,
  client: ComputerUseClient,
): Promise<ComputerUseCommandResult<ComputerUseStatusResult>> {
  validateComputerUseStatusArgs(parsed)
  const report = await readComputerUseStatus(client)
  return {
    text: parsed.json ? JSON.stringify(report, null, 2) : renderComputerUseStatus(report),
    report,
    exitCode: report.status === 'ready' ? 0 : 1,
  }
}

export async function doctorComputerUseCommand(
  parsed: ParsedArgs,
  client: ComputerUseClient,
): Promise<ComputerUseCommandResult<ComputerUseDoctorResult>> {
  validateDoctorComputerUseArgs(parsed)
  const params: ComputerUseDoctorParams = {
    ...(parsed.include === undefined ? {} : { include: parsed.include }),
    ...(parsed.skip === undefined ? {} : { skip: parsed.skip }),
  }
  const report = await client.call<ComputerUseDoctorResult>('_agnes/v1/computerUse.doctor', params)
  const mutations = report.lockedPackageMutations
  return {
    text: parsed.json
      ? JSON.stringify(report, null, 2)
      : [
          `computer-use doctor: ${report.status}`,
          `admission: ${report.admission.state} (${report.admission.reason})`,
          `checks: ${report.checks.state} (${report.checks.reason})`,
          mutations
            ? `locked-package mutations: activation=${String(mutations.activationReady)} recovery=${String(mutations.recoveryReady)}`
            : 'locked-package mutations: unknown',
          ...(mutations ? mutations.blockers.map((blocker) => `  - ${blocker}`) : []),
        ].join('\n'),
    report,
    exitCode: report.status === 'ready' ? 0 : report.status === 'unreachable' ? 2 : 1,
  }
}
