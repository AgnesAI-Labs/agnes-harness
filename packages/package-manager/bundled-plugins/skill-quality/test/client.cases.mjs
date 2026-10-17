import assert from 'node:assert/strict'
import { workbenchPanels } from '@agnes/web-client'
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { apply, validSnapshot } from '../src/client.js'
import evalFixture from '../src/fixtures/eval.json' with { type: 'json' }
import { catalog } from '../src/locales.js'
import { candidateReceipt, qualityView } from '../src/model.mjs'

export function registerClientTests(test) {
  test('quality panel shows bilingual evidence, keyboard filters, safe session switches and missing backend; uninstall releases registrations', async () => {
    assert.equal(validSnapshot({ records: [] }), false)
    assert.equal(
      validSnapshot({
        schemaVersion: 1,
        records: [{ candidate: { candidateId: 'old' }, freshness: 'observed' }],
      }),
      false,
    )
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    let language = 'en',
      session = 'session-a',
      stopRole,
      catalogs = 0
    const listeners = new Set()
    const evidence = structuredClone(evalFixture)
    const candidate = candidateReceipt({
      candidateId: `candidate-${'1'.repeat(32)}`,
      candidateHash: evidence.candidateHash,
      packageId: 'synthetic-skill',
      baseHash: null,
      origin: { sessionKey: session },
      state: 'draft',
      tests: null,
    })
    const record = qualityView({ candidate, evidence, installedObservation: null })
    let missing = false
    const ctx = {
      session: {
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot: () => session,
      },
      locale: {
        register() {
          catalogs++
          return () => {
            catalogs--
          }
        },
      },
      presentationRoles: {
        register(role) {
          stopRole = role.mount()
          let live = true
          return () => {
            if (live) {
              live = false
              stopRole()
            }
          }
        },
      },
      profile: {
        services: {
          async query(name, input, options) {
            assert.equal(name, 'quality.read')
            assert.deepEqual(options.sessionReads, [input.sessionId])
            if (missing) throw new Error('Backend row missing')
            return { schemaVersion: 1, records: input.sessionId === 'session-a' ? [record] : [] }
          },
        },
      },
    }
    const dispose = apply(ctx)
    const panel = workbenchPanels.get('skill-quality')
    assert.ok(panel)
    const target = document.createElement('div')
    document.body.append(target)
    const root = createRoot(target)
    const render = () =>
      root.render(h(panel.component, { context: { t: (key) => catalog[language][key] ?? key } }))
    try {
      await act(async () => {
        render()
      })
      assert.match(target.textContent, /Manual eval import \(unverified\)/)
      assert.match(target.textContent, /good-output/)
      assert.match(target.textContent, /missing-refusal/)
      assert.match(target.textContent, /Eval environment/)
      const all = target.querySelector('input[type="radio"][value="all"]')
      assert.ok(all)
      await act(async () => {
        all.focus()
        all.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      })
      assert.equal(target.textContent.includes('missing-refusal'), false)
      language = 'zh-CN'
      await act(async () => {
        render()
      })
      assert.match(target.textContent, /人工导入评测（未经验证）/)
      assert.match(target.textContent, /评测环境/)
      missing = true
      session = 'session-b'
      await act(async () => {
        for (const listener of listeners) listener()
      })
      assert.equal(target.textContent.includes('synthetic-skill'), false)
      assert.match(target.textContent, /质量证据暂不可用/)
      assert.equal(target.querySelectorAll('input[type="radio"]').length, 0)
      dispose()
      assert.equal(workbenchPanels.get('skill-quality'), undefined)
      assert.equal(catalogs, 0)
    } finally {
      await act(async () => root.unmount())
      dispose()
      target.remove()
      assert.equal(listeners.size, 0)
      globalThis.IS_REACT_ACT_ENVIRONMENT = false
    }
  })
}
