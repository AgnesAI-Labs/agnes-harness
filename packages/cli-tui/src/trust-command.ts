import { createHash } from 'node:crypto'
import { AGH_DIR, type RuntimeAdminSnapshot } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'
import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { visibleLine, wrapText } from './component.js'
import { tt } from './locale-extended.js'
import type { TrustKey } from './locale-trust.js'
import { newPackageCommandId } from './package-admin.js'
import { oneLine } from './session-commands.js'

type Deployment = NonNullable<RuntimeAdminSnapshot['workspaceDeployments']>[number]
/** What the last `/trust` showed: `confirm` trusts exactly these, with the hash that was on screen. */
type Shown = {
  items: { deployDir: string; trustHash: string }[]
  trusted: boolean
  hooks: boolean
  plugins: boolean
}
const shown = new WeakMap<object, Shown>()
const MAX_HOOKS = 20
const WRAP = 76

const visible = visibleLine

/**
 * `event[matcher]: command` for each hook in `.agh/hooks.json`, or undefined when the file cannot be read in
 * full and parsed strictly: a truncated, binary or malformed file is never shown as if it were complete.
 */
async function hookLines(app: TuiApp): Promise<{ lines: string[]; digest: string } | undefined> {
  try {
    const file = await app.session.workspaceRead(`${AGH_DIR}/hooks.json`)
    if (file.binary || file.truncated || file.text === undefined) return undefined
    const root: unknown = JSON.parse(file.text)
    const events = (root as { hooks?: unknown } | null)?.hooks
    if (events === null || typeof events !== 'object' || Array.isArray(events)) return undefined
    const lines: string[] = []
    for (const [event, groups] of Object.entries(events)) {
      if (!Array.isArray(groups)) return undefined
      for (const group of groups as { matcher?: unknown; hooks?: unknown }[]) {
        if (!Array.isArray(group?.hooks)) return undefined
        const matcher = typeof group.matcher === 'string' ? `[${group.matcher}]` : ''
        for (const hook of group.hooks as { type?: unknown; command?: unknown; url?: unknown }[]) {
          // What runs is chosen by `type`, as in host-infrastructure's WorkspaceHookLoader: show that field only.
          const what = hook?.type === 'command' ? hook.command : hook?.type === 'http' ? hook.url : undefined
          if (typeof what !== 'string') return undefined
          lines.push(visible(`${event}${matcher} ${hook.type}: ${what.replace(/\r?\n/g, ' ⏎ ')}`))
        }
      }
    }
    // The digest of the exact bytes shown, to be compared with what the daemon's hash commits to.
    return {
      lines,
      digest: `sha256-${createHash('sha256').update(Buffer.from(file.text, 'utf8')).digest('hex')}`,
    }
  } catch {
    return undefined
  }
}

/** The runtime snapshot's row for exactly this deploy directory. */
async function rowFor(client: NodeClient, dir: string): Promise<Deployment | undefined> {
  const snapshot = await client.call<RuntimeAdminSnapshot>('_agnes/v1/sessionSelection.runtime', {})
  return snapshot.workspaceDeployments?.find((row) => row.deployDir === dir)
}

async function review(app: TuiApp): Promise<SlashResult> {
  const { locale, session } = app
  const t = (key: TrustKey, vars?: Record<string, string | number>) => tt(key, locale, vars)
  const client = app.o.controlClient
  if (!client) return { text: t('trust.unavailable') }
  shown.delete(session)
  // Only the daemon's canonical root for this session identifies the workspace; no guess from the local cwd.
  const here = await session.client.session.list({ limit: 500 }).then(
    (page) => page.items.find((item) => item.sessionId === session.id)?.cwd,
    () => undefined,
  )
  if (!here) return { text: t('trust.noRoot') }
  // A refusal (admin tier, remote permissions) is thrown to the caller and shown as it comes, as /grants does.
  const row = await rowFor(client, here)
  if (!row) return { text: t('trust.none') }
  const out = [
    `${t('trust.workspace')}: ${visible(row.path)}`,
    `${t('trust.state')}: ${t(`trust.state.${row.state}`)}`,
    `${t('trust.plugins')}: ${row.pluginCount ?? 0}`,
  ]
  // Anything that stops the screen from showing everything the hash covers withholds confirm.
  const why: string[] = []
  if ((row.pluginCount ?? 0) > 0) {
    try {
      const local = (await client.packages.list({ profile: app.profile })).packages.filter((item) =>
        item.source.ref.startsWith('local:workspace/'),
      )
      out.push(...local.map((item) => `  ${visible(`${item.id}@${item.version}`)}`))
      if (local.length !== row.pluginCount) why.push(t('trust.pluginsMismatch'))
    } catch {
      why.push(t('trust.pluginsFailed'))
    }
  }
  if (row.hasHooks) {
    const read = await hookLines(app)
    if (!read) why.push(t('trust.hooksUnreadable'))
    else {
      const { lines } = read
      if (!row.hooksDigest || row.hooksDigest !== read.digest) why.push(t('trust.changedDuring'))
      out.push(`${t('trust.hooks')}:`)
      for (const line of lines.slice(0, MAX_HOOKS))
        out.push(...wrapText(line, WRAP).map((part, i) => (i === 0 ? '  ' : '      ') + part))
      if (lines.length > MAX_HOOKS) {
        out.push(`  ${t('trust.hooksMore', { n: lines.length - MAX_HOOKS })}`)
        why.push(t('trust.hooksMore', { n: lines.length - MAX_HOOKS }))
      }
    }
  }
  if (row.state !== 'trusted') {
    if (!row.trustHash) why.push(t('trust.noHash'))
    // Single-quoted for the shell: the path is the daemon's, and a pasted command must not run more than it says.
    const quoted = `'${visible(row.deployDir).replaceAll("'", "'\\''")}'`
    if (why.length > 0) out.push(...why, t('trust.elsewhere', { dir: quoted }))
  }
  const ok = row.state !== 'trusted' && why.length === 0 && row.trustHash !== undefined
  shown.set(session, {
    items: ok ? [{ deployDir: row.deployDir, trustHash: row.trustHash as string }] : [],
    trusted: row.state === 'trusted',
    hooks: row.hasHooks === true,
    plugins: (row.pluginCount ?? 0) > 0,
  })
  if (ok) out.push(t('trust.hint'))
  return { text: out.join('\n'), presentation: 'transcript' }
}

async function confirm(app: TuiApp): Promise<SlashResult> {
  const { locale, session } = app
  const t = (key: TrustKey, vars?: Record<string, string | number>) => tt(key, locale, vars)
  const client = app.o.controlClient
  if (!client) return { text: t('trust.unavailable') }
  const last = shown.get(session)
  if (!last) return { text: t('trust.noPending') }
  if (last.items.length === 0) return { text: t(last.trusted ? 'trust.alreadyTrusted' : 'trust.noPending') }
  try {
    for (const item of last.items) {
      // The hash from the screen, not a fresh one: the daemon refuses if the files are no longer what was shown.
      await client.packages.trustWorkspace({
        profile: app.profile,
        clientId: await client.clientId(),
        commandId: newPackageCommandId('tui-trust'),
        deployDir: item.deployDir,
        expectedHash: item.trustHash,
      })
    }
  } catch (error) {
    const data = (error as { data?: { code?: unknown; reason?: unknown } } | null)?.data
    if (data?.code === 'SEMANTIC_REJECTED' && data.reason === 'E_PACKAGE_PREVIEW_STALE') {
      shown.delete(session)
      return { text: t('trust.stale') }
    }
    throw error
  }
  shown.delete(session)
  return {
    text: [
      t('trust.done', { path: last.items.map((item) => oneLine(item.deployDir)).join(', ') }),
      ...(last.hooks ? [t('trust.doneHooks')] : []),
      ...(last.plugins ? [t('trust.donePlugins')] : []),
    ].join('\n'),
    presentation: 'transcript',
  }
}

/** `/trust`: what the workspace's hooks and local plugins are and whether they are trusted; `/trust confirm` trusts that. */
export function trustSlash(app: TuiApp, args: readonly string[]): Promise<SlashResult> {
  if (args.length === 0) return review(app)
  if (args.length === 1 && args[0] === 'confirm') return confirm(app)
  return Promise.resolve({ text: tt('trust.usage', app.locale) })
}
