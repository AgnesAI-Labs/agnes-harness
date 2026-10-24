import type { PackageInstalledDescriptor } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import {
  blockerText,
  contributionText,
  installedState,
  operationName,
  runtimeStateLabel,
} from '../src/admin-text.js'
import { appServerErrorMessage } from '../src/app-server-errors.js'
import { adminLocaleCatalog } from '../src/locales/admin.js'
import { resourceDetailLocaleCatalog } from '../src/locales/resource-detail.js'
import { resourceListLocaleCatalog } from '../src/locales/resource-list.js'
import { resourceFailureCatalog, resourceFailureLabel } from '../src/resource-failure.js'
import { createCatalogTranslator } from '../src/ui-locale.js'

describe('admin text labels', () => {
  it('resolves operation names through the active locale', () => {
    expect(operationName('enable', createCatalogTranslator(adminLocaleCatalog, 'en'))).toBe('Enable')
    expect(operationName('enable', createCatalogTranslator(adminLocaleCatalog, 'zh-CN'))).toBe('启用')
  })

  it('resolves runtime states through the active locale', () => {
    const state = { packageId: 'acme/demo', revision: undefined, phase: 'idle' as const }
    expect(runtimeStateLabel(state, createCatalogTranslator(adminLocaleCatalog, 'en'))).toBe('Not loaded')
    expect(runtimeStateLabel(state, createCatalogTranslator(adminLocaleCatalog, 'zh-CN'))).toBe('未加载')
  })

  it('explains isolated Skill load failures in both locales without displaying exception text', () => {
    for (const locale of ['en', 'zh-CN'] as const) {
      const t = createCatalogTranslator(resourceFailureCatalog, locale)
      const labels = [
        'SKILL_ATTACHMENTS_LIMIT',
        'SKILL_ATTACHMENTS_UNREADABLE',
        'SKILL_DOCUMENT_INVALID',
        'SKILL_LOAD_FAILED',
      ].map((code) => resourceFailureLabel(code, t))
      expect(new Set(labels).size).toBe(4)
      for (const label of labels) {
        expect(label).toContain('Skill')
        expect(label).not.toContain('resource.error.')
      }
      expect(resourceFailureLabel('private path and exception', t)).toBe(t('resource.error.operation'))
    }
  })

  it('separates the overflow count from the first three contributions', () => {
    const item = {
      contributions: ['client', 'extension', 'skill', 'runtime'].map((kind, index) => ({
        kind,
        id: `item-${index}`,
      })),
    } as unknown as PackageInstalledDescriptor

    expect(contributionText(item, createCatalogTranslator(adminLocaleCatalog, 'en'))).toBe(
      'Browser UI · item-0, Extension · item-1, Skill · item-2, and 1 more',
    )
    expect(contributionText(item, createCatalogTranslator(adminLocaleCatalog, 'zh-CN'))).toBe(
      '浏览器 UI · item-0，扩展 · item-1，技能 · item-2，另有 1 项',
    )
  })

  it('maps installed-disabled to the supported disabled label', () => {
    const item = {
      desired: 'installed-disabled',
      actual: 'not-running',
      cleanupPending: false,
    } as PackageInstalledDescriptor

    expect(installedState(item, item.actual, createCatalogTranslator(adminLocaleCatalog, 'en'))).toBe(
      'Desired disabled · Not running',
    )
    expect(installedState(item, item.actual, createCatalogTranslator(adminLocaleCatalog, 'zh-CN'))).toBe(
      '期望停用 · 未运行',
    )
  })

  it('localizes blocker labels while preserving backend references', () => {
    const blocker = { code: 'policy' as const, references: ['policy/require-review'] }
    expect(blockerText(blocker, createCatalogTranslator(adminLocaleCatalog, 'en'))).toBe(
      'Security policy blocks this operation: policy/require-review',
    )
    expect(blockerText(blocker, createCatalogTranslator(adminLocaleCatalog, 'zh-CN'))).toBe(
      '安全策略阻止此操作：policy/require-review',
    )
  })

  it('gives incompatible packages an actionable reinstall message', () => {
    const blocker = {
      code: 'incompatible' as const,
      references: ['agnes-metadata', 'docs/guide/packages.md'],
    }
    expect(blockerText(blocker, createCatalogTranslator(adminLocaleCatalog, 'en'))).toContain(
      'Reinstall it, or ask its author to republish',
    )
    expect(blockerText(blocker, createCatalogTranslator(adminLocaleCatalog, 'zh-CN'))).toContain('请重新安装')
  })

  it('keeps English and Simplified Chinese admin keys paired', () => {
    expect(Object.keys(adminLocaleCatalog.en).sort()).toEqual(Object.keys(adminLocaleCatalog['zh-CN']).sort())
    expect(Object.keys(resourceListLocaleCatalog.en).sort()).toEqual(
      Object.keys(resourceListLocaleCatalog['zh-CN']).sort(),
    )
    expect(Object.keys(resourceDetailLocaleCatalog.en).sort()).toEqual(
      Object.keys(resourceDetailLocaleCatalog['zh-CN']).sort(),
    )
  })
})

it('localizes only schema message keys and ignores exception text and unknown keys', () => {
  const error = { message: 'private exception', data: { messageKey: 'appServer.errors.credentialRejected' } }
  expect(appServerErrorMessage(error, 'en')).toBe('The credential was rejected. Check it and try again.')
  expect(appServerErrorMessage(error, 'zh-CN')).toBe('凭据被拒绝。 请检查后重试。')
  for (const value of [
    { data: { messageKey: 'appServer.errors.__proto__' } },
    { message: 'private exception' },
    null,
  ])
    expect(appServerErrorMessage(value, 'en')).toBeUndefined()
})

it('renders schema-owned rejection reasons and actions in both locales without trusting server prose', () => {
  for (const code of [
    'E_PERMISSION_REVOKED',
    'APPROVAL_REJECTED',
    'BUDGET_EXCEEDED',
    'PLUGIN_TEST_REJECTED',
    'E_PACKAGE_BLOCKED',
  ]) {
    const error = { data: { code, publicReason: 'private reason', userAction: 'private action' } }
    const en = appServerErrorMessage(error, 'en')
    const zh = appServerErrorMessage(error, 'zh-CN')
    expect(en).toBeTruthy()
    expect(zh).toMatch(/[\u4e00-\u9fff]/)
    expect(zh).not.toBe(en)
    expect(en).not.toContain('private')
    expect(zh).not.toContain('private')
  }
  expect(
    appServerErrorMessage({ data: { code: 'UNKNOWN_DENIED', publicReason: 'private' } }, 'en'),
  ).toBeUndefined()
})

it('shows the diagnostic ID that the unconfirmed-operation copy tells the person to use', () => {
  const id = '474ff098-190d-4aab-8ebf-4fc5aee12097'
  const error = {
    code: -32603,
    message: 'INTERNAL_ERROR',
    data: { code: 'E_ADMIN_BACKEND', messageKey: 'appServer.errors.internal', diagnosticId: id },
  }
  expect(appServerErrorMessage(error, 'en')).toBe(
    `The operation could not be confirmed. Inspect its status using the diagnostic ID. Diagnostic ID: ${id}`,
  )
  expect(appServerErrorMessage(error, 'zh-CN')).toBe(
    `无法确认操作结果。 请使用诊断 ID 检查状态。 诊断 ID：${id}`,
  )
  // Malformed IDs never render; definite refusals retain their diagnostic ID too.
  expect(
    appServerErrorMessage({ ...error, data: { ...error.data, diagnosticId: 'x<b>' } }, 'en'),
  ).not.toContain('x<b>')
  expect(appServerErrorMessage({ data: { code: 'APPROVAL_REJECTED', diagnosticId: id } }, 'en')).toContain(id)
})
