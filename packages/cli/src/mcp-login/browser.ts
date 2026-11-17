import { execFile } from 'node:child_process'
import { createPlatform } from '@agnes/host'

type Run = (command: string, args: readonly string[]) => void

const run: Run = (command, args) => {
  execFile(command, [...args], { timeout: 10_000, windowsHide: true }, () => {})
}

/**
 * Opens a sign-in page in the default browser, best effort: only an https address without user
 * information is opened, no shell is involved, and a failure is ignored (the address stays on
 * screen).
 */
export function openMcpLoginBrowser(url: string, open: Run = run): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return
    const os = createPlatform().os
    if (os === 'win32') open('rundll32.exe', ['url.dll,FileProtocolHandler', url])
    else open(os === 'darwin' ? 'open' : 'xdg-open', [url])
  } catch {
    // Opening the browser is a convenience; the address is shown either way.
  }
}
