import type { UITimeline } from '@agnes/protocol'
import type { Session } from '@agnes/sdk/browser'
import type { UiExtensionContext } from '@agnes/web-client'

/** Built-in panel data supplied by the session shell; registrations confer no backend authority. */
export type WorkbenchContext = {
  session?: Session | undefined
  timeline?: UITimeline | undefined
  workspace?: { name: string; path: string }
  disabled: boolean
  /** Name a workspace file (or, with `directory`, a folder) in the prompt as a file chip. */
  mention(path: string, directory?: boolean): void
  command(command: string): void
}
export const panelContext = (context: UiExtensionContext): WorkbenchContext =>
  context.data as WorkbenchContext
