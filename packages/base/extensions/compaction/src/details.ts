export type ToolCallView = { name: string; args: unknown }
export type FileDetails = { readFiles: string[]; modifiedFiles: string[] }

const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'skill_read', 'skill_read_file'])
const WRITE_TOOLS = new Set(['write', 'edit'])
const REDIRECT =
  /(?:^|[\s;&|])(?:\d*)>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))|\btee(?:\s+-[A-Za-z]+)*\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g

function appendUnique(target: string[], value: unknown): void {
  if (typeof value !== 'string' || value.length === 0 || target.includes(value) || target.length >= 50) return
  target.push(value)
}

export function fileDetails(calls: readonly ToolCallView[]): FileDetails {
  const readFiles: string[] = []
  const modifiedFiles: string[] = []
  for (const call of calls) {
    const args =
      typeof call.args === 'object' && call.args !== null && !Array.isArray(call.args)
        ? (call.args as Record<string, unknown>)
        : {}
    if (READ_TOOLS.has(call.name)) appendUnique(readFiles, args.path ?? args.name)
    else if (WRITE_TOOLS.has(call.name)) appendUnique(modifiedFiles, args.path)
    else if (call.name === 'shell' && typeof args.command === 'string') {
      for (const match of args.command.matchAll(REDIRECT))
        appendUnique(modifiedFiles, match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6])
    }
  }
  return { readFiles, modifiedFiles }
}
