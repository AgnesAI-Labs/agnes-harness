import type { SandboxEnforcement } from './common.js'
import type { SandboxExecRequest } from './sandbox-provider.js'

export type ProcessOutput = Readonly<{ stream: 'stdout' | 'stderr'; text: string }>
export type ProcessExit = Readonly<{ code: number | null; signal?: string }>
/** Open is invocation-authorized; the returned process is owned by the session, not the call. */
export type SandboxProcessRequest = SandboxExecRequest &
  Readonly<{
    pty?: Readonly<{ columns: number; rows: number }>
  }>
export interface SandboxProcess {
  readonly enforcement: SandboxEnforcement
  readonly exited: Promise<ProcessExit>
  onOutput(listener: (chunk: ProcessOutput) => void): () => void
  write(text: string): Promise<void>
  resize(columns: number, rows: number): Promise<void>
  signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): Promise<void>
  /** Kill the process tree and join its exit; idempotent. */
  close(): Promise<void>
}
export type OpenProcess = (request: SandboxProcessRequest) => Promise<SandboxProcess>
