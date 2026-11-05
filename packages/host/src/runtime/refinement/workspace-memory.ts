import type { MemorySession, MemoryValidityView } from '@agnes/extension-api'
import { RefinementRegistry, type Revocation } from '@agnes/host-infrastructure/refinement-registry'
import { reconcileWorkspace, WORKSPACE_MEMORY_KEY } from './reconcile.js'
import { registryView, type ViewChange } from './registry-view.js'

/** Opens the profile's selected memory provider for a workspace, as sessions get it. */
export type MemoryOpener = (workspaceRoot: string, sessionKey: string) => MemorySession | undefined

/**
 * What the Host keeps per workspace for saved task experience: the registry, the validity view memory is
 * opened with, a workspace memory session for background work, and reconciliation when a session opens.
 *
 * The validity view is handed to memory whether refinement is on or off: paragraphs saved earlier keep
 * their review dates after the switch goes off, rather than turning into ordinary memory. It reads the
 * registry only when the memory file holds managed paragraphs, so a workspace that never saved anything
 * reads and writes no registry. Reconciliation runs only while refinement is on.
 */
export function workspaceMemory(input: {
  dataDir: string
  clock: () => number
  enabled: () => boolean
  /** A session's view answered differently than before (refinement on only): its memory note changed. */
  viewChanged?: (sessionKey: string, change: ViewChange) => void
}) {
  let opener: MemoryOpener | undefined
  const running = new Map<string, Promise<readonly Revocation[]>>()
  const registry = (workspaceRoot: string) =>
    new RefinementRegistry(input.dataDir, workspaceRoot, input.clock)
  const openWorkspaceMemory = (workspaceRoot: string): MemorySession | undefined =>
    opener?.(workspaceRoot, WORKSPACE_MEMORY_KEY)
  const enabled = () => {
    try {
      return input.enabled()
    } catch {
      return false
    }
  }

  /**
   * Reconciles a workspace's saved paragraphs with its memory file, one pass per workspace at a time; a
   * call while a pass runs shares it. Nothing happens while refinement is off. Never rejects.
   */
  const reconcile = (workspaceRoot: string): Promise<readonly Revocation[]> => {
    if (!enabled()) return Promise.resolve([])
    const current = running.get(workspaceRoot)
    if (current) return current
    const pass = (async () => {
      const records = registry(workspaceRoot)
      if (!records.read().paragraphs.some((entry) => entry.state === 'active')) return []
      const memory = openWorkspaceMemory(workspaceRoot)
      if (!memory) return []
      try {
        return await reconcileWorkspace(records, memory, input.clock)
      } finally {
        await memory.close?.()
      }
    })()
      .catch(() => [])
      .finally(() => running.delete(workspaceRoot))
    running.set(workspaceRoot, pass)
    return pass
  }

  return {
    registry,
    /** The view memory is opened with; with a session key, a change of its answers is reported for it. */
    validity: (workspaceRoot: string, sessionKey?: string): MemoryValidityView =>
      registryView(
        registry(workspaceRoot),
        input.clock,
        sessionKey === undefined || !input.viewChanged
          ? undefined
          : (change) => {
              if (enabled()) input.viewChanged?.(sessionKey, change)
            },
        'delivered',
      ),
    /** The memory selection sessions use; bound once the kernel stage has it. */
    bindMemory(open: MemoryOpener): void {
      opener = open
    },
    /** Workspace memory for work outside any session, under the fixed key `refinement:workspace`. */
    openWorkspaceMemory,
    reconcile,
    /** A session's memory has just been opened: reconcile its workspace in the background. */
    opened<T extends MemorySession | undefined>(workspaceRoot: string, memory: T): T {
      void reconcile(workspaceRoot)
      return memory
    },
  }
}

export type WorkspaceMemory = ReturnType<typeof workspaceMemory>
