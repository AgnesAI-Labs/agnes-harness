import assert from 'node:assert/strict'
import { testSubscriptionCredential } from '@agnes/ai'
import { createCodexLogin } from '../../../host/src/codex-login.js'

// Exercise the real pi-ai flows and Host interaction bridge. Only HTTP is faked;
// never replace the login implementation (that would hide missing bundled modules).
globalThis.fetch = async (input) => {
  const url = new URL(String(input))
  const verificationOrigin =
    url.hostname === 'auth.kimi.com'
      ? 'https://www.kimi.com'
      : url.hostname === 'auth.x.ai'
        ? 'https://accounts.x.ai'
        : url.origin
  assert.ok(
    ['/login/device/code', '/api/oauth/device_authorization', '/oauth2/device/code'].includes(url.pathname),
  )
  return Response.json({
    device_code: 'fixture-device',
    user_code: 'ABCD-EFGH',
    verification_uri: `${verificationOrigin}/activate`,
    verification_uri_complete: `${verificationOrigin}/activate?code=ABCD-EFGH`,
    interval: 5,
    expires_in: 900,
  })
}

// Also exercise the inference phase: successful login alone does not prove that
// header-owned auth reaches the bundled HTTP implementation.
let inferenceRequests = 0
const deviceFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init)
  assert.equal(request.headers.get('authorization'), 'Bearer fixture-access')
  assert.equal(request.headers.get('x-api-key'), null)
  assert.equal(new URL(request.url).pathname, '/coding/v1/messages')
  inferenceRequests++
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'fixture',
        role: 'assistant',
        model: 'kimi-for-coding',
        content: [],
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}
assert.equal(
  await testSubscriptionCredential(
    'kimi-coding',
    { headers: { Authorization: 'Bearer fixture-access' } },
    'kimi-for-coding',
    new AbortController().signal,
  ),
  true,
)
assert.equal(inferenceRequests, 1)
globalThis.fetch = deviceFetch

const login = createCodexLogin({
  commit: async () => {
    throw new Error('must not commit')
  },
})
for (const providerId of ['openai-codex', 'anthropic', 'github-copilot', 'kimi-coding', 'xai']) {
  const owner = {},
    lifetime = new AbortController()
  let result = await login(
    {
      action: 'start',
      providerId,
      accountId: 'smoke',
      label: 'Smoke',
      expectedRevision: 0,
      loginMethod: ['openai-codex', 'anthropic'].includes(providerId) ? 'browser' : 'device_code',
    },
    owner,
    lifetime.signal,
  )
  try {
    const deadline = Date.now() + 10_000
    while (!result.notices?.some((n) => n.url)) {
      assert.equal(result.state, 'running', `${providerId}: ${result.error}`)
      assert.ok(Date.now() < deadline, `${providerId}: no authorization notice`)
      if (result.prompt?.type === 'text') {
        result = await login(
          { action: 'answer', operationId: result.operationId, promptId: result.prompt.id, answer: '' },
          owner,
          lifetime.signal,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
      result = await login({ action: 'poll', operationId: result.operationId }, owner, lifetime.signal)
    }
    assert.equal(result.state, 'running')
    console.log(`${providerId}: authorization notice delivered`)
    assert.equal(
      (await login({ action: 'cancel', operationId: result.operationId }, owner, lifetime.signal)).state,
      'cancelled',
    )
  } finally {
    lifetime.abort()
  }
}
