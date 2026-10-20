import { readFile } from 'node:fs/promises'
import { applicationIdentity, homeNavigation, type ModuleIdentity } from '@agnes/web-client'
import { createClientPanelTestHost } from '@agnes/web-client/testkit'
import { renderRegion, unmountRegion } from '@agnes/web-ui'
import { createElement } from 'react'
import { expect, it } from 'vitest'
import { apply } from '../client/index.js'
import { words } from '../client/locale.js'
import { ObjectDossier } from '../client/workbench.js'
import { dashboard, dossier } from '../src/quality.js'
import { seed } from '../src/seed.js'

const declaration = JSON.parse(
  await readFile(new URL('../client/agnes.client.json', import.meta.url), 'utf8'),
).client
const identity: ModuleIdentity = {
  packageId: '@agnes-showcase/pharma-gmp',
  rowId: 'ext:@agnes-showcase/pharma-gmp/main',
  revision: 'one',
  services: declaration.services,
  homeEntries: declaration.homeEntries,
  publicConfig: {},
  binding: {
    owner: 'ext:@agnes-showcase/pharma-gmp/main',
    packageId: '@agnes-showcase/pharma-gmp',
    lifetime: 'profile',
    availability: 'active',
    integrity: 'one',
    profileId: 'test',
    activationId: 'current',
  },
}
it.each(['zh-CN', 'en'] as const)(
  'renders eight declared profile pages and preserves an approval operation across unmount (%s)',
  async (locale) => {
    const plant = seed(),
      data = { plant, kpi: dashboard(plant), dossiers: plant.batches.map((b) => dossier(plant, b.id)) }
    const calls: { kind: string; operationId?: string; input?: Record<string, unknown> }[] = []
    let fail = true
    const host = await createClientPanelTestHost(
      { apply },
      identity,
      async (_module, service, input, options) => {
        const kind = options?.read ? 'operation' : options?.operationId ? 'effect' : 'query'
        calls.push({
          kind,
          ...(options?.operationId ? { operationId: options.operationId } : {}),
          ...(input ? { input } : {}),
        })
        if (kind === 'query') {
          if (fail) {
            fail = false
            throw new Error('Transient read')
          }
          return { output: data }
        }
        return { operationId: options?.operationId, state: 'approval-required' }
      },
      locale,
    )
    try {
      await host.render('pharma-home')
      expect(host.container.textContent).toContain('Transient read')
      const refresh = host.container.querySelector('button')!
      await host.act(async () => refresh.click())
      expect(host.container.textContent).toContain('B-2410-017')
      const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
      await host.act(async () =>
        applicationIdentity.set({
          revision: 1,
          status: 'active',
          assets: {},
          candidates: [],
          selection: {
            packageId: identity.packageId,
            applicationId: 'sableleaf-quality',
            integrity: 'one',
            declarationDigest: 'a'.repeat(64),
            consentDigest: 'b'.repeat(64),
            bindingDigest: 'c'.repeat(64),
          },
          effective: manifest.agnes.application,
        }),
      )
      const work = Array.from(host.container.querySelectorAll('button')).find(
        (button) => button.textContent === (locale === 'en' ? 'Investigate deviation' : '调查偏差'),
      )!
      expect(work.disabled).toBe(false)
      await host.act(async () => work.click())
      expect(homeNavigation.getSnapshot()).toMatchObject({
        id: 'agents',
        selection: {
          workAction: { actionId: 'investigate', object: { type: 'deviation', id: 'DEV-2410-017' } },
        },
      })
      homeNavigation.close()
      expect(host.container.querySelector('.ph-alert-copy')?.textContent).toContain(
        locale === 'en' ? 'Historical originals' : '原始历史发现',
      )
      for (const page of ['batches', 'deviations', 'em', 'release', 'audit', 'tasks', 'object', 'home']) {
        await host.render(`pharma-${page}`)
        expect(host.container.querySelector(`[data-pharma-page="${page}"]`)).not.toBeNull()
      }
      const panel = host.window.document.createElement('div')
      host.window.document.body.append(panel)
      try {
        const objects = [
          { type: 'batch', id: 'B-2410-017' },
          { type: 'deviation', id: 'DEV-2410-017' },
          { type: 'capa', id: plant.deviations.find((d) => d.actions.length)!.actions[0]!.id },
          { type: 'em', id: 'EM-0017' },
          { type: 'batch', id: 'missing' },
          { type: 'unknown', id: 'B-2410-017' },
        ]
        for (const object of objects) {
          renderRegion(
            panel as unknown as HTMLElement,
            createElement(ObjectDossier, {
              data,
              t: words[locale],
              locale,
              context: { selection: { object } },
            }),
          )
          expect(Boolean(panel.querySelector('[data-testid="pharma-object-dossier"]'))).toBe(
            object.id !== 'missing' && object.type !== 'unknown',
          )
          expect(panel.textContent).not.toContain('undefined')
          if (object.type === 'em') expect(panel.textContent).toContain('72')
          if (object.type === 'batch' && object.id !== 'missing') expect(panel.textContent).toContain('3.4 %')
        }
        const released = plant.batches.find((batch) => batch.certificate)!
        for (const mode of ['manual', 'auto-confirmed under full access', undefined]) {
          const proofData = {
            ...data,
            plant: {
              ...plant,
              batches: plant.batches.map((batch) =>
                batch.id === released.id
                  ? { ...batch, certificate: { ...released.certificate!, confirmationMode: mode } }
                  : batch,
              ),
            },
          }
          renderRegion(
            panel as unknown as HTMLElement,
            createElement(ObjectDossier, {
              data: proofData,
              t: words[locale],
              locale,
              context: { selection: { object: { type: 'batch', id: released.id } } },
            }),
          )
          const label = panel.querySelector('.ph-card [data-business-confirmation]')?.textContent
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
        unmountRegion(panel as unknown as HTMLElement)
        panel.remove()
      }
      await host.render('pharma-release')
      const release = Array.from(host.container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(locale === 'en' ? 'sign release' : '签署放行'),
      )!
      expect(release.disabled).toBe(true)
      const certificate = plant.batches.find((row) => row.certificate)?.certificate
      if (!certificate) throw new Error('Missing synthetic certificate')
      const signedBatch = plant.batches.find((row) => row.id === 'B-2410-017')!
      for (const mode of ['manual', 'auto-confirmed under full access', undefined, 'unknown']) {
        signedBatch.certificate = { ...certificate, signer: 'qa.recorded' }
        if (mode === undefined) delete signedBatch.certificate.confirmationMode
        else signedBatch.certificate.confirmationMode = mode
        data.dossiers = plant.batches.map((b) => dossier(plant, b.id))
        plant.audit.push({
          ...plant.audit[0]!,
          actor: 'qa.recorded',
          approval: 'recorded-proof',
          ...(mode === undefined ? {} : { confirmationMode: mode }),
        })
        const expected =
          mode === 'manual'
            ? locale === 'en'
              ? 'Signed by qa.recorded'
              : '已由真人签署: qa.recorded'
            : mode === 'auto-confirmed under full access'
              ? locale === 'en'
                ? 'Auto-confirmed under full access (principal qa.recorded)'
                : '完全访问下自动确认（主体 qa.recorded）'
              : locale === 'en'
                ? 'Confirmation mode not recorded (principal qa.recorded)'
                : '确认方式未记录（主体 qa.recorded）'
        for (const page of ['release', 'audit']) {
          await host.render('pharma-home')
          await host.render(`pharma-${page}`)
          expect(host.container.textContent).toContain(expected)
          if (mode !== 'manual')
            expect(host.container.textContent).not.toContain(
              locale === 'en' ? 'Signed by qa.recorded' : '已由真人签署: qa.recorded',
            )
        }
        plant.audit.pop()
      }
      signedBatch.certificate = null
      data.dossiers = plant.batches.map((b) => dossier(plant, b.id))
      await host.render('pharma-deviations')
      const investigate = Array.from(host.container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes(locale === 'en' ? 'Request investigation' : '申请启动调查'),
      )!
      await host.act(async () => investigate.click())
      expect(calls.some((r) => r.kind === 'effect')).toBe(true)
      expect(host.window.sessionStorage.length).toBe(1)
      await host.render('pharma-batches')
      await host.render('pharma-deviations')
      expect(calls.some((r) => r.kind === 'operation')).toBe(true)
      expect(host.window.sessionStorage.length).toBe(1)
      expect(calls.find((r) => r.kind === 'operation')?.operationId).toBe(
        calls.find((r) => r.kind === 'effect')?.operationId,
      )
      plant.batches.find((batch) => batch.id === 'B-2410-017')!.status = 'released'
      await host.render('pharma-home')
      expect(host.container.querySelector('.ph-alert-state')?.textContent).toContain(
        locale === 'en' ? 'Released' : '已放行',
      )
    } finally {
      await host.act(async () => applicationIdentity.set(undefined))
      homeNavigation.close()
      await host.dispose()
    }
  },
  30000,
)
