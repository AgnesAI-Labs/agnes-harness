import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ciWebSelected, verifyPlatformResults, verifyWebResults } from './dedup-routing.mjs'

describe('single-run coverage routing', () => {
  it('runs browsers on explicit dispatch instead of testing the scheduler default branch', () => {
    expect(ciWebSelected('schedule', 'refs/heads/main')).toBe(false)
    expect(ciWebSelected('schedule', 'refs/heads/develop')).toBe(false)
    expect(ciWebSelected('workflow_dispatch', 'refs/heads/develop', true)).toBe(true)
    expect(ciWebSelected('workflow_dispatch', 'refs/heads/main', true)).toBe(true)
    expect(ciWebSelected('workflow_dispatch', 'refs/heads/main', false)).toBe(false)
    for (const event of ['pull_request', 'push', 'merge_group'])
      expect(ciWebSelected(event, 'refs/heads/main', true)).toBe(false)
    expect(ciWebSelected('push', 'refs/heads/other')).toBe(false)
  })

  it('has one 02:00 Shanghai scheduler that dispatches the full suite on develop', () => {
    const directory = new URL('../../.github/workflows/', import.meta.url)
    const scheduled = readdirSync(directory).filter((file) =>
      /^  schedule:/m.test(readFileSync(new URL(file, directory), 'utf8')),
    )
    expect(scheduled).toEqual(['e2e-web-nightly.yml'])
    const dispatcher = readFileSync(new URL(scheduled[0]!, directory), 'utf8')
    expect(dispatcher).toContain("cron: '0 18 * * *'")
    expect(dispatcher).toContain(
      'gh workflow run ci.yml --repo "$GH_REPO" --ref develop --field browsers=true',
    )
    expect(dispatcher).toContain("dispatch-develop:\n    if: github.event_name == 'schedule'")
    expect(dispatcher).toContain('actions: write')
    expect(dispatcher).not.toContain('actions/checkout')
    expect(dispatcher).not.toContain('continue-on-error')
  })

  it('preserves the full-browser manual entry on the selected ref', () => {
    const dispatcher = readFileSync(
      new URL('../../.github/workflows/e2e-web-nightly.yml', import.meta.url),
      'utf8',
    )
    expect(dispatcher).toContain("browsers:\n    if: github.event_name == 'workflow_dispatch'")
    expect(dispatcher).toContain('uses: ./.github/workflows/e2e-web.yml')
    expect(dispatcher).toContain('with: { suite: nightly }')
  })

  it.each(['gate', 'nightly', 'narrow-nightly'])(
    'fails closed for all selected browser dependencies, suite=%s',
    (suite) => {
      const needs: Record<string, { result: string }> = {
        'web-types': { result: 'success' },
        'web-native-linux': { result: 'success' },
        'web-native-macos': { result: 'success' },
        'web-local-linux': { result: 'success' },
        'web-local-macos': { result: 'success' },
        'web-quality-linux': { result: 'success' },
        'web-quality-macos': { result: 'success' },
        'e2e-web': { result: suite === 'narrow-nightly' ? 'skipped' : 'success' },
        'e2e-web-linux': { result: suite === 'narrow-nightly' ? 'skipped' : 'success' },
        'e2e-web-narrow-nightly': { result: suite === 'gate' ? 'skipped' : 'success' },
        'e2e-web-linux-narrow-nightly': { result: suite === 'gate' ? 'skipped' : 'success' },
      }
      expect(() => verifyWebResults(needs, { suite })).not.toThrow()
      for (const job of Object.keys(needs)) {
        const expected = needs[job]?.result
        for (const state of ['success', 'failure', 'cancelled', 'skipped', 'missing']) {
          if (state === expected) continue
          const changed = { ...needs, [job]: { result: state } }
          expect(() => verifyWebResults(changed, { suite }), `${job}/${state}`).toThrow()
        }
      }
    },
  )

  it('refuses an unknown suite instead of accepting an empty result', () => {
    expect(() => verifyWebResults({}, { suite: 'unknown' })).toThrow('suite')
  })
})

function workflowJob(file: string, name: string) {
  const source = readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8')
  return source.split(`\n  ${name}:\n`)[1]?.split(/\n {2}[a-z][a-z0-9-]*:\n/)[0] ?? ''
}

describe('independent platform preparation', () => {
  it('never makes a platform check or heavy tier wait for another platform native producer', () => {
    for (const platform of ['linux', 'macos', 'windows']) {
      for (const layer of ['check', 'heavy']) {
        const body = workflowJob('ci.yml', `${layer}-${platform}`)
        expect(body).toContain(`needs: [changes, static, native-${platform}, local-${platform}]`)
        for (const other of ['linux', 'macos', 'windows'].filter((name) => name !== platform))
          expect(body).not.toContain(`needs.native-${other}`)
      }
    }
  })

  it('keeps Linux and macOS browser quality dependencies independent until the final gate', () => {
    for (const platform of ['linux', 'macos']) {
      const native = `web-native-${platform}`
      const quality = `web-quality-${platform}`
      const body = workflowJob('e2e-web.yml', quality)
      expect(body).toContain(`needs: [web-types, ${native}]`)
      const browser = workflowJob('e2e-web.yml', platform === 'linux' ? 'e2e-web-linux' : 'e2e-web')
      expect(browser).toContain(quality)
      expect(browser).not.toContain(`web-quality-${platform === 'linux' ? 'macos' : 'linux'}`)
    }
  })
})

describe('platform result aggregation', () => {
  it.each(['check', 'heavy'])('requires exactly the selected %s platforms', (layer) => {
    for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch']) {
      const needs: Record<string, { result: string; outputs?: Record<string, string> }> = {
        changes: { result: 'success', outputs: { 'docs-only': 'false' } },
      }
      for (const platform of ['linux', 'macos', 'windows'])
        needs[`${layer}-${platform}`] = {
          result:
            layer === 'heavy' && event === 'pull_request' && platform !== 'linux' ? 'skipped' : 'success',
        }
      expect(() => verifyPlatformResults(needs, layer, event)).not.toThrow()
      for (const platform of ['linux', 'macos', 'windows']) {
        const job = `${layer}-${platform}`
        for (const state of ['failure', 'cancelled', 'skipped', 'missing']) {
          if (state === needs[job]?.result) continue
          expect(() => verifyPlatformResults({ ...needs, [job]: { result: state } }, layer, event)).toThrow()
        }
      }
    }
  })
})

describe('shared preparation contracts', () => {
  it('keeps fresh Windows native compilation prerequisites on every check and heavy runner', () => {
    for (const file of ['ci-platform-check.yml', 'ci-platform-heavy.yml']) {
      const source = readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8')
      expect(source).toContain('prepare-windows-native.ps1')
      expect(source.indexOf('prepare-windows-native.ps1')).toBeLessThan(
        source.indexOf('run --project fast') < 0
          ? source.indexOf('run-heavy-shard.mjs')
          : source.indexOf('run --project fast'),
      )
      expect(source).toContain("if: runner.os == 'Windows'")
    }
  })

  it('preserves independent batch deadlines and continues selected batches after a sibling failure', () => {
    const source = readFileSync(new URL('../../.github/workflows/e2e-web.yml', import.meta.url), 'utf8')
    for (let index = 0; index < 3; index++) {
      expect(source).toContain(
        `!cancelled() && steps.local.outcome == 'success' && matrix.batches[${index}] != null`,
      )
      expect(source).toContain(
        'timeout-minutes: $' + '{{ matrix.batches[' + index + '].timeoutMinutes || 10 }}',
      )
    }
    expect(source).not.toContain('continue-on-error')
    expect(source).not.toContain('ci.mjs prepare')
  })
})
