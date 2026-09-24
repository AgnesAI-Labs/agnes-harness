import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/** Test-only OS observation: direct children of the exact daemon PID, never a name-based kill list. */
export function windowsChildren(pid: number): number[] {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid daemon PID')
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw new Error('SystemRoot missing')
  const result: unknown = JSON.parse(
    execFileSync(
      join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${pid}' | Select-Object -ExpandProperty ProcessId)`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 },
    ),
  )
  if (!Array.isArray(result) || !result.every((value) => Number.isSafeInteger(value) && value > 0))
    throw new Error('invalid child process snapshot')
  return result
}

export function windowsIdentities(distribution: string, pids: number[]): (string | null)[] {
  const native = join(distribution, 'node_modules/@agnes/system-node/dist/native/agnes-system.node')
  return JSON.parse(
    execFileSync(
      join(distribution, 'runtime', 'node.exe'),
      [
        '-e',
        `
    const api=require(${JSON.stringify(native)});
    console.log(JSON.stringify(${JSON.stringify(pids)}.map(pid=>api.processStartTime(pid))));
  `,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 },
    ),
  ) as (string | null)[]
}
