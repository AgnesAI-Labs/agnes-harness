import { describe, expect, it } from 'vitest'
import { ciWebSelected, verifyWebResults } from './dedup-routing.mjs'

describe('single-run coverage routing', () => {
  it('keeps only the original PR and main-push Web union in CI', () => {
    expect(ciWebSelected('pull_request', 'refs/pull/42/merge')).toBe(true)
    expect(ciWebSelected('push', 'refs/heads/main')).toBe(true)
    for (const event of ['workflow_dispatch', 'schedule', 'merge_group'])
      expect(ciWebSelected(event, 'refs/heads/main')).toBe(false)
    expect(ciWebSelected('push', 'refs/heads/other')).toBe(false)
  })

  it.each([false, true])(
    'fails closed for all selected Web dependencies, external heavy/fast=%s',
    (external) => {
      const needs: Record<string, { result: string }> = {
        'web-types': { result: 'success' },
        'web-native-linux': { result: 'success' },
        'web-native-macos': { result: 'success' },
        'web-quality': { result: 'success' },
        'e2e-web': { result: 'success' },
        'e2e-web-linux': { result: 'success' },
        'linux-contracts': { result: 'success' },
        'linux-fast': { result: external ? 'skipped' : 'success' },
        'linux-migrated-heavy': { result: external ? 'skipped' : 'success' },
      }
      expect(() => verifyWebResults(needs, { externalFast: external, externalHeavy: external })).not.toThrow()
      for (const job of Object.keys(needs)) {
        const expected = needs[job]?.result
        for (const state of ['failure', 'cancelled', 'skipped', 'missing']) {
          if (state === expected) continue
          const changed = { ...needs, [job]: { result: state } }
          expect(
            () => verifyWebResults(changed, { externalFast: external, externalHeavy: external }),
            `${job}/${state}`,
          ).toThrow()
        }
      }
    },
  )

  it('does not accept success instead of a declared unselected duplicate', () => {
    expect(() => verifyWebResults({}, { externalFast: true, externalHeavy: true })).toThrow()
  })
})
