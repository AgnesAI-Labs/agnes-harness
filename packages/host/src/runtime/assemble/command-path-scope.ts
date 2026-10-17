import { isAbsolute, relative, resolve } from 'node:path'
import type { KernelOptions } from '@agnes/core'

/** Only Host-classified domains can admit external command-table identities. */
export const hostCommandPathScope: NonNullable<KernelOptions['commandPathScopeFor']> =
  ({ workspaceRoot, memory, workspaceInvocation }) =>
  async (input, signal) => {
    if (!['read', 'write', 'edit', 'ls', 'grep', 'find'].includes(input.call.name)) return undefined
    const args = input.call.args as Record<string, unknown>
    if (typeof args.path !== 'string') return undefined
    signal.throwIfAborted()
    const path = resolve(workspaceRoot, args.path)
    const within = (root: string) => {
      const suffix = relative(root, path)
      return suffix !== '..' && !suffix.startsWith('../') && !suffix.startsWith('..\\') && !isAbsolute(suffix)
    }
    if (within(workspaceRoot)) return undefined
    // Only the provider's own root is classified. Its live file port still enforces off,
    // ownership, content limits, exact-diff approval and CAS, including symlink refusals.
    if (memory && within(memory.root)) return { root: memory.root }
    if (!workspaceInvocation) return undefined
    const access = ['write', 'edit'].includes(input.call.name) ? 'write' : 'read'
    await workspaceInvocation.run(async (view) => {
      const fs = view.fs()
      if (!fs.preflight) throw new Error('Controlled path preflight unavailable')
      await fs.preflight(args.path as string, access)
    })
    // A successful live Host fence check identifies explicitly permitted external files.
    // The normalizer still validates the original spelling; no catch turns errors into access.
    return { root: path }
  }
