/** Command strings a child engine may spawn. An empty list refuses every command. */
export type EngineLaunch = {
  enabled: boolean
  command: string
  args?: readonly string[]
  allow: readonly string[]
  /** Extra environment entries. The child still does not receive the rest of the parent environment. */
  env?: Readonly<Record<string, string>>
}

/** Exact command match. Basenames do not allow a different path. */
export function commandAllowed(command: string, allow: readonly string[]): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  return allow.some((entry) => entry.trim() === trimmed)
}

export function assertEngineLaunch(launch: EngineLaunch): void {
  if (!launch.enabled) throw new Error('child engine is disabled')
  if (!launch.command.trim()) throw new Error('child engine command is empty')
  if (!commandAllowed(launch.command, launch.allow))
    throw new Error('child engine command is not allowlisted')
}

export function engineArgs(args: readonly string[] | undefined, task: string): string[] {
  return [...(args ?? []), '--', task]
}
