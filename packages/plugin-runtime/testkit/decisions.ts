import type {
  DecisionHandle,
  DecisionPort,
  DecisionResponse,
  DecisionSnapshot,
  DecisionSpec,
} from '@agnes/extension-api'

/** In-memory DecisionPort for loop tests. A request stays pending until the test answers it. */
export function scriptedDecisions(sessionId = 'author-loop-test') {
  const specs = new Map<string, DecisionSpec>()
  const answers = new Map<string, DecisionResponse | 'expired'>()
  const requests: DecisionSpec[] = []
  const snapshot = (handle: DecisionHandle): DecisionSnapshot => {
    const spec = specs.get(handle.id)
    if (!spec) throw Object.assign(new Error('Unknown decision'), { code: 'E_DECISION_NOT_FOUND' })
    const answer = answers.get(handle.id)
    const at = new Date(0).toISOString()
    return {
      handle,
      revision: answer ? 2 : 1,
      request: {
        spec,
        subjectDigest: 'scripted',
        owner: 'scripted',
        operationId: handle.id,
        sourcePackage: 'scripted',
        packageVersion: '0.0.0',
        requestedBy: { id: 'test', org: 'test', role: 'owner', deptPath: [], attrs: {} },
        lane: 'main',
        createdAt: at,
        expiresAt: null,
      },
      result:
        answer === 'expired'
          ? { reason: 'expired', at, code: 'E_DECISION_EXPIRED' }
          : answer
            ? {
                reason: 'answered',
                at,
                response: answer,
                answeredBy: { id: 'test', org: 'test', role: 'owner', deptPath: [], attrs: {} },
              }
            : null,
      answerCommand: null,
      consumption: null,
      invalidation: null,
    }
  }
  const port: DecisionPort = {
    async request(spec) {
      const handle = { id: `decision:${spec.key}`, sessionId }
      // The same stable key is the same request; a replay must not ask the person twice.
      if (!specs.has(handle.id)) {
        specs.set(handle.id, structuredClone(spec))
        requests.push(structuredClone(spec))
      }
      return handle
    },
    async get(handle) {
      return snapshot(handle)
    },
    async wait(handle) {
      const current = snapshot(handle)
      return current.result
        ? { status: 'resolved', snapshot: current }
        : { status: 'pending', handle, waitEndedBy: 'detached' }
    },
  }
  return {
    port,
    requests,
    answer(key: string, option: string, value: DecisionResponse['value'] = null) {
      answers.set(`decision:${key}`, { option, value })
    },
    expire(key: string) {
      answers.set(`decision:${key}`, 'expired')
    },
  }
}
