/** @vitest-environment happy-dom */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createClientPanelTestHost } from '@agnes/web-client/testkit'
import { renderRegion, unmountRegion } from '@agnes/web-ui'
import { createElement } from 'react'
import { expect, it } from 'vitest'
import { language } from '../client/i18n.js'
import * as module from '../client/index.js'
import { ObjectDossier, Tasks } from '../client/workbench.js'
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
      const dossier = host.window.document.createElement('div')
      host.window.document.body.append(dossier)
      try {
        for (const id of ['AN-027', 'AN-missing']) {
          renderRegion(
            dossier as unknown as HTMLElement,
            createElement(ObjectDossier, {
              data: { ...state, anomaly: investigate(state) },
              t: language(locale),
              context: { selection: { object: { type: 'anomaly', id } } },
            }),
          )
          expect(dossier.textContent?.includes('2.227')).toBe(id === 'AN-027')
          expect(dossier.querySelector('[data-testid="aero-object-dossier"]') !== null).toBe(id === 'AN-027')
        }
        for (const mode of ['manual', 'auto-confirmed under full access', undefined]) {
          renderRegion(
            dossier as unknown as HTMLElement,
            createElement(ObjectDossier, {
              data: {
                ...state,
                anomaly: investigate(state),
                ncrs: state.ncrs.map((record) =>
                  record.id === 'NCR-018' ? { ...record, approvals: ['synthetic-decision'] } : record,
                ),
                audit: [
                  { approval: 'synthetic-decision', confirmationMode: mode, signer: 'Synthetic operator' },
                ],
              },
              t: language(locale),
              context: { selection: { object: { type: 'ncr', id: 'NCR-018' } } },
            }),
          )
          const label = dossier.querySelector('[data-business-confirmation]')?.textContent
          expect(label).toContain(
            mode === 'manual'
              ? locale === 'en'
                ? 'Signed by'
                : '已由真人签署'
              : mode
                ? locale === 'en'
                  ? 'Auto-confirmed under full access'
                  : '完全访问下自动确认'
                : locale === 'en'
                  ? 'Confirmation mode not recorded'
                  : '确认方式未记录',
          )
        }
      } finally {
        unmountRegion(dossier as unknown as HTMLElement)
        dossier.remove()
      }
      for (const id of [
        'aero-home',
        'aero-object',
        'aero-tasks',
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
        if (id === 'aero-home') {
          const action = [...host.container.querySelectorAll('button')].find((button) =>
            /^(调查异常|Investigate anomaly)$/.test(button.textContent ?? ''),
          )
          expect(action?.disabled).toBe(true)
        }
      }
      await host.render('aero-requirements')
      await host.act(async () => {})
      const gaps = host.container.querySelector('input[type=radio][value=gaps]')
      await host.act(async () => {
        if (!gaps || !('click' in gaps) || typeof gaps.click !== 'function')
          throw new Error('Gap filter missing')
        gaps.click()
      })
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
      fail = false
      state.ncrs.find((row) => row.id === 'NCR-018')!.approvals = ['mrb-proof']
      state.ecrs.find((row) => row.id === 'ECR-016')!.approvals = ['config-proof']
      state.rule.approval = 'rule-proof'
      for (const mode of ['manual', 'auto-confirmed under full access', undefined, 'unknown']) {
        state.audit = ['mrb-proof', 'config-proof', 'rule-proof'].map((approval) => ({
          id: approval,
          at: '2026-10-20',
          action: 'approve',
          subject: approval,
          revision: 2,
          approval,
          signer: 'recorded.principal',
          ...(mode === undefined ? {} : { confirmationMode: mode }),
        }))
        state.zeroing[0]!.closure = {
          decisionId: 'closure-proof',
          signer: 'recorded.principal',
          confirmationMode: mode ?? '',
          reviewedRevision: 2,
          subjectRevision: 'digest',
        }
        const expected =
          mode === 'manual'
            ? locale === 'en'
              ? 'Signed by recorded.principal'
              : '已由真人签署: recorded.principal'
            : mode === 'auto-confirmed under full access'
              ? locale === 'en'
                ? 'Auto-confirmed under full access (principal recorded.principal)'
                : '完全访问下自动确认（主体 recorded.principal）'
              : locale === 'en'
                ? 'Confirmation mode not recorded (principal recorded.principal)'
                : '确认方式未记录（主体 recorded.principal）'
        for (const page of ['mrb', 'configuration', 'zeroing']) {
          await host.render('aero-home')
          await host.render(`aero-${page}`)
          await host.act(async () => {})
          expect(host.container.textContent).toContain(expected)
          if (mode !== 'manual')
            expect(host.container.textContent).not.toContain(
              locale === 'en' ? 'Signed by recorded.principal' : '已由真人签署: recorded.principal',
            )
        }
        const dossier = host.window.document.createElement('div')
        host.window.document.body.append(dossier)
        try {
          for (const object of [
            { type: 'ncr', id: 'NCR-018' },
            { type: 'ecr', id: 'ECR-016' },
            { type: 'zeroing', id: state.zeroing[0]!.id },
          ]) {
            renderRegion(
              dossier as unknown as HTMLElement,
              createElement(ObjectDossier, {
                data: state,
                t: language(locale),
                context: { selection: { object } },
              }),
            )
            expect(dossier.textContent).toContain(expected)
            if (mode !== 'manual')
              expect(dossier.textContent).not.toContain(
                locale === 'en' ? 'Signed by recorded.principal' : '已由真人签署: recorded.principal',
              )
          }
          renderRegion(
            dossier as unknown as HTMLElement,
            createElement(Tasks, { data: state, t: language(locale) }),
          )
          expect(dossier.textContent).toContain(expected)
          if (mode !== 'manual')
            expect(dossier.textContent).not.toContain(
              locale === 'en' ? 'Signed by recorded.principal' : '已由真人签署: recorded.principal',
            )
        } finally {
          unmountRegion(dossier as unknown as HTMLElement)
          dossier.remove()
        }
      }
    } finally {
      await host.dispose()
    }
  }
})
