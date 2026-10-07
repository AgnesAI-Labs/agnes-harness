export interface SessionJob {
  id: string
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
export function sessionJobsApi(fetcher: typeof fetch = fetch) {
  async function call(sessionId: string, service: string, input: Record<string, unknown>, effect: boolean) {
    const response = await fetcher(effect ? '/api/client-modules/effect' : '/api/client-modules/service', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        rowId: 'web:builtin:agnes/jobs',
        sessionId,
        service,
        input,
        ...(effect ? { commandId: crypto.randomUUID() } : {}),
      }),
    })
    if (!response.ok) throw new Error('session jobs unavailable')
    const body: unknown = await response.json()
    if (!body || typeof body !== 'object' || !('output' in body))
      throw new Error('invalid session jobs result')
    return body.output
  }
  return {
    async read(sessionId: string, jobId?: string): Promise<JobsSnapshot> {
      const value = await call(sessionId, 'jobs.read', jobId ? { jobId } : {}, false)
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
      return call(sessionId, 'jobs.control', input, true)
    },
  }
}
