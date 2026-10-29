export type PlanModeResult = { active: boolean; text: string }

export class PlanModeRequestError extends Error {
  constructor() {
    super('Plan mode request failed')
    this.name = 'PlanModeRequestError'
  }
}

type Fetcher = typeof fetch

/** Request the selected backend plan service through the authenticated admin adapter. */
export async function submitPlanCommand(
  cwd: string,
  line: string,
  fetcher: Fetcher = fetch,
  sessionId?: string,
): Promise<PlanModeResult> {
  let response: Response
  try {
    response = await fetcher('/api/plan-mode', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd, line, ...(sessionId ? { sessionId } : {}) }),
    })
  } catch {
    throw new PlanModeRequestError()
  }
  let body: { active?: unknown; text?: unknown }
  try {
    body = (await response.json()) as { active?: unknown; text?: unknown }
  } catch {
    throw new PlanModeRequestError()
  }
  if (!response.ok || typeof body.active !== 'boolean' || typeof body.text !== 'string')
    throw new PlanModeRequestError()
  return { active: body.active, text: body.text }
}
