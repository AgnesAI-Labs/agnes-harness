import { execFile } from 'node:child_process'
import { createPlatform } from '@agnes/host'

/** Browser opening is best effort; the visible link remains usable. No shell interpolation. */
export function openLoginBrowser(url: string, signal: AbortSignal): void {
  if (signal.aborted) return
  try {
    const parsed = new URL(url)
    const allowed = new Set([
      'auth.openai.com',
      'claude.ai',
      'github.com',
      'auth.kimi.com',
      'www.kimi.com',
      'auth.x.ai',
      'accounts.x.ai',
    ])
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !allowed.has(parsed.hostname))
      return
  } catch {
    return
  }
  const os = createPlatform().os
  const command =
    os === 'win32'
      ? (['rundll32.exe', ['url.dll,FileProtocolHandler', url]] as const)
      : os === 'darwin'
        ? (['open', [url]] as const)
        : (['xdg-open', [url]] as const)
  execFile(command[0], [...command[1]], { signal, timeout: 10_000, windowsHide: true }, () => {})
}
