import { describe, expect, it } from 'vitest'
import type { TuiApp } from '../src/app.js'
import { runSlash } from '../src/commands.js'

// What the daemon's apis.list returns for a profile declaring chat route `gw` and decision route
// `jev`: the decision model has already been filtered out server-side.
const LISTED = [{ route: 'gw', id: 'm1', reasoning: true }]

const app = () =>
  ({
    cwd: '/w',
    refuseSwitch: () => false,
    session: { client: { apis: async () => ({ profile: { models: LISTED } }) } },
  }) as unknown as TuiApp

describe('/model candidates', () => {
  it('offers exactly what apis.list returns, so no decision model appears', async () => {
    const r = await runSlash(app(), '/model')
    expect(r.modelChoices).toEqual([{ route: 'gw', model: 'm1', reasoning: true }])
    expect(JSON.stringify(r.modelChoices)).not.toContain('jev')
  })
})
