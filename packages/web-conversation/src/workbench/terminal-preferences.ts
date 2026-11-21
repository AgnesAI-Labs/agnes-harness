export type TerminalShell = 'zsh' | 'bash' | 'pwsh'
export const terminalShells: TerminalShell[] = ['zsh', 'bash', 'pwsh']
export const terminalStorageKey = (id: string) => `agnes.workbench.terminals.${id}`
const shellKey = 'agnes.workbench.terminal.shell'
const namesKey = (id: string) => `agnes.workbench.terminal.names.${id}`
export function terminalShellScope(
  remoteOrigin: string | undefined,
  platform: string | undefined,
  backend?: string,
): string {
  const identity = backend ?? remoteOrigin
  return identity ? JSON.stringify([identity, platform ?? 'unknown']) : ''
}
export function readTerminalShell(scope = '', platform?: string): TerminalShell | undefined {
  try {
    const value = localStorage.getItem(scope ? `${shellKey}.${scope}` : shellKey)
    if (terminalShells.includes(value as TerminalShell)) return value as TerminalShell
  } catch {
    /* use the platform default */
  }
  if (scope)
    return platform === 'win32'
      ? 'pwsh'
      : platform === 'darwin'
        ? 'zsh'
        : platform === 'linux'
          ? 'bash'
          : undefined
  return /Win/i.test(navigator.platform) ? 'pwsh' : /Mac/i.test(navigator.platform) ? 'zsh' : 'bash'
}
export function rememberTerminalShell(shell: TerminalShell, scope = '') {
  try {
    localStorage.setItem(scope ? `${shellKey}.${scope}` : shellKey, shell)
  } catch {
    /* memory-only preference */
  }
}
export function terminalNames(id: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(namesKey(id)) ?? '{}')
    if (value && typeof value === 'object' && !Array.isArray(value))
      return Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
  } catch {
    /* names remain session-local */
  }
  return {}
}
export function rememberTerminalNames(id: string, names: Record<string, string>) {
  try {
    localStorage.setItem(namesKey(id), JSON.stringify(names))
  } catch {
    /* memory-only names */
  }
}
