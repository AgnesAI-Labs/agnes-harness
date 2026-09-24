import { defineFixture, type FixtureCase, type ToolCase } from '@agnes/extension-api/testkit'
import { expectTypeOf } from 'vitest'

expectTypeOf<Extract<FixtureCase, { kind: 'tool' }>>().toEqualTypeOf<ToolCase>()
expectTypeOf<FixtureCase['kind']>().toEqualTypeOf<'tool' | 'hook' | 'slot' | 'negative'>()
export function fixtureTypeProbes() {
  defineFixture({
    name: 'all',
    cases: [
      { kind: 'tool', id: 't', tool: 'echo', args: {}, expect: { contentIncludes: 'hi', leaseDelta: -1 } },
      { kind: 'hook', id: 'h', event: 'context', payload: {}, expect: { returnEquals: {} } },
      {
        kind: 'slot',
        id: 's',
        slot: 'status.line',
        surface: 'tui',
        trigger: { kind: 'tick' },
        expect: { empty: true },
      },
      { kind: 'negative', id: 'n', action: 'infinite-loop', expect: { errorCode: 'E_LEASE_EXPIRED' } },
    ],
  })
  // @ts-expect-error event names are closed
  defineFixture({ name: 'bad', cases: [{ kind: 'hook', id: 'h', event: 'fake', payload: {}, expect: {} }] })
  defineFixture({
    name: 'bad',
    cases: [
      {
        kind: 'slot',
        id: 's',
        slot: 'status.line',
        surface: 'tui',
        // @ts-expect-error tool_result trigger requires its toolUseId
        trigger: { kind: 'tool_result' },
        expect: {},
      },
    ],
  })
  defineFixture({
    name: 'bad',
    // @ts-expect-error negative checks need an actual author error code
    cases: [{ kind: 'negative', id: 'n', action: 'bad-slot-payload', expect: { errorCode: 'PASS' } }],
  })
}
