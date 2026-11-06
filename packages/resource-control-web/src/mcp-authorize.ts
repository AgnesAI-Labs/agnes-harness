import { authorizeMcpServer, type LocaleTranslator } from '@agnes/web-ui'

/** The admin shell's confirmation dialog; it takes its wording from a translator. */
type ShellConfirm = (summary: string, t: LocaleTranslator) => Promise<boolean>

/** Starts the browser sign-in for one MCP server from the detail page. `t` is the detail page's translator. */
export function authorizeFromDetail(
  serverId: string,
  t: LocaleTranslator,
  confirm: ShellConfirm,
): Promise<void> {
  // The shell dialog asks for its title, text and button label by key; answer with the sign-in wording.
  const wording: LocaleTranslator = (key, vars) =>
    key === 'confirmation.title'
      ? t('mcp.oauth.leave.title')
      : key === 'confirmation.confirm'
        ? t('mcp.oauth.leave.continue')
        : String(vars?.summary ?? '')
  return authorizeMcpServer(serverId, {
    fetch: (input, init) => fetch(input, init),
    location: window.location,
    t,
    confirm: (text) => confirm(text, wording),
    navigate: (url) => window.location.assign(url),
  })
}
