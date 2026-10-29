import { commandAllowed } from '@agnes/protocol'

/** Command strings a child engine may spawn. An empty list refuses every command. */
export type EngineLaunch = {
  enabled: boolean
  command: string
  args?: readonly string[]
  allow: readonly string[]
  /** Extra environment entries. The child still does not receive the rest of the parent environment. */
  env?: Readonly<Record<string, string>>
  /** Trusted programmatic deployment config only; not part of saved/model settings. */
  windowsBatch?: 'script' | 'argv-proxy'
}

export { commandAllowed }

export function assertEngineLaunch(launch: EngineLaunch): void {
  if (launch.windowsBatch !== undefined && !['script', 'argv-proxy'].includes(launch.windowsBatch))
    throw new Error('invalid Windows child engine batch mode')
  if (!launch.enabled) throw new Error('child engine is disabled')
  if (!launch.command.trim()) throw new Error('child engine command is empty')
  if (!commandAllowed(launch.command, launch.allow))
    throw new Error('child engine command is not allowlisted')
}

export function engineArgs(args: readonly string[] | undefined, task: string): string[] {
  return [...(args ?? []), '--', task]
}
