import type { AgentPlan } from '@agnes/protocol'
/** Scheduled tasks as the automation page reads them; every field is checked before it is shown. */

export type ScheduleTarget =
  | { kind: 'session'; sessionKey: string; unattendedApproval?: 'notify' | 'refuse' }
  | {
      kind: 'new-session'
      cwd: string
      unattendedApproval?: 'notify' | 'refuse'
      loop?: { id: string; version: string }
      bundles?: string[]
      preset?: string
      model?: { route: string; model: string }
    }
export type RunOutcome = 'running' | 'waiting_approval' | 'needs_attention' | 'ran' | 'delivered' | 'failed'
export type ScheduleRun = {
  at: number
  outcome: RunOutcome
  needsAttention?: boolean
  sessionKey?: string
  endedAt?: number
  reason?: string
  detail?: string
}
export type ScheduleRow = {
  id: string
  title: string
  prompt: string
  selector: Record<string, unknown>
  target: ScheduleTarget
  origin?: string
  status: 'active' | 'paused' | 'archived' | 'ended'
  nextRunAt: number | null
  revision: number
  runs: ScheduleRun[]
}

const OUTCOMES = new Set<RunOutcome>([
  'running',
  'waiting_approval',
  'needs_attention',
  'ran',
  'delivered',
  'failed',
])
const STATUSES = new Set(['active', 'paused', 'archived', 'ended'])

function targetOf(value: unknown): ScheduleTarget | undefined {
  if (!value || typeof value !== 'object') return undefined
  const target = value as Record<string, unknown>
  if (
    target.unattendedApproval !== undefined &&
    target.unattendedApproval !== 'notify' &&
    target.unattendedApproval !== 'refuse'
  )
    return undefined
  if (target.kind === 'session' && typeof target.sessionKey === 'string')
    return {
      kind: 'session',
      sessionKey: target.sessionKey,
      ...(target.unattendedApproval ? { unattendedApproval: target.unattendedApproval } : {}),
    }
  if (target.kind === 'new-session' && typeof target.cwd === 'string') return target as ScheduleTarget
  return undefined
}

function runOf(value: unknown): ScheduleRun | undefined {
  if (!value || typeof value !== 'object') return undefined
  const run = value as ScheduleRun
  return typeof run.at === 'number' && OUTCOMES.has(run.outcome) ? run : undefined
}

function rowOf(value: unknown): ScheduleRow | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  const target = targetOf(row.target)
  if (
    typeof row.id !== 'string' ||
    typeof row.title !== 'string' ||
    typeof row.prompt !== 'string' ||
    !row.selector ||
    typeof row.selector !== 'object' ||
    !target ||
    !STATUSES.has(String(row.status))
  )
    return undefined
  return {
    ...(row as unknown as ScheduleRow),
    target,
    runs: Array.isArray(row.runs) ? row.runs.flatMap((run) => runOf(run) ?? []) : [],
  }
}

export function rowsOf(value: unknown): ScheduleRow[] {
  const schedules = (value as { schedules?: unknown } | undefined)?.schedules
  return Array.isArray(schedules) ? schedules.flatMap((row) => rowOf(row) ?? []) : []
}

/** What a list or session picker needs to name a session or a workspace. */
export type Workspace = { path: string; name: string; available: boolean }
export type SessionInfo = { id: string; title: string; cwd: string; createdAt: string; archived: boolean }

export function workspacesOf(value: unknown): Workspace[] {
  const items = (value as { items?: unknown } | undefined)?.items
  return Array.isArray(items)
    ? items.flatMap((item) => {
        const entry = item as Workspace
        return typeof entry?.path === 'string' && typeof entry.name === 'string'
          ? [{ path: entry.path, name: entry.name, available: entry.available !== false }]
          : []
      })
    : []
}

export function sessionsOf(value: unknown): SessionInfo[] {
  const items = (value as { items?: unknown } | undefined)?.items
  return Array.isArray(items)
    ? items.flatMap((item) => {
        const meta = item as { sessionId?: unknown; title?: unknown; cwd?: unknown; createdAt?: unknown }
        if (typeof meta?.sessionId !== 'string') return []
        return [
          {
            id: meta.sessionId,
            title: typeof meta.title === 'string' && meta.title ? meta.title : '',
            cwd: typeof meta.cwd === 'string' ? meta.cwd : '',
            createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : '',
            archived: (item as { archived?: unknown }).archived === true,
          },
        ]
      })
    : []
}

/** The last path segment: what a workspace is called when the list does not name it. */
export const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

/**
 * Execution modes and models a new-session task may name, read from the same admin catalog as a new
 * chat. Agent choices carry the exact selection returned by the backend resolver.
 */
export type ExecutionChoice = {
  key: string
  label: string
  loop: { id: string; version: string }
  bundles: string[]
  preset?: string
  model?: { route: string; model: string }
  businessAgent: boolean
}
export type ModelChoice = { key: string; label: string; route: string; model: string }
export type ScheduleChoices = {
  modes: ExecutionChoice[]
  presets: string[]
  models: ModelChoice[]
}

type LoopEntry = { id: string; version: string; label?: string; sourcePackage: string }
type AdapterEntry = {
  id: string
  label?: string
  sourcePackage?: string
  capabilities?: { payloadOnly?: boolean }
  models: readonly { id: string; label?: string; route?: string }[]
}

const isAgnes = (text: string) => /agnes/i.test(text)

/** A saved model account: only its routes are offered, named the way the person named the account. */
export type ScheduleAccount = {
  route: string
  label: string
  providerId?: string
  models?: readonly { id: string; name?: string }[]
}

export function scheduleChoices(input: {
  agents?: readonly AgentPlan[]
  loops?: readonly LoopEntry[]
  presets?: readonly string[]
  bundles?: readonly { id: string; sourcePackage?: string }[]
  adapters?: readonly AdapterEntry[]
  /** Without saved accounts no model is offered and a run uses the default model. */
  accounts?: readonly ScheduleAccount[]
}): ScheduleChoices {
  const modes = (input.loops ?? []).map((loop) => {
    return {
      key: `${loop.id}@${loop.version}`,
      label: loop.label || loop.id,
      loop: { id: loop.id, version: loop.version },
      bundles: [] as string[],
      businessAgent: false,
    }
  })
  const accounts = new Map((input.accounts ?? []).map((account) => [account.route, account]))
  const seen = new Set<string>()
  const models = (input.adapters ?? []).flatMap((adapter) =>
    // A payload-only adapter takes no messages: a scheduled session cannot run on its models.
    (adapter.capabilities?.payloadOnly === true ? [] : adapter.models).flatMap((model) => {
      const account = model.route ? accounts.get(model.route) : undefined
      const key = `${model.route}\u0000${model.id}`
      if (!model.route || !account || seen.has(key)) return []
      seen.add(key)
      const name = account.models?.find((entry) => entry.id === model.id)?.name || model.label || model.id
      return [
        {
          key,
          label: `${name} · ${account.label}`,
          route: model.route,
          model: model.id,
          agnes: isAgnes(account.providerId ?? '') || isAgnes(account.label),
        },
      ]
    }),
  )
  // Agnes AI comes first in every provider and model list.
  models.sort((a, b) => Number(b.agnes) - Number(a.agnes))
  return {
    modes: [
      ...modes,
      ...(input.agents ?? []).map((agent) => ({
        key: agent.ref,
        label: agent.launch.title.en,
        loop: agent.loop,
        bundles: agent.bundles,
        preset: agent.preset,
        model: agent.model,
        businessAgent: true,
      })),
    ].sort((a, b) => Number(a.businessAgent) - Number(b.businessAgent)),
    presets: [...(input.presets ?? [])],
    models: models.map(({ agnes: _agnes, ...model }) => model),
  }
}

/** Schedule-wide timing hints do not disappear when the visible task list is filtered. */
export type ScheduleActivity = { nextRunAt: number | null; hasOpenRuns: boolean }
export function activityOf(value: unknown): ScheduleActivity | undefined {
  const activity = (value as { activity?: ScheduleActivity } | undefined)?.activity
  return activity &&
    (activity.nextRunAt === null || Number.isFinite(activity.nextRunAt)) &&
    typeof activity.hasOpenRuns === 'boolean'
    ? activity
    : undefined
}
