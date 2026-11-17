import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { escapeControl } from './component.js'
import { tt } from './locale-extended.js'
import type { ThemedAnsi } from './theme.js'
import { McpLoginPanel } from './views/mcp-login.js'

/** Whether `/mcp <action>` is a sign-in action, which is handled here and never queued for confirmation. */
export const isMcpLoginAction = (action: string | undefined): action is 'login' | 'logout' =>
  action === 'login' || action === 'logout'

/** `/mcp login [server]` opens the sign-in panel; `/mcp logout <server>` forgets the saved sign-in. */
export async function mcpLoginSlash(
  app: TuiApp,
  action: 'login' | 'logout',
  args: readonly string[],
): Promise<SlashResult> {
  const { locale } = app
  const port = app.o.mcpLogin
  if (!port) return { text: tt('mcpLogin.unavailable', locale) }
  const [serverId, ...extra] = args
  if (extra.length > 0 || serverId?.startsWith('-'))
    return { text: tt(action === 'login' ? 'mcpLogin.usageLogin' : 'mcpLogin.usageLogout', locale) }
  const { profile } = app
  if (action === 'logout') {
    if (serverId === undefined) return { text: tt('mcpLogin.usageLogout', locale) }
    try {
      await port.logout(profile, serverId)
    } catch (error) {
      return { text: escapeControl(error instanceof Error ? error.message : String(error)) }
    }
    return { text: tt('mcpLogin.loggedOut', locale, { server: escapeControl(serverId) }) }
  }
  const copy = (text: string) => app.mouse.copy(text)
  if (serverId !== undefined) return { mcpLogin: { port, profile, serverId, copy } }
  let candidates: readonly string[]
  try {
    candidates = await port.candidates(profile)
  } catch (error) {
    const message = escapeControl(error instanceof Error ? error.message : String(error))
    return { text: tt('mcpLogin.loadFailed', locale, { error: message }) }
  }
  if (candidates.length === 0) return { text: tt('mcpLogin.none', locale) }
  return { mcpLogin: { port, profile, candidates, copy } }
}

/** The dialog `app.ts` mounts; kept here so the app only holds one line for it. */
export function createMcpLoginPanel(app: TuiApp, ansi: ThemedAnsi, locale: string): McpLoginPanel {
  return new McpLoginPanel({
    ansi,
    locale,
    maxRows: () => Math.max(4, app.o.term.size().rows - 6),
    notice: (text, tone) => app.statusBar.setNotice(text, tone),
    changed: () => app.stopped || app.renderer.requestRender(),
  })
}
