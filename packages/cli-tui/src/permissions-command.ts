import type { TuiApp } from './app.js'
import { listSessionChoices, type SlashResult } from './commands.js'
import { grantLine } from './grant-commands.js'
import { tt } from './locale-extended.js'
import { oneLine } from './session-commands.js'

const NONE = '-'
const LEVELS = {
  'read-only': 'permissions.readOnly',
  'workspace-write': 'permissions.workspaceWrite',
  'full-access': 'permissions.fullAccess',
} as const
const isLevel = (name: string): name is keyof typeof LEVELS => Object.hasOwn(LEVELS, name)

/**
 * `/permissions`: what this session may do, read-only, on one screen. Each source is asked on its own and
 * a source that fails shows `-` (the grants section shows the daemon's refusal, as `/grants` does).
 * `revoke` goes through `/grants revoke`, so both withdraw a grant the same way.
 */
export async function permissionsSlash(
  app: TuiApp,
  args: readonly string[],
  grants: (line: string) => Promise<SlashResult>,
): Promise<SlashResult> {
  const { locale, session: s } = app
  const t = (key: Parameters<typeof tt>[0], vars?: Record<string, string>) => tt(key, locale, vars)
  if (args.length > 0) {
    return args[0] === 'revoke' && args.length === 2
      ? grants(['/grants', ...args].join(' '))
      : { text: t('permissions.usage') }
  }
  const [runtime, tools, choices, opening, list] = await Promise.allSettled([
    s.client.session.runtime(s.id),
    s.tools(),
    listSessionChoices(s),
    s.projectUIOpening({ surface: 'tui', maxNodes: 1 }),
    s.client.approval.sessionGrants(s.id),
  ])
  const rt = runtime.status === 'fulfilled' ? runtime.value : undefined
  const caps = tools.status === 'fulfilled' ? tools.value.capabilities : undefined
  const policy = rt?.policy
  const unloaded = rt && !policy ? t('permissions.unloaded') : undefined

  // Level: the effective permission when the session is loaded, else the preset name, as the Web panel does.
  const effective = policy?.permission ? policy.permission.policy || 'workspace-write' : undefined
  const preset = caps?.permissions.preset ?? rt?.preset?.name
  const levelName = effective ?? preset
  const level = levelName ? (isLevel(levelName) ? t(LEVELS[levelName]) : oneLine(levelName)) : NONE
  const yolo =
    opening.status === 'fulfilled' ? t(opening.value.timeline.yolo ? 'status.on' : 'status.off') : NONE
  const approval = unloaded ?? (rt ? oneLine(policy?.approvalMode ?? t('permissions.none')) : NONE)

  // Sandbox: the Web panel's "no OS isolation" condition, unchanged.
  const sandbox = policy?.sandbox
  const enforcement = sandbox?.enforcement
  const sandboxRows = unloaded
    ? [unloaded]
    : sandbox
      ? [
          oneLine(sandbox.provider) + (enforcement ? ` (${oneLine(enforcement.level)})` : ''),
          ...(sandbox.provider === 'local' &&
          enforcement &&
          enforcement.level !== 'full' &&
          !enforcement.scope.includes('process')
            ? [t('permissions.noIsolation')]
            : []),
        ]
      : [NONE]

  // Tools: what is switched off, and the allow list when one narrows the session to named tools.
  const toolRows: string[] = []
  if (tools.status !== 'fulfilled') toolRows.push(NONE)
  else {
    const all = caps?.tools ?? []
    const names = (ids: readonly string[]) => ids.map(oneLine).join(', ')
    const off = all.filter((tool) => !tool.enabled)
    const narrowed = off.some((tool) => tool.reasons[0]?.rule === 'session-allow')
    const denied = off.filter((tool) => tool.reasons[0]?.rule !== 'session-allow')
    if (denied.length)
      toolRows.push(t('permissions.disabled', { names: names(denied.map((tool) => tool.id)) }))
    if (narrowed)
      toolRows.push(
        t('permissions.allowOnly', {
          names: names(all.filter((tool) => tool.enabled).map((tool) => tool.id)),
        }),
      )
    if (toolRows.length === 0) toolRows.push(t('permissions.allAvailable'))
  }

  const mine = choices.status === 'fulfilled' ? choices.value.find((c) => c.sessionId === s.id) : undefined
  const dirRows = choices.status === 'fulfilled' ? (mine?.additionalDirectories?.map(oneLine) ?? []) : [NONE]

  const grantRows =
    list.status === 'fulfilled'
      ? list.value.grants.map((g, i) => `${i + 1}\t${grantLine(g)}`)
      : [list.reason instanceof Error && list.reason.message ? oneLine(list.reason.message) : NONE]

  const none = [t('permissions.none')]
  const section = (title: string, rows: readonly string[]) => [title, ...rows.map((row) => `  ${row}`)]
  return {
    text: [
      ...section(t('permissions.permissions'), [
        `${t('permissions.level')}: ${level}`,
        `${t('permissions.yolo')}: ${yolo}`,
        `${t('permissions.approvalMode')}: ${approval}`,
      ]),
      ...section(t('permissions.sandbox'), sandboxRows),
      ...section(t('permissions.tools'), toolRows),
      ...section(t('permissions.dirs'), dirRows.length ? dirRows : none),
      ...section(t('permissions.grants'), grantRows.length ? grantRows : none),
      t('permissions.footer'),
    ].join('\n'),
    presentation: 'transcript',
  }
}
