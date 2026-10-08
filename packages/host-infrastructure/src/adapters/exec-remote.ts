import {
  abortedBeforeStart,
  baseEnvironment,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  type ExecAdapter,
} from './exec.js'
import type { RemoteTransport } from './remote-transport.js'

/**
 * The byte cap `createExec` applies to a local child's output, applied here to what the transport
 * hands back. The cap is passed to the transport as well, but a transport is a third-party
 * implementation that may ignore it (Stage A's own loopback does), and an unbounded string is a
 * memory problem on this machine whoever produced it - so the runner clamps rather than trusts.
 * Bytes, not characters, exactly like `createExecOutput`: the two caps have to mean the same thing.
 */
function clamp(text: string, max: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= max) return { text, truncated: false }
  return { text: buf.subarray(0, max).toString('utf8'), truncated: true }
}

/**
 * The exec gate's `inner` under a remote deployment. Spec §4.6 is explicit that all four of
 * `createPolicyExec`'s checks (a binding exists, the binding is the live one, `authorizeCwd`, the
 * backend gate) stay exactly as they are and only `inner` is swapped. Nothing about the gate
 * changes here; only the thing it finally delegates to does. A remote deployment therefore keeps
 * the binding check, the digest pin and the cwd authorization every local deployment gets - and
 * gets the cwd one over the remote workspace, because the fence `authorizeCwd` resolves through
 * sits on `createRemoteFsIo` (spec §4.6: `authorizeCwd` itself does not change by one line).
 *
 * This runner deliberately cannot fall back: a dead channel is a hard refusal (RA7 / P3), and the
 * refusal is made here rather than by the gate. Per spec §4.6.1 the remote runner throws on its
 * own when the connection is unusable and must not consult `onUnavailable` - which is what makes
 * `onUnavailable: 'allow'` inoperative under remote mode without the gate needing a remote branch.
 *
 * Being the gate's `inner` also means being the place `createExec`'s safety defaults live for a
 * remote deployment, because nothing else in the path applies them. All four are matched here
 * rather than re-invented: the environment floor (`baseEnvironment`, so AGNES_SECRET_* never leaves
 * this process), the default deadline, the default output cap, and the refusal to start anything at
 * all for an already-aborted signal. A remote command is not the weaker case for any of them - it
 * runs on a machine this host cannot reach into afterwards.
 */
export function createRemoteExec(transport: RemoteTransport): ExecAdapter {
  return {
    async run(argv, o) {
      // A closed or lost channel must never degrade into a local spawn: the caller believes it is
      // running on the remote host, and running the same argv here is a different machine, not a
      // weaker version of the same one - the reasoning §4.5.1 uses to make confine() throw.
      if (!transport.alive())
        throw Object.assign(new Error('SANDBOX_UNAVAILABLE: the remote transport is not alive'), {
          code: 'SANDBOX_UNAVAILABLE',
        })
      // The same refusal `createExec` makes: a turn cancelled before the call must not start a
      // command at all. It matters more here, not less - a started remote command outlives the
      // abort on a machine this host cannot reach into to kill it (`killAll()` below is empty).
      const alreadyAborted = abortedBeforeStart(o.signal)
      if (alreadyAborted) throw alreadyAborted
      const max = o.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
      const r = await transport.exec(argv, {
        // The environment floor, not this process's environment. A transport that spawns without an
        // explicit `env` inherits the host's - which carries AGNES_SECRET_* straight into a command
        // running on someone else's machine. `createExec` has always spread this floor under the
        // caller's own vars (`{ ...base, ...o.env }`); the remote path gets the identical shape,
        // because the floor is what a program needs to run at all and nothing else travels.
        env: { ...baseEnvironment(), ...(o.env ?? {}) },
        cwd: o.cwd,
        ...(o.stdin === undefined ? {} : { stdin: o.stdin }),
        // Defaulted, not forwarded-if-present. A caller that names no deadline gets the same 120s a
        // local child gets; leaving the field absent asked the transport to run without one.
        timeoutMs: o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(o.signal ? { signal: o.signal } : {}),
        maxOutputBytes: max,
      })
      const stdout = clamp(r.stdout, max)
      const stderr = clamp(r.stderr, max)
      return {
        code: r.code,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: r.truncated || stdout.truncated || stderr.truncated,
        timedOut: r.timedOut ?? false,
        ...(r.signal === undefined ? {} : { signal: r.signal }),
      }
    },
    // Remote process termination is deferred to B2; closing a channel does not attest it.
    async killAll() {},
  }
}
