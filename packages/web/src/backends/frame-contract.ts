export const BACKEND_FRAME_MESSAGE = 'agh.backend.frame/v1'
export const BACKEND_FRAME_COMMAND = 'agh.backend.command/v1'
export type BackendId = 'local' | 'cloud'
export type BackendSessionRow = {
  sessionId: string
  title: string
  cwd?: string
  createdAt?: string
  lastMessageAt?: string
  pinnedAt?: string
}
export const BACKEND_SESSION_ACTIONS = [
  'pin',
  'unpin',
  'rename',
  'fork',
  'archive',
  'runtime',
  'revealWorkspace',
] as const
export type BackendSessionAction = (typeof BACKEND_SESSION_ACTIONS)[number]
export type BackendSnapshot = {
  ready: boolean
  connected: boolean
  selected?: string
  page?: string
  rows: BackendSessionRow[]
  activity: { sessionId: string; state: 'running' | 'waiting' | 'idle'; waiting?: 'approval' | 'question' }[]
  more: boolean
  error?: string
}
export type BackendCommand =
  | { kind: 'session'; sessionId: string }
  | { kind: 'new' }
  | { kind: 'refresh' }
  | { kind: 'more' }
  | { kind: 'search' }
  | { kind: 'workspace' }
  | { kind: 'session-action'; action: BackendSessionAction; sessionId: string; title: string }
  | { kind: 'settings'; section: string }
  | { kind: 'home'; page: 'plugins' | 'agents' | 'automation' | 'mhs' }

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length <= max

export function backendCommand(value: unknown): BackendCommand | undefined {
  if (!record(value) || value.type !== BACKEND_FRAME_COMMAND) return
  if (value.kind === 'session' && text(value.sessionId, 512) && value.sessionId)
    return { kind: value.kind, sessionId: value.sessionId }
  if (
    value.kind === 'new' ||
    value.kind === 'refresh' ||
    value.kind === 'more' ||
    value.kind === 'search' ||
    value.kind === 'workspace'
  )
    return { kind: value.kind }
  if (
    value.kind === 'session-action' &&
    BACKEND_SESSION_ACTIONS.includes(value.action as BackendSessionAction) &&
    text(value.sessionId, 512) &&
    value.sessionId &&
    text(value.title)
  )
    return {
      kind: value.kind,
      action: value.action as BackendSessionAction,
      sessionId: value.sessionId,
      title: value.title,
    }
  if (value.kind === 'settings' && text(value.section, 128) && value.section)
    return { kind: value.kind, section: value.section }
  if (value.kind === 'home' && ['plugins', 'agents', 'automation', 'mhs'].includes(String(value.page)))
    return { kind: value.kind, page: value.page as Extract<BackendCommand, { kind: 'home' }>['page'] }
}

/** Messages are still bound to the exact frame Window and same-origin parent by the receiver. */
export function backendSnapshot(value: unknown): BackendSnapshot | undefined {
  if (
    !record(value) ||
    value.type !== BACKEND_FRAME_MESSAGE ||
    value.kind !== 'state' ||
    !record(value.snapshot)
  )
    return
  const s = value.snapshot
  if (
    typeof s.ready !== 'boolean' ||
    typeof s.connected !== 'boolean' ||
    typeof s.more !== 'boolean' ||
    (s.selected !== undefined && !text(s.selected, 512)) ||
    (s.page !== undefined && !text(s.page, 512)) ||
    (s.error !== undefined && !text(s.error)) ||
    !Array.isArray(s.rows) ||
    s.rows.length > 5000 ||
    !Array.isArray(s.activity) ||
    s.activity.length > 5000
  )
    return
  if (
    s.rows.some(
      (r) =>
        !record(r) ||
        !text(r.sessionId, 512) ||
        !r.sessionId ||
        !text(r.title) ||
        ['createdAt', 'lastMessageAt', 'pinnedAt'].some(
          (key) => r[key] !== undefined && !text(r[key], 128),
        ) ||
        (r.cwd !== undefined && !text(r.cwd)),
    )
  )
    return
  if (
    s.activity.some(
      (a) =>
        !record(a) ||
        !text(a.sessionId, 512) ||
        !['running', 'waiting', 'idle'].includes(String(a.state)) ||
        (a.waiting !== undefined && a.waiting !== 'approval' && a.waiting !== 'question'),
    )
  )
    return
  return s as BackendSnapshot
}
