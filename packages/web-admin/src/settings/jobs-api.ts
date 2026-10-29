export interface SessionJob {
  id: string
  owner?: 'human' | 'agent'
  kind: 'shell' | 'shell-session' | 'pty' | 'child'
  command: string
  cwd: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  code: number | null
  shell?: 'bash' | 'zsh' | 'pwsh'
  stdout?: string
  stderr?: string
  truncated: boolean
}
export interface JobsSnapshot {
  jobs: SessionJob[]
  completions: SessionJob[]
  job?: SessionJob
}
export function sessionJobsApi() {
  async function call(sessionId: string, input: Record<string, unknown>, effect: boolean) {
    if (!sessions?.call) throw new Error('session jobs unavailable')
    const result = await sessions.call(
      effect ? '_agnes/v1/session.jobs.control' : '_agnes/v1/session.jobs.read',
      {
        ...input,
        sessionId,
        ...(effect ? { commandId: crypto.randomUUID() } : {}),
      },
    )
    if (!effect) return result
    if (!result || typeof result !== 'object' || !('output' in result))
      throw new Error('invalid session jobs result')
    return result.output
  }
  return {
    async read(sessionId: string, jobId?: string): Promise<JobsSnapshot> {
      const value = await call(sessionId, jobId ? { jobId } : {}, false)
      if (
        !value ||
        typeof value !== 'object' ||
        !('jobs' in value) ||
        !Array.isArray(value.jobs) ||
        !('completions' in value) ||
        !Array.isArray(value.completions)
      )
        throw new Error('invalid jobs snapshot')
      return value as JobsSnapshot
    },
    async control(sessionId: string, input: Record<string, unknown>): Promise<unknown> {
      return call(sessionId, input, true)
    },
  }
}

export type JobsSessionSource = {
  list(): Promise<import('@agnes/web-ui').SessionOption[]>
  current(): string | undefined
  call?(method: string, params: Record<string, unknown>): Promise<unknown>
}
let sessions: JobsSessionSource | undefined
/** Host injects its existing authorized session client, rather than opening a second connection. */
export function bindJobsSessions(source: JobsSessionSource): () => void {
  sessions = source
  return () => {
    if (sessions === source) sessions = undefined
  }
}
export function jobsSessions(): JobsSessionSource {
  return {
    list: () => (sessions ? sessions.list() : Promise.reject(new Error('Sessions unavailable'))),
    current: () => sessions?.current(),
  }
}
