import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { expect, it } from 'vitest'
import { automaticRequestDecision, withPermissionContext } from '../src/local/permission-scope.js'
import { PrompterRouter } from '../src/local/prompter.js'

const context = {
  policy: 'full-access',
  sessionKey: 'k',
  sessionId: 's',
  epoch: 1,
  actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
}
const request = (approval?: unknown) =>
  ({
    requestId: 'r1',
    kind: 'tool',
    sessionKey: 'k',
    stepId: '1/1',
    scope: 'tool:shell:execute',
    bindingHash: 'b'.repeat(64),
    deadline: new Date(Date.now() + 60_000).toISOString(),
    summary: 'git push',
    risk: 'destructive',
    options: ['allowed-once', 'rejected'],
    ...(approval ? { approval } : {}),
  }) as never

it('full access answers a tool permission by itself, but never an outward checkpoint', async () => {
  const recorded: unknown[] = []
  const answer = (approval?: unknown) =>
    withPermissionContext(
      context,
      (evidence) => recorded.push(evidence),
      () => automaticRequestDecision(request(approval)),
      async () => context,
      () => context,
    )
  expect(
    await answer({
      reviewerRequirement: 'human',
      grantConstraints: 'once',
      checkpoint: 'outward',
      subjectRevision: 'c'.repeat(64),
    }),
  ).toBeUndefined()
  expect(recorded).toHaveLength(0)
  expect(await answer()).toMatchObject({ verdict: 'allowed-once', reason: 'full-access' })
})

it('the daemon turns any answer but approve or reject at an outward checkpoint into no answer', async () => {
  const outward = {
    reviewerRequirement: 'human',
    grantConstraints: 'once',
    checkpoint: 'outward',
    subjectRevision: 'c'.repeat(64),
  }
  const ask = async (verdict: string) => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    const router = new PrompterRouter({
      local: { ask: async () => verdict as never },
      localActor: async () => context.actor,
      endpointFor: () => ep,
      connections: () => [ep.conn],
      originOf: () => ep.conn,
      clock: () => 0,
    })
    return router.ask(request(outward), { signal: new AbortController().signal })
  }
  for (const verdict of ['allowed-session', 'allowed-permanent'])
    expect(await ask(verdict)).toEqual({ verdict: 'unavailable', reason: 'invalid-answer' })
  expect(await ask('allowed-once')).toMatchObject({ verdict: 'allowed-once', answeredBy: context.actor })
})
