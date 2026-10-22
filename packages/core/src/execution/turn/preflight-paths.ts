import type { ToolMeta } from '@agnes/extension-api'
import type { SessionImpl } from '../../step/session.js'
import { preflightError } from './preflight-error.js'

/**
 * Checks every workspace path a tool declared (`ToolMeta.paths`) against the Host file boundary
 * before any policy runs. Returns the refusal to record, or undefined when every path is admitted.
 */
export async function preflightDeclaredPaths(
  s: SessionImpl,
  call: { toolUseId: string; args: unknown },
  turn: number,
  meta: Pick<ToolMeta, 'paths'>,
  signal: AbortSignal,
): Promise<{ code: string; message: string } | undefined> {
  for (const path of meta.paths ?? []) {
    const args = call.args as Record<string, unknown>
    const target = Object.hasOwn(args, path.arg) ? args[path.arg] : path.default
    if (target === undefined) continue
    if (typeof target !== 'string' || !target || target.includes('\0'))
      return { code: 'E_FS_DENIED', message: 'E_FS_DENIED: Invalid declared workspace path' }
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(target)?.[1]?.toLowerCase()
    if (scheme && path.nonWorkspaceSchemes?.includes(scheme)) continue
    try {
      if (!s.d.workspaceInvocation)
        throw Object.assign(new Error('Workspace path preflight unavailable'), {
          code: 'E_FS_PREFLIGHT_UNAVAILABLE',
        })
      await s.d.workspaceInvocation.run(async (view) => {
        const fs = view.fs()
        const preflight = async (target: string) => {
          if (fs.preflight) await fs.preflight(target, path.access)
          else if (path.access === 'read') await fs.stat(target)
          else
            throw Object.assign(new Error('Workspace write preflight unavailable'), {
              code: 'E_FS_PREFLIGHT_UNAVAILABLE',
            })
        }
        if (s.d.memory) {
          // Use the same provider-owned file boundary as execution. Metadata inspection cannot
          // approve a memory write; the actual mutation still requires its bound proposal.
          const files = s.d.memory.files(
            {
              ...fs,
              stat: async (target) => {
                await preflight(target)
                return fs.stat(target)
              },
            },
            { sessionKey: s.key, turn, toolUseId: call.toolUseId },
            signal,
            async () => ({ status: 'unanswered', reason: 'no-approver' }),
          )
          await files.stat(target)
        } else await preflight(target)
      })
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== 'ENOENT') return preflightError(error)
    }
  }
  return undefined
}
