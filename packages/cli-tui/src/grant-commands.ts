import type { SessionApprovalGrant } from '@agnes/protocol'
import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { tt } from './locale-extended.js'
import { oneLine } from './session-commands.js'

/** `shell:prefix:["git","push"]` reads as `prefix: git push`; any other scope is shown as it is. */
function scopeText(scope: string): string {
  const head = 'shell:prefix:'
  if (!scope.startsWith(head)) return oneLine(scope)
  try {
    const tokens: unknown = JSON.parse(scope.slice(head.length))
    if (Array.isArray(tokens) && tokens.every((token) => typeof token === 'string'))
      return `prefix: ${oneLine(tokens.join(' '))}`
  } catch {
    // Not a prefix scope after all: show the raw text.
  }
  return oneLine(scope)
}

/**
 * One inert line per grant: tool and scope text come from tools and plugins, never trusted. Tab-separated
 * for `agh approvals`; the TUI passes spaces because its renderer strips control characters, tabs included.
 */
export function grantLine(g: SessionApprovalGrant, sep = '\t'): string {
  return [
    oneLine(g.grantId),
    oneLine(g.toolId),
    g.lifetime,
    oneLine(g.createdAt),
    scopeText(g.scope),
    ...(g.revokedAt ? ['revoked'] : []),
  ].join(sep)
}

/** /grants lists what lets this session's tools run unasked; /grants revoke <n|grantId> withdraws one. */
export async function grantsSlash(app: TuiApp, line: string): Promise<SlashResult> {
  const locale = app.locale
  const s = app.session
  const [verb, key, ...extra] = line.trim().split(/\s+/).slice(1)
  // admin tier: a refusal from the daemon is thrown to the caller and shown as it comes.
  const { grants } = await s.client.approval.sessionGrants(s.id)
  if (verb === undefined) {
    return {
      text: grants.length
        ? grants.map((g, i) => `${i + 1}  ${grantLine(g, '  ')}`).join('\n')
        : tt('grants.none', locale),
    }
  }
  if (verb !== 'revoke' || key === undefined || extra.length > 0) return { text: tt('grants.usage', locale) }
  const target =
    grants.find((g) => g.grantId === key) ?? (/^\d+$/.test(key) ? grants[Number(key) - 1] : undefined)
  if (!target) return { text: tt('grants.unknown', locale, { key: oneLine(key) }) }
  const revoked = await s.client.approval.revokeSessionGrant(s.id, target.grantId)
  return { text: tt('grants.revoked', locale, { grant: grantLine(revoked, '  ') }) }
}
