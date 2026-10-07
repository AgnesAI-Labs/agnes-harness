import { commandAllowed } from '@agnes/protocol'

/** Command strings a child engine may spawn. An empty list refuses every command. */
export type EngineLaunch = {
  enabled: boolean
  command: string
  args?: readonly string[]
  allow: readonly string[]
  /** Extra environment entries. The child still does not receive the rest of the parent environment. */
  env?: Readonly<Record<string, string>>
}

export { commandAllowed }

export function assertEngineLaunch(launch: EngineLaunch): void {
  if (!launch.enabled) throw new Error('child engine is disabled')
  if (!launch.command.trim()) throw new Error('child engine command is empty')
  if (!commandAllowed(launch.command, launch.allow))
    throw new Error('child engine command is not allowlisted')
}

export function engineArgs(args: readonly string[] | undefined, task: string): string[] {
  return [...(args ?? []), '--', task]
}
