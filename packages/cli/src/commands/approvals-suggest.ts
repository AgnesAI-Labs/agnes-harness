import { escapeControl } from '@agnes/cli-tui'
import { maskSecrets, offerPrefix } from '@agnes/core-common/command-table/prefix'
import type { EventEnvelope } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'
import { ExitCode, UsageError } from '../errors.js'
import type { ParsedArgs } from '../types.js'
import { readLedger } from './export.js'

type IO = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }

export type Suggestion = { prefix: string[]; count: number; example?: string; runsProjectCode?: boolean }
export type SuggestOptions = { days: number; minCount: number; limit: number }
const ALLOWING = new Set(['allowed-once', 'allowed-session', 'allowed-permanent', 'allow_prefix_session'])
const MAX_SESSIONS = 1000
const READERS = 4

/**
 * The shell commands a person allowed, out of one session's ledger. An answer that came from full
 * access (a system actor, code `full-access`) is the machine's, not a person's, and never counts.
 */
/** The few fields of a `decision/state` row this reader looks at; anything else is ignored. */
type RecordedDecision = {
  handle?: { id?: string }
  request?: {
    spec?: { purpose?: string; subject?: { call?: { name?: string; args?: { command?: unknown } } } }
  }
  result?: { reason?: string; code?: string; answeredBy?: { role?: string }; response?: { option?: string } }
}

export function approvedShellCommands(events: readonly EventEnvelope[]): string[] {
  const latest = new Map<string, RecordedDecision>()
  for (const event of events)
    if (event.type === 'decision/state') {
      const state = event.data as RecordedDecision | null
      if (typeof state?.handle?.id === 'string') latest.set(state.handle.id, state)
    }
  const commands: string[] = []
  for (const state of latest.values()) {
    const spec = state.request?.spec
    const result = state.result
    const call = spec?.subject?.call
    if (spec?.purpose !== 'tool.permission' || call?.name !== 'shell') continue
    if (result?.reason !== 'answered' || result.code === 'full-access') continue
    if (
      ['system', 'agent'].includes(result.answeredBy?.role ?? '') ||
      !ALLOWING.has(result.response?.option ?? '')
    )
      continue
    if (typeof call.args?.command === 'string') commands.push(call.args.command)
  }
  return commands
}

const covers = (prefix: readonly string[], granted: readonly string[]): boolean =>
  granted.length <= prefix.length && granted.every((token, i) => prefix[i] === token)

/**
 * Group commands by the prefix the daemon would offer for them (the same function), most frequent
 * first. A command with no offerable prefix, or whose prefix an existing grant already covers, is
 * left out. An example is kept only when it carries nothing that looks like a credential.
 */
export function suggestPrefixes(
  commands: readonly string[],
  opts: Pick<SuggestOptions, 'minCount' | 'limit'>,
  existing: readonly (readonly string[])[] = [],
): Suggestion[] {
  const groups = new Map<
    string,
    { prefix: string[]; count: number; example?: string; masked: boolean; runsProjectCode?: boolean }
  >()
  for (const command of commands) {
    const offer = offerPrefix(command)
    if (!offer || existing.some((granted) => covers(offer.tokens, granted))) continue
    const group = groups.get(offer.scope) ?? {
      prefix: offer.tokens,
      count: 0,
      masked: false,
      ...(offer.runsProjectCode ? { runsProjectCode: true } : {}),
    }
    group.count++
    if (maskSecrets(command).masked) group.masked = true
    else group.example ??= command
    groups.set(offer.scope, group)
  }
  return [...groups.values()]
    .filter((group) => group.count >= opts.minCount)
    .sort((a, b) => b.count - a.count || a.prefix.join(' ').localeCompare(b.prefix.join(' ')))
    .slice(0, opts.limit)
    .map(({ prefix, count, example, masked, runsProjectCode }) => ({
      prefix,
      count,
      ...(runsProjectCode ? { runsProjectCode: true } : {}),
      ...(example && !masked ? { example } : {}),
    }))
}

function positiveInt(name: string, raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max)
    throw new UsageError(`${name} must be an integer from 1 to ${max}`)
  return Number(raw)
}

export type SuggestReport = {
  suggestions: Suggestion[]
  scannedSessions: number
  skippedSessions: number
  approvals: number
  grantsCompared: boolean
  days: number
  minCount: number
}

/** The pure part of `agh approvals suggest`: ledgers in, report out. Nothing is written anywhere. */
export async function buildSuggestReport(
  sessions: readonly string[],
  read: (sessionId: string) => Promise<readonly EventEnvelope[]>,
  existing: (sessionId: string) => Promise<readonly (readonly string[])[] | undefined>,
  opts: SuggestOptions,
): Promise<SuggestReport> {
  const commands: string[] = []
  let skipped = 0
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(READERS, sessions.length) }, async () => {
      for (let i = next++; i < sessions.length; i = next++) {
        try {
          commands.push(...approvedShellCommands(await read(sessions[i] as string)))
        } catch {
          skipped++
        }
      }
    }),
  )
  // Existing grants are only readable on an admin connection; without one nothing is compared.
  const granted: (readonly string[])[] = []
  let compared = true
  for (const id of sessions) {
    const found = await existing(id)
    if (found === undefined) {
      compared = false
      break
    }
    granted.push(...found)
  }
  return {
    suggestions: suggestPrefixes(commands, opts, granted),
    scannedSessions: sessions.length - skipped,
    skippedSessions: skipped,
    approvals: commands.length,
    grantsCompared: compared,
    days: opts.days,
    minCount: opts.minCount,
  }
}

/** The text form of a report; every line is made inert, since commands come from past sessions. */
export function formatReport(report: SuggestReport): string {
  const lines = [
    `${report.approvals} approved shell command${report.approvals === 1 ? '' : 's'} in ${report.scannedSessions} session${report.scannedSessions === 1 ? '' : 's'} over the last ${report.days} days`,
    ...(report.skippedSessions
      ? [`${report.skippedSessions} session(s) could not be read and were skipped`]
      : []),
    ...(report.suggestions.length
      ? report.suggestions.map(
          (s) =>
            `${String(s.count).padStart(5)}  ${s.prefix.join(' ')}${s.example ? `   (e.g. ${s.example})` : ''}${s.runsProjectCode ? '   (runs project scripts, hooks or build code)' : ''}`,
        )
      : [`no prefix was approved at least ${report.minCount} times`]),
    ...(report.grantsCompared ? [] : ['not compared with existing grants (no admin connection)']),
    'To adopt one, choose "Allow commands starting with ..." on the approval card.',
  ]
  return `${lines.map(escapeControl).join('\n')}\n`
}

async function listSessionIds(client: NodeClient, days: number, now: number): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | undefined
  do {
    const page = await client.session.list({ limit: 200, ...(cursor ? { cursor } : {}) })
    for (const item of page.items) {
      const active = Date.parse(item.lastMessageAt ?? item.createdAt)
      if (!Number.isFinite(active) || now - active <= days * 86_400_000) ids.push(item.sessionId)
    }
    cursor = page.next
  } while (cursor && ids.length < MAX_SESSIONS)
  return ids.slice(0, MAX_SESSIONS)
}

/** Existing session grants as prefixes; undefined when this connection may not read them at all. */
async function existingPrefixes(client: NodeClient, sessionId: string) {
  try {
    const { grants } = await client.approval.sessionGrants(sessionId)
    return grants.flatMap((grant) => {
      const head = 'shell:prefix:'
      if (!grant.scope.startsWith(head)) return []
      try {
        const tokens: unknown = JSON.parse(grant.scope.slice(head.length))
        return Array.isArray(tokens) && tokens.every((token) => typeof token === 'string') ? [tokens] : []
      } catch {
        return []
      }
    })
  } catch (error) {
    // A session that is not open has no grants to compare; a refusal means no admin connection.
    return /CAPABILITY_DENIED|admin|not permitted|forbidden/i.test(String((error as Error)?.message ?? error))
      ? undefined
      : []
  }
}

/**
 * `agh approvals suggest`: propose command prefixes from the shell commands a person already
 * approved. Client tier only (session.list and each session's ledger); read-only, and it has no
 * apply step: a prefix is adopted on the approval card, by a person, at the moment it matters.
 */
export async function approvalsSuggest(p: ParsedArgs, client: NodeClient, io: IO): Promise<number> {
  if (p.positional.length > 1) throw new UsageError('approvals suggest takes no positional arguments')
  const opts: SuggestOptions = {
    days: positiveInt('--days', p.days, 90, 3650),
    minCount: positiveInt('--min-count', p.minCount, 2, 1000),
    limit: positiveInt('--limit', p.limit, 20, 200),
  }
  const sessions = await listSessionIds(client, opts.days, Date.now())
  const report = await buildSuggestReport(
    sessions,
    async (id) => (await readLedger(client, id)).events,
    (id) => existingPrefixes(client, id),
    opts,
  )
  if (p.json) {
    io.stdout.write(`${JSON.stringify(report)}\n`)
    return ExitCode.OK
  }
  io.stdout.write(formatReport(report))
  return ExitCode.OK
}
