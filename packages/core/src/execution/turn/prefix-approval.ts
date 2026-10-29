import { parsePrefixScope } from '@agnes/core-common/command-table/prefix'
import { normalizeWorkspacePath } from '@agnes/core-common/workspace-path'
import type { ToolMeta } from '@agnes/extension-api'
import { sessionGrantKey } from '../../step/approval-grants.js'
import type { SessionImpl } from '../../step/session.js'

type PrefixCall = { name: string; definitionFingerprint: string }

/** The grant a prefix answer leaves behind: the session-allow key and the prefix scope it covers. */
export function prefixActivation(s: SessionImpl, call: PrefixCall, policyBinding: string, scope: string) {
  return {
    scope,
    key: sessionGrantKey({
      actor: s.d.actor,
      sessionKey: s.key,
      toolId: call.name,
      scope,
      definitionFingerprint: call.definitionFingerprint,
      policyBinding,
    }),
  }
}

/** The prefixes this session honours for the call as bound now: a changed policy ends them. */
export function honouredPrefixes(s: SessionImpl, call: PrefixCall, policyBinding: string): string[][] {
  return [...s.sessionPrefixScopes].flatMap((scope) => {
    const tokens = parsePrefixScope(scope)
    return tokens && s.sessionAllows.has(prefixActivation(s, call, policyBinding, scope).key) ? [tokens] : []
  })
}

/**
 * The shell command a prefix grant may speak for, or undefined when nothing may be offered or
 * honoured: never for a once-only gate, an `always` tool, tainted context or a principal rule that
 * wants approval, and only for a plain one-shot POSIX call (not background, persistent, an existing
 * shell session, another interpreter, or a working directory outside the workspace), because the
 * splitter reads POSIX syntax and a grant must not speak for what ran differently.
 * Hard blocks and deny rules were refused before this point.
 */
export function prefixCommand(o: {
  call: { name: string; args: unknown }
  meta: Pick<ToolMeta, 'commandArg'>
  scope: string
  onceOnly: boolean
  requiresApproval: string
  taint: boolean
  authorization: string
  posixShell: boolean
  workspaceRoot: string
}): string | undefined {
  const args = (o.call.args ?? {}) as Record<string, unknown>
  if (o.call.name !== 'shell' || typeof args.command !== 'string') return undefined
  if (args.background || args.persistent || args.sessionId) return undefined
  if (args.shell !== undefined && args.shell !== 'bash' && args.shell !== 'zsh') return undefined
  if (args.cwd !== undefined && !insideWorkspace(args.cwd, o.workspaceRoot)) return undefined
  return o.posixShell &&
    !o.onceOnly &&
    o.meta.commandArg === 'command' &&
    o.scope === 'tool:shell:execute' &&
    o.requiresApproval !== 'always' &&
    !o.taint &&
    o.authorization !== 'require_approval'
    ? args.command
    : undefined
}

function insideWorkspace(cwd: unknown, workspaceRoot: string): boolean {
  if (typeof cwd !== 'string' || cwd.includes('\0')) return false
  try {
    return normalizeWorkspacePath(cwd, workspaceRoot).inside
  } catch {
    return false
  }
}
