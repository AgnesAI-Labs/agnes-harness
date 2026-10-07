import { randomUUID } from 'node:crypto'
import type { ProcessOutput, SandboxProcess } from '@agnes/extension-api'

export type ShellName = 'bash' | 'zsh' | 'pwsh'
export function shellArgv(shell: ShellName, pty: boolean): string[] {
  if (shell === 'pwsh')
    return pty
      ? ['pwsh', '-NoLogo', '-NoProfile']
      : ['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-']
  if (shell === 'bash') return ['bash', '--noprofile', '--norc', pty ? '-i' : '-s']
  if (shell === 'zsh') return ['zsh', '-f', pty ? '-i' : '-s']
  throw new Error('unsupported shell; choose bash, zsh or pwsh')
}
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'"

/** Serialized commands execute in the same interpreter. Framing is independent of output retention. */
export class PersistentShell {
  busy = false
  private onExit: (() => void) | undefined
  private exited = false
  constructor(
    private readonly process: SandboxProcess,
    private readonly shell: ShellName,
  ) {
    void process.exited.then(() => {
      this.exited = true
      this.onExit?.()
    })
  }
  run(
    command: string,
    cwd: string | undefined,
    output: (chunk: ProcessOutput) => void,
  ): Promise<{ code: number; cwd: string }> {
    if (this.exited) throw new Error('persistent shell has exited')
    if (this.busy) throw new Error('shell is busy')
    this.busy = true
    const token = randomUUID().replaceAll('-', '')
    const marker = `\x1e${token}:`
    return new Promise((resolve, reject) => {
      const pending = { stdout: '', stderr: '' },
        ended = { stdout: false, stderr: false }
      let code = -1,
        nextCwd = '',
        settled = false
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        this.busy = false
        this.onExit = undefined
        off()
        if (error) reject(error)
        else resolve({ code, cwd: nextCwd })
      }
      const off = this.process.onOutput((chunk) => {
        if (ended[chunk.stream]) return
        let buffer = pending[chunk.stream] + chunk.text
        const start = buffer.indexOf(marker)
        if (start >= 0) {
          if (start) output({ stream: chunk.stream, text: buffer.slice(0, start) })
          buffer = buffer.slice(start)
          const end = buffer.indexOf('\x1f')
          if (end >= 0) {
            if (chunk.stream === 'stdout') {
              const fields = buffer.slice(marker.length, end).split('\n')
              code = Number(fields.shift())
              nextCwd = fields.join('\n')
            }
            ended[chunk.stream] = true
            pending[chunk.stream] = ''
            if (ended.stdout && ended.stderr) finish()
          } else if (buffer.length > 16384) finish(new Error('shell completion frame exceeded limit'))
          else pending[chunk.stream] = buffer
        } else {
          const keep = Math.min(buffer.length, marker.length - 1)
          const emit = buffer.slice(0, buffer.length - keep)
          if (emit) output({ stream: chunk.stream, text: emit })
          pending[chunk.stream] = buffer.slice(buffer.length - keep)
        }
      })
      this.onExit = () => {
        if (!settled) {
          for (const stream of ['stdout', 'stderr'] as const)
            if (pending[stream]) output({ stream, text: pending[stream] })
          finish(new Error('persistent shell exited before the command completed'))
        }
      }
      const script =
        this.shell === 'pwsh'
          ? `$global:LASTEXITCODE = 0; try { ${cwd ? 'Set-Location -LiteralPath ' + "'" + cwd.replaceAll("'", "''") + "' -ErrorAction Stop; " : ''}. ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(command).toString('base64')}')))); $aghJobCode = if ($?) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 } } catch { [Console]::Error.WriteLine($_); $aghJobCode = 1 }; [Console]::Out.Write([char]30 + '${token}:' + $aghJobCode + [char]10 + (Get-Location).Path + [char]31); [Console]::Error.Write([char]30 + '${token}:' + [char]31)\n`
          : `${cwd ? 'builtin cd -- ' + quote(cwd) + ' && ' : ''}builtin eval -- ${quote(command)}\n__agh_job_code=$?; command printf '\\036${token}:%s\\n%s\\037' "$__agh_job_code" "$PWD"; command printf '\\036${token}:\\037' >&2\n`
      void this.process.write(script).catch((error: unknown) => finish(error))
    })
  }
}
