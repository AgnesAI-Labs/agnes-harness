import type { ResourceCommandKind, TuiResourceController } from './tui-controller.js'

export type ResourceTuiResult = Readonly<{ text: string; presentation?: 'transcript' }>
export type ResourceTuiPort = Readonly<{
  profile: string
  resourceController?: TuiResourceController | undefined
  queueResourceConfirmation(kind: ResourceCommandKind, args: readonly string[]): void
  takeResourceConfirmation(kind: ResourceCommandKind): readonly string[] | undefined
  cancelResourceConfirmation(kind: ResourceCommandKind): boolean
}>

const unavailable = (): ResourceTuiResult => ({ text: 'resource control is not supported by this Daemon' })

function isMutating(kind: ResourceCommandKind, values: readonly string[]): boolean {
  // parse() takes each flag with one value, anywhere, and the action is the first other word:
  // `--expected-revision <rev> trust srv` is a trust, and must wait for confirm like any other.
  let at = 0
  while (values[at]?.startsWith('-')) at += 2
  const action = values[at] ?? ''
  if (kind === 'resources') return action === 'enable' || action === 'disable'
  if (kind === 'skills') return action === 'refresh' || action === 'trust'
  return ['add', 'update', 'remove', 'test', 'enable', 'disable', 'reconnect', 'trust'].includes(action)
}

async function execute(
  app: ResourceTuiPort,
  kind: ResourceCommandKind,
  input: readonly string[],
): Promise<ResourceTuiResult> {
  let values = input
  const controller = app.resourceController
  if (!controller) return unavailable()
  if (values[0] === 'cancel')
    return {
      text: app.cancelResourceConfirmation(kind)
        ? 'resource operation cancelled'
        : 'no pending resource operation',
    }
  if (isMutating(kind, values)) {
    app.queueResourceConfirmation(kind, values)
    const command = kind === 'skills' ? 'skill' : kind
    return {
      text: `Pending resource operation. Review the revision and trust details, then run /${command} confirm or /${command} cancel.`,
    }
  }
  if (values[0] === 'confirm') {
    const pending = app.takeResourceConfirmation(kind)
    if (!pending) return { text: 'no pending resource operation' }
    values = pending
  }
  const result = await controller.execute(kind, app.profile, values)
  if (result.unsupported) return unavailable()
  return {
    text: result.text,
    ...(result.text.includes('\n') ? { presentation: 'transcript' as const } : {}),
  }
}

/** Handles only resource slash commands; ordinary TUI command dispatch stays in the CLI package. */
export async function runResourceTuiSlash(
  app: ResourceTuiPort,
  command: string,
  args: readonly string[],
): Promise<ResourceTuiResult | undefined> {
  if (command === '/skills') {
    if (args.length) return { text: 'usage: /skills' }
    return execute(app, 'resources', ['list', '--kind', 'skill'])
  }
  if (command === '/skill') {
    if (args[0] === 'refresh') return execute(app, 'skills', ['refresh', ...args.slice(1)])
    if (args[0] === 'trust') return execute(app, 'skills', ['trust', ...args.slice(1)])
    if (args[0] === 'confirm' || args[0] === 'cancel') return execute(app, 'skills', args)
    return {
      text: 'usage: /skill refresh [--root-key <key>] | /skill trust <resourceId> <revision> [trusted|rejected]',
    }
  }
  if (command === '/mcp') return execute(app, 'mcp', args.length ? args : ['list'])
  return undefined
}

/** Keeps confirmation state in the resource-management adapter rather than TUI application state. */
export function createResourceConfirmationQueue(): Readonly<{
  queue(kind: ResourceCommandKind, args: readonly string[]): void
  take(kind: ResourceCommandKind): readonly string[] | undefined
  cancel(kind: ResourceCommandKind): boolean
}> {
  let pending: Readonly<{ kind: ResourceCommandKind; args: readonly string[] }> | undefined
  return {
    queue(kind, args) {
      pending = { kind, args: [...args] }
    },
    take(kind) {
      if (!pending || pending.kind !== kind) return undefined
      const args = pending.args
      pending = undefined
      return args
    },
    cancel(kind) {
      if (!pending || pending.kind !== kind) return false
      pending = undefined
      return true
    },
  }
}
