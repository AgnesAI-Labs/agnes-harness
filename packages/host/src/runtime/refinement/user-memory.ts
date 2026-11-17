import type { RefinementSettingsView } from '@agnes/core'
import type { MemorySession } from '@agnes/extension-api'
import { RefinementRegistry } from '@agnes/host-infrastructure/refinement-registry'
import { registryView, type ViewChange } from './registry-view.js'
import type { SavedParagraphs } from './saved-paragraphs.js'
import { createUserSave, routedSaves } from './user-save.js'
import { manageUserSections } from './user-sections.js'
import type { WorkspaceSave } from './workspace-save.js'

/**
 * Saved task experience in user memory, beside the workspace's: lessons that hold in every workspace
 * are promoted automatically. One registry per installation home, next to the user memory file, as that
 * file serves every profile of the home. Returns the save path every entry point uses (a promotion, or a
 * save to the workspace), the validity view memory is opened with for sections of user memory, the
 * person's management of saved paragraphs with `layer: 'user'` added, and the background resume.
 */
export function userMemory(input: {
  /** The installation home the memory provider is opened with. */
  home: string
  clock: () => number
  settings: () => RefinementSettingsView
  saves: WorkspaceSave
  registry: (workspaceRoot: string) => RefinementRegistry
  memory: (workspaceRoot: string) => MemorySession | undefined
  workspaceParagraphs: SavedParagraphs
  /** A session's view of user memory sections answered differently than before (refinement on only). */
  viewChanged: (sessionKey: string, change: ViewChange) => void
}) {
  const { home, clock, settings } = input
  const userRegistry = () => RefinementRegistry.user(home, clock)
  const promotions = createUserSave({
    registry: userRegistry,
    workspaceRegistry: input.registry,
    settings,
    memory: input.memory,
    clock,
  })
  const paragraphs: SavedParagraphs = (session, workspaceRoot, request) =>
    request.layer === 'user'
      ? manageUserSections(session, userRegistry(), request, clock)
      : input.workspaceParagraphs(session, workspaceRoot, request)
  return {
    saves: routedSaves(input.saves, promotions),
    userRegistry,
    /** The view memory is opened with for sections of user memory; read only when the file has markers. */
    userValidity: (sessionKey?: string, child = false) =>
      registryView(
        userRegistry(),
        clock,
        sessionKey === undefined
          ? undefined
          : (change) => {
              if (settings().enabled) input.viewChanged(sessionKey, change)
            },
        child ? 'valid' : 'delivered',
      ),
    paragraphs,
    resume: (workspaceRoot: string) => promotions.resume(workspaceRoot),
  }
}
