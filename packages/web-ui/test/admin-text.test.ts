import type { PackageInstalledDescriptor } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import {
  blockerText,
  contributionText,
  installedState,
  operationName,
  runtimeStateLabel,
} from '../src/admin-text.js'
import { adminLocaleCatalog } from '../src/locales/admin.js'
import { resourceDetailLocaleCatalog } from '../src/locales/resource-detail.js'
import { resourceListLocaleCatalog } from '../src/locales/resource-list.js'
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
