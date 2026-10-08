import { describe, expect, it } from 'vitest'
import { PlanModeRequestError, submitPlanCommand } from '../src/plan-mode.js'

describe('submitPlanCommand', () => {
  it('posts the workspace and the slash line to the same-origin plan route', async () => {
    let url = ''
    let init: RequestInit | undefined
    const fetcher = (async (nextUrl: string, nextInit?: RequestInit) => {
      url = nextUrl
      init = nextInit
      return new Response(JSON.stringify({ active: true, text: 'Plan mode is on' }), { status: 200 })
    }) as typeof fetch
    await expect(submitPlanCommand('/work', '/plan on', fetcher)).resolves.toEqual({
      active: true,
      text: 'Plan mode is on',
    })
    expect(url).toBe('/api/plan-mode')
    expect(init?.method).toBe('POST')
    expect(init?.credentials).toBe('same-origin')
    expect(init?.body).toBe(JSON.stringify({ cwd: '/work', line: '/plan on' }))
  })

  it('rejects a response that is not a plan-mode result', async () => {
    const fetcher = (async () => new Response('nope', { status: 500 })) as typeof fetch
    await expect(submitPlanCommand('/work', '/plan', fetcher)).rejects.toBeInstanceOf(PlanModeRequestError)
  })
})
