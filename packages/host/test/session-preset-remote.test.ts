import { describe, expect, it } from 'vitest'
import { checkPresetHardRequirements } from '../src/session.js'

// Minimal doubles for `ResolvedProfile` / `Assembled` / `ResolvedPreset`, narrowed to the fields
// `checkPresetHardRequirements` actually reads (session.ts:61). `adapters.transport` is the exact
// field Task 6 added to `AdapterBundle` (adapters/index.ts:60): present under a remote deployment,
// absent under a local one - the direct flag this test drives instead of pattern-matching the
// `sandbox.l1` capability's human-readable `reason` string.
describe('code presets under a remote sandbox', () => {
  it('refuses a preset that declares code_runtime when the sandbox is remote', () => {
    expect(() =>
      checkPresetHardRequirements(
        /* profile */ { presets: { allowed: ['code'] } } as never,
        /* assembled */ {
          adapters: {
            platform: {
              capability: () => ({ level: 'unavailable', scope: [], reason: 'remote host boundary' }),
            },
            transport: {},
          },
          runtimes: { python: () => ({}) },
        } as never,
        /* resolved */ { doc: { code_runtime: { language: 'python' } }, view: {} } as never,
        'code',
      ),
    ).toThrow(/remote/i)
  })

  it('still refuses a sandbox.required preset under remote, quoting the l1 reason', () => {
    expect(() =>
      checkPresetHardRequirements(
        { presets: { allowed: ['strict'] } } as never,
        {
          adapters: {
            platform: {
              capability: () => ({ level: 'unavailable', scope: [], reason: 'remote host boundary' }),
            },
            transport: {},
          },
          runtimes: {},
        } as never,
        { doc: { sandbox: { required: true } }, view: {} } as never,
        'strict',
      ),
    ).toThrow(/sandbox L1/i)
  })

  // The mirror of the first test: same code_runtime preset, but `adapters.transport` is undefined -
  // the exact shape a local deployment assembles (Task 6 only ever sets `transport` when the
  // deployment is remote). The refusal at session.ts:92 must not fire here, so this doubles all the
  // way past it: `runtimes.python` so the next check (line 97) is satisfied, and enough of
  // `provider.routes` / `resolved.view.model` / `assembled.routes` for materializeRoutes's own
  // route-resolution checks (assemble/routes.ts:37) to succeed too, since checkPresetHardRequirements
  // keeps going past the code_runtime check to that one.
  it('does not refuse a code preset under a local deployment (transport undefined)', () => {
    expect(() =>
      checkPresetHardRequirements(
        /* profile */ {
          presets: { allowed: ['code'] },
          provider: { routes: [{ route: 'default', models: [{ id: 'model-a' }] }] },
        } as never,
        /* assembled */ {
          adapters: {
            platform: {
              capability: () => ({ level: 'full', scope: [], reason: '' }),
            },
            // transport intentionally omitted: this is the local-deployment shape.
          },
          runtimes: { python: () => ({}) },
          routes: { primary: { route: 'default', model: 'model-a' } },
        } as never,
        /* resolved */ {
          doc: { code_runtime: { language: 'python' } },
          view: { name: 'code', model: { id: {}, route: { primary: 'default' } } },
        } as never,
        'code',
      ),
    ).not.toThrow()
  })
})
