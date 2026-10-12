import { defineFixture } from '@agnes/extension-api/testkit'

export default defineFixture({
  name: 'minimal',
  cases: [
    {
      kind: 'tool',
      id: 'echo-ok',
      tool: 'minimal_echo',
      args: { text: 'hi' },
      expect: { isError: false, contentIncludes: 'hi', leaseDelta: -1 },
    },
    {
      kind: 'slot',
      id: 'status-line',
      slot: 'status.line',
      trigger: { kind: 'tick' },
      surface: 'tui',
      expect: { payloadEquals: { text: 'minimal extension loaded', level: 'info' } },
    },
    {
      kind: 'negative',
      id: 'undeclared',
      action: 'undeclared-api',
      expect: { errorCode: 'E_CAPABILITY_UNDECLARED' },
    },
  ],
})
