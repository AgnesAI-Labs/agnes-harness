import { defineTool, type ToolResult } from '@agnes/extension-api'
import { guardedResult } from '../guards/output.js'
import { jobState } from './job.js'
import { ShellParams } from './schemas.js'

// First element of the argv this tool hands to `ctx.exec`. It is a placeholder, not a program: the
// deployment's sandbox implementation replaces it with the interpreter it has chosen. Keeping the
// choice out of here is what lets the parameter schema, and therefore its hash, stay identical
// everywhere agnes runs, and it keeps the command line itself untouched — one argv element,
// exactly as the model wrote it, so what the policy layer inspects is what runs.
export const SHELL_SENTINEL = '$SHELL'

// Used only when the host states no default, so an older host keeps the default it always had.
const DEFAULT_FOREGROUND_MS = 120_000
// A program writing to a pipe holds its output back in a buffer, and a command cut off at its time
// limit takes that buffer with it: the model saw only "[timed out]" and could not tell where it hung.
// Python is what models run most and the one that buffers by default, so its buffering is turned off
// for every command this tool runs, foreground or background (a server's log is read the same way).
// Its UTF-8 mode is turned on too: otherwise it writes to a pipe, and reads and writes files, in the
// locale's code page (GBK on a Chinese Windows), while the model's files and the output it is shown
// are UTF-8. PYTHONIOENCODING would cover only the standard streams, and would override the error
// handlers UTF-8 mode gives them.
const COMMAND_ENV = Object.freeze({ PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' })
// How long a background start watches the job before returning: long enough for "address in use"
// or a missing module to show, short enough that starting a server is not a wait.
const FIRST_LOOK_MS = 1000

// Under PowerShell, models wrapped command after command in `powershell -Command "..."`, and the
// outer shell expanded every `$` in that string before the inner one parsed it. The wrapper is
// recognised where it always was, at the start of the line: the program, its switches (a value
// after a switch allowed), then -Command or an abbreviation of it down to -c. -File hands the rest to
// a script, and a bare word is a script or a command, so either ends the search without a match.
const POWERSHELL = /^(?:powershell|pwsh)(?:\.exe)?$/i
const COMMAND_SWITCH = /^-c(?:om(?:m(?:a(?:nd?)?)?)?)?$/i
const FILE_SWITCH = /^-f(?:i(?:le?)?)?$/i
const NESTED_POWERSHELL_NOTE =
  '[this command already runs in PowerShell: a powershell or pwsh -Command wrapper makes the outer shell expand $ variables and quotes in its string before the inner one runs. Write the command directly.]'

function wrapsPowerShell(command: string): boolean {
  const head = /^\s*(?:&\s*)?(?:"([^"]*)"|'([^']*)'|([^\s"']+))([\s\S]*)$/.exec(command)
  const path = head?.[1] ?? head?.[2] ?? head?.[3] ?? ''
  if (!POWERSHELL.test(path.split(/[\\/]/).pop() ?? '')) return false
  let afterSwitch = false
  for (const word of (head?.[4] ?? '').trim().split(/\s+/)) {
    if (COMMAND_SWITCH.test(word)) return true
    if (FILE_SWITCH.test(word)) return false
    if (/^-\w+$/.test(word)) afterSwitch = true
    else if (afterSwitch && /^\w/.test(word)) afterSwitch = false
    else return false
  }
  return false
}

// How many times each command has run out of time, per session, so the second timeout says it is
// the second: a model re-ran a silent five-minute command unchanged twice after being told to split
// it. Same lifetime and bound as the file versions `write` checks: process memory, the oldest entry
// dropped first. After a restart the count starts again, which says less but never anything false.
export const MAX_TIMED_OUT_ENTRIES = 256
const timeouts = new Map<string, number>()

function countTimeout(key: string): number {
  const n = (timeouts.get(key) ?? 0) + 1
  timeouts.delete(key)
  timeouts.set(key, n)
  if (timeouts.size > MAX_TIMED_OUT_ENTRIES) {
    const oldest = timeouts.keys().next()
    if (!oldest.done) timeouts.delete(oldest.value)
  }
  return n
}

export const shellTool = defineTool({
  name: 'shell',
  description:
    'Run a command line in the session shell (the runtime context tells you which shell dialect is active). Output is captured; long output is stored as an artifact. timeoutMs sets how long the call may run: without it a default applies, a longer value is granted up to a maximum the deployment sets, and a larger request is capped there. A process a foreground command starts does not outlive the call. background: true starts the command as a background job and returns at once with what it printed in its first second; use it for a server or watcher that has to keep running, then read its output or stop it with the job tool. Background jobs end when the session closes.',
  parameters: ShellParams,
  meta: {
    isReadOnly: false,
    isDestructive: true,
    isConcurrencySafe: false,
    isOpenWorld: true,
    replay: 'never',
    costHint: {},
    deferLoading: false,
    requiresApproval: undefined,
  },
  async execute(args, ctx): Promise<ToolResult> {
    const cwd = args.cwd ?? ctx.cwd
    const nested = ctx.platform.shell === 'powershell' && wrapsPowerShell(args.command)
    if (args.background) {
      const jobs = ctx.jobs
      const unavailable = (why: string): ToolResult => ({
        content: [
          {
            type: 'text',
            text:
              `background job could not be started: ${why}; ` +
              'background execution is unavailable here; run the command in the foreground, in shorter steps if it is long',
          },
        ],
        isError: true,
      })
      if (!jobs) return unavailable('this session keeps no background jobs')
      let started: Awaited<ReturnType<typeof jobs.start>>
      try {
        started = await jobs.start([SHELL_SENTINEL, args.command], { cwd, env: { ...COMMAND_ENV } })
      } catch (e) {
        return unavailable((e as Error).message)
      }
      // Read until the first second is over or the job has ended; what is read here is consumed,
      // so the next `job output` carries on after it.
      const until = Date.now() + FIRST_LOOK_MS
      let state: Awaited<ReturnType<typeof jobs.output>> | undefined
      let text = ''
      try {
        for (let left = FIRST_LOOK_MS; left > 0; left = until - Date.now()) {
          state = await jobs.output(started.id, { waitMs: left })
          text += state.text
          if (state.status !== 'running') break
        }
      } catch {
        // The job runs whether or not its first output could be read; the model can ask for it.
      }
      const parts = [`background job ${started.id} started: ${args.command}`]
      parts.push(text ? text.replace(/\n$/, '') : '[no output yet]')
      if (nested) parts.push(NESTED_POWERSHELL_NOTE)
      parts.push(jobState(state ?? started))
      parts.push(
        `Read its output with the job tool (action output, id ${started.id}; waitMs waits for more) and stop it with action stop. It ends when the session closes.`,
      )
      const out = await guardedResult(ctx, parts.join('\n'))
      // A job that is already gone, and not cleanly, failed to start in every sense that matters.
      return state?.status === 'exited' && state.code !== 0 ? { ...out, isError: true } : out
    }
    // The call runs for the preset default unless the caller asks for time, and a caller may ask for
    // up to the call's limit (`ctx.timeoutMs`, which the deployment sets for this tool); a request
    // beyond it is capped, never refused. A command that has to keep running belongs in a background
    // job; this is how a long command that ends gets its time, and the limit is what keeps one
    // command from holding a session open for as long as the model likes.
    // Only a positive whole number is a request: `Math.min(NaN, limit)` is `NaN`, and zero or a
    // negative would ask for no time at all. The parameter schema rejects all three, but this clamp
    // exists precisely because the host is not trusted to have bounded the model before `execute`
    // runs, so it has to hold on its own.
    const asked = args.timeoutMs
    const requested = typeof asked === 'number' && Number.isInteger(asked) && asked > 0 ? asked : undefined
    const timeoutMs = Math.min(requested ?? ctx.defaultTimeoutMs ?? DEFAULT_FOREGROUND_MS, ctx.timeoutMs)
    let r: Awaited<ReturnType<typeof ctx.exec>>
    const startedAt = Date.now()
    try {
      r = await ctx.exec([SHELL_SENTINEL, args.command], { cwd, timeoutMs, env: { ...COMMAND_ENV } })
    } catch (e) {
      // A refusal to launch (no interpreter, sandbox denial) is reported to the model as a failed
      // call, which it can react to, rather than as an exception that ends the turn.
      return {
        content: [{ type: 'text', text: `command could not be started: ${(e as Error).message}` }],
        isError: true,
      }
    }
    const parts: string[] = []
    if (r.stdout) parts.push(r.stdout.replace(/\n$/, ''))
    if (r.stderr) parts.push(`[stderr]\n${r.stderr.replace(/\n$/, '')}`)
    // An executor that reports nothing (a third-party seam) still has the kernel's cut-off behind it,
    // so only then is a killed-looking result that took the whole limit read as the timeout it was.
    const timedOut = r.timedOut ?? (r.code < 0 && Date.now() - startedAt >= timeoutMs)
    const run = `${ctx.session.key}\0${cwd}\0${args.command}`
    if (timedOut) {
      // Last line on purpose, and no exit line: the code of a killed command says nothing, and the UI
      // reads an `[exit N]` line only when it ends the text.
      if (r.truncated) parts.push('[output truncated by sandbox]')
      if (nested) parts.push(NESTED_POWERSHELL_NOTE)
      const times = countTimeout(run)
      if (times > 1) parts.push(`[this exact command has now timed out ${times} times in this session.]`)
      // A silent timeout is said to be silent: a model read "the output above" as a measurement and
      // reported where the time went from a command that had printed nothing.
      const captured =
        r.stdout || r.stderr
          ? 'the output above is what was captured'
          : 'it printed nothing, so this result does not show where it was or why it was slow'
      // A background job is offered only where the session keeps them.
      const background = ctx.jobs
        ? ', run it with background: true and read its output with the job tool'
        : ''
      parts.push(
        `[timed out after ${timeoutMs}ms${requested !== undefined && requested > timeoutMs ? ` (requested ${requested}ms, capped)` : ''}: the command and the processes in its process group were killed; ${captured}, and the command may have taken partial effect. Check the current state before retrying. Do not rerun it unchanged: make it print its progress, split it into shorter steps${background}, or ask for a longer timeoutMs (capped by the deployment).]`,
      )
      return { ...(await guardedResult(ctx, parts.join('\n'))), isError: true }
    }
    // A run that finished is a fresh start: a later timeout of the same command is a first again.
    timeouts.delete(run)
    // Said before the exit line, which the UI reads only when it ends the text. Without it the model
    // finds the port closed a call later and goes looking for a cause in the command it ran.
    if (r.stoppedProcesses)
      parts.push(
        `[${r.stoppedProcesses} process${r.stoppedProcesses === 1 ? '' : 'es'} this command started ${r.stoppedProcesses === 1 ? 'was' : 'were'} still running when it returned and ${r.stoppedProcesses === 1 ? 'was' : 'were'} stopped with it: nothing a foreground command starts outlives the call. Run a process that has to keep going (a server, a watcher) with background: true.]`,
      )
    if (nested) parts.push(NESTED_POWERSHELL_NOTE)
    parts.push(`[exit ${r.code}]${r.truncated ? ' [output truncated by sandbox]' : ''}`)
    const out = await guardedResult(ctx, parts.join('\n'))
    // Strictly zero, not "not positive": a process killed by a signal is reported with a negative
    // code, and `> 0` would call that a success.
    return r.code === 0 ? out : { ...out, isError: true }
  },
})
