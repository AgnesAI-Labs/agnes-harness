/** @vitest-environment happy-dom */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createClientPanelTestHost } from '@agnes/web-client/testkit'
import { expect, it } from 'vitest'
import * as module from '../client/index.js'
import { coverage, health, impact, investigate } from '../src/domain.js'
import { seed } from '../src/seed.js'
const { client } = JSON.parse(
  await readFile(resolve('examples/showcase/aerospace-quality/client/agnes.client.json'), 'utf8'),
)
it('bilingual public profile pages render real domain evidence, filter gaps, surface failures and recover the same approval operation', async () => {
  for (const locale of ['zh-CN', 'en'] as const) {
    const state = seed(),
      effects: any[] = [],
      reads: string[] = []
    let fail = false,
      receiptState = 'approval-required'
    const identity = {
      packageId: '@agnes-showcase/aerospace-quality',
      rowId: 'ext:@agnes-showcase/aerospace-quality/main',
      revision: 'one',
      services: client.services,
      homeEntries: client.homeEntries,
      publicConfig: {},
      binding: {
        owner: 'ext:@agnes-showcase/aerospace-quality/main',
        packageId: '@agnes-showcase/aerospace-quality',
        lifetime: 'profile' as const,
        availability: 'active' as const,
        integrity: 'one',
        profileId: 'synthetic',
        activationId: 'one',
      },
    }
    const caller = async (_m: unknown, name: string, input: any, options: any) => {
      if (options?.read) {
        reads.push(options.operationId)
        return { state: receiptState, operationId: options.operationId }
      }
      if (fail) throw new Error('Synthetic service unavailable')
      if (name === 'aero.snapshot')
        return {
          output: { ...state, health: health(state), matrix: coverage(state), anomaly: investigate(state) },
        }
      if (name === 'aero.impact') return { output: impact(state, input.ecrId) }
      effects.push({ name, input, operationId: options.operationId })
      if (name === 'aero.propose') {
        state.rule.status = 'review'
        state.revision++
        return { state: 'completed', operationId: options.operationId }
      }
      return { state: receiptState, operationId: options.operationId }
    }
    let host = await createClientPanelTestHost(module, identity, caller as any, locale)
    try {
      for (const id of [
        'aero-home',
        'aero-requirements',
        'aero-tests',
        'aero-mrb',
        'aero-configuration',
        'aero-zeroing',
      ]) {
        await host.render(id)
        await host.act(async () => {})
        expect(host.container.querySelector('h1')?.textContent).toBeTruthy()
        expect(host.container.textContent).not.toContain('undefined')
      }
      await host.render('aero-requirements')
      await host.act(async () => {})
      const gaps = host.container.querySelector('input[type=radio][value=gaps]') as HTMLInputElement
      await host.act(async () => gaps.click())
      expect(host.container.textContent).toMatch(/CMP-030/)
      expect(host.container.textContent).not.toMatch(/CMP-002/)
      await host.render('aero-zeroing')
      await host.act(async () => {})
      const propose = [...host.container.querySelectorAll('button')].find((b) =>
        /^(提议筛选技能候选|Propose screening skill candidate)$/.test(b.textContent ?? ''),
      )!
      await host.act(async () => propose.click())
      expect(effects.at(-1).name).toBe('aero.propose')
      const approve = [...host.container.querySelectorAll('button')].find((b) =>
        /^(请求人工审核并启用|Request human review and activation)$/.test(b.textContent ?? ''),
      )!
      await host.act(async () => approve.click())
      const original = effects.at(-1)
      expect(original.name).toBe('aero.decide')
      expect(host.container.textContent).toMatch(/等待宿主人工审批|Awaiting Host human approval/)
      expect(host.window.sessionStorage.length).toBe(1)
      const storage = host.window.sessionStorage.getItem(host.window.sessionStorage.key(0)!)!
      const storageKey = host.window.sessionStorage.key(0)!
      await host.dispose()
      host = await createClientPanelTestHost(module, identity, caller as any, locale)
      host.window.sessionStorage.setItem(storageKey, storage)
      await host.render('aero-zeroing')
      await host.act(async () => {})
      expect(reads.at(-1)).toBe(original.operationId)
      expect(effects.filter((e) => e.name === 'aero.decide')).toHaveLength(1)
      // An unmounted request can acknowledge its final receipt and clear tab storage.
      // The current page must still reconcile the operation it already knows.
      host.window.sessionStorage.removeItem(storageKey)
      receiptState = 'refused'
      const check = [...host.container.querySelectorAll('button')].find((b) =>
        /查询并继续原操作|Check and continue operation/.test(b.textContent ?? ''),
      )!
      await host.act(async () => check.click())
      expect(host.window.sessionStorage.length).toBe(0)
      fail = true
      const refresh = [...host.container.querySelectorAll('button')].find((b) =>
        /^(刷新|Refresh)$/.test(b.textContent ?? ''),
      )!
      await host.act(async () => refresh.click())
      expect(host.container.querySelector('[role=alert]')?.textContent).toContain(
        'Synthetic service unavailable',
      )
    } finally {
      await host.dispose()
    }
  }
})
