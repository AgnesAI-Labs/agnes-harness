import type { UITimeline } from '@agnes/protocol'
import type { Session } from '@agnes/sdk/browser'
import type { UiExtensionContext } from '@agnes/web-client'

/** Built-in panel data supplied by the session shell; registrations confer no backend authority. */
export type WorkbenchContext = {
  session?: Session | undefined
  timeline?: UITimeline | undefined
  disabled: boolean
  mention(path: string): void
  command(command: string): void
}
export const panelContext = (context: UiExtensionContext): WorkbenchContext =>
  context.data as WorkbenchContext
