import { workbenchPanels } from '@agnes/web-client'
import {
  Button,
  EmptyState,
  reportSuccess,
  Segmented,
  Select,
  SettingsTextArea,
  StatusMessage,
} from '@agnes/web-ui'
import { createElement as h, useState, useSyncExternalStore } from 'react'
import { compare, report } from './contract.mjs'

export function createReportStore() {
  let snapshot = { baseline: null, candidate: null }
  const listeners = new Set()
  return {
    read: () => snapshot,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    put(side, value) {
      snapshot = { ...snapshot, [side]: report(value) }
      for (const fn of listeners) fn()
    },
    clear() {
      snapshot = { baseline: null, candidate: null }
      for (const fn of listeners) fn()
    },
  }
}
export function EvalPage({ ctx, store }) {
  const [side, setSide] = useState('baseline'),
    [draft, setDraft] = useState(''),
    [error, setError] = useState(false),
    [selected, select] = useState()
  const data = useSyncExternalStore(store.subscribe, store.read)
  useSyncExternalStore(ctx.locale.subscribe ?? (() => () => {}), () => ctx.locale.locale)
  const zh = ctx.locale.locale === 'zh-CN'
  const t = (en, cn) => (zh ? cn : en)
  const current = data[side]
  let comparison,
    incompatible = false
  if (data.baseline && data.candidate) {
    try {
      comparison = compare(data.baseline, data.candidate)
    } catch {
      incompatible = true
    }
  }
  const row = current?.cases.find((c) => c.id === selected) ?? current?.cases[0]
  const outcome = (value) =>
    ({
      pass: t('Pass', '通过'),
      fail: t('Fail', '失败'),
      unknown: t('Unknown', '未知'),
      skipped: t('Skipped', '未运行'),
    })[value] ?? value
  function load() {
    try {
      store.put(side, draft)
      setError(false)
      reportSuccess('eval-import', t('Report imported locally', '报告已导入本页'))
    } catch {
      setError(true)
    }
  }
  function download() {
    const blob = new Blob([JSON.stringify(comparison ?? current, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob),
      a = document.createElement('a')
    a.href = url
    a.download = comparison ? 'eval-comparison.json' : 'eval-report.json'
    a.click()
    URL.revokeObjectURL(url)
    reportSuccess('eval-export', t('Export prepared', '导出已准备'))
  }
  return h(
    'section',
    { 'aria-label': t('Evaluation', '评测') },
    h('h2', null, t('Evaluation', '评测')),
    h(
      'p',
      null,
      t(
        'Paste an explicitly selected offline runner report. Imported evidence is unverified; no model or tool runs on this page. Nothing is uploaded or saved between activations.',
        '粘贴明确选定的离线 runner 报告。导入证据未经验证；本页不运行模型或工具，不上传内容，停用后清空。',
      ),
    ),
    h(Segmented, {
      label: t('Report side', '报告分组'),
      value: side,
      options: [
        { value: 'baseline', label: t('Baseline', '基线') },
        { value: 'candidate', label: t('Candidate', '候选') },
      ],
      onChange: setSide,
    }),
    h(SettingsTextArea, {
      'aria-label': t('Report JSON', '报告 JSON'),
      value: draft,
      rows: 5,
      maxLength: 1048576,
      onChange: (e) => setDraft(e.target.value),
    }),
    h(Button, { onClick: load }, t('Import report', '导入报告')),
    h(
      Button,
      {
        onClick: () => {
          store.clear()
          setDraft('')
          setError(false)
        },
      },
      t('Clear', '清空'),
    ),
    error &&
      h(
        StatusMessage,
        { kind: 'error' },
        t(
          'Cannot import: use a bounded v1 eval report and retry.',
          '无法导入：请检查 v1 评测报告格式和大小后重试。',
        ),
      ),
    incompatible &&
      h(
        StatusMessage,
        { kind: 'error' },
        t(
          'Dataset inputs differ. Import reports for the same cases before comparing.',
          '数据集输入不同。请导入相同案例的报告后比较。',
        ),
      ),
    !current &&
      h(EmptyState, {
        icon: '◇',
        title: t('No report imported', '尚未导入报告'),
        description: t('Paste a v1 report to inspect cases.', '粘贴 v1 报告以检查案例。'),
      }),
    current &&
      h(
        'div',
        null,
        h(
          'p',
          null,
          `${current.variant}: ${outcome(current.status)} · ${current.executed}/${current.total} · ${current.dataset.replay}`,
        ),
        h('p', null, t('Hashes, seed and budget', '哈希、seed 和预算')),
        h(
          'pre',
          null,
          JSON.stringify(
            { hashes: current.dataset.hashes, seed: current.dataset.seed, budget: current.dataset.budget },
            null,
            2,
          ),
        ),
        h(Select, {
          'aria-label': t('Case', '案例'),
          value: row?.id,
          options: current.cases.map((c) => ({ value: c.id, label: c.id })),
          onChange: select,
        }),
        row &&
          h(
            'div',
            null,
            h(
              'p',
              null,
              `${t('Executed', '执行数')}: ${row.executed} · ${t('Tokens', 'Token')}: ${row.tokens ?? t('Unknown', '未知')}`,
            ),
            ...['structure', 'effects', 'budget'].map((k) =>
              h(
                'p',
                { key: k },
                `${{ structure: t('Structure', '结构'), effects: t('Fixture effects', 'Fixture 效果'), budget: t('Budget', '预算') }[k]}: ${outcome(row.checks[k])}`,
              ),
            ),
            h(
              'p',
              null,
              `${t('Judge', '独立评分')}: ${outcome(row.judge.status)} · ${t('Cost', '费用')}: ${row.judge.cost ?? t('Unknown', '未知')}`,
            ),
            h(
              'pre',
              null,
              JSON.stringify(comparison?.differences.find((c) => c.id === row.id) ?? row, null, 2),
            ),
          ),
        h(Button, { disabled: incompatible, onClick: download }, t('Export JSON', '导出 JSON')),
      ),
  )
}
export default {
  inject: ['locale'],
  apply(ctx) {
    const store = createReportStore()
    const Page = () => h(EvalPage, { ctx, store })
    const stops = []
    try {
      stops.push(
        ctx.locale.register('eval-studio', {
          en: { 'eval-studio.title': 'Evaluation' },
          'zh-CN': { 'eval-studio.title': '评测' },
        }),
      )
      stops.push(
        ctx.homeEntries.register({
          id: 'eval-studio',
          icon: 'chart',
          titleKey: 'eval-studio.title',
          order: 70,
          placement: 'primary',
          component: Page,
        }),
      )
      stops.push(
        workbenchPanels.register({
          id: 'eval-studio',
          titleKey: 'eval-studio.title',
          title: () => (ctx.locale.locale === 'zh-CN' ? '评测' : 'Evaluation'),
          order: 70,
          edge: 'right',
          component: Page,
        }),
      )
    } catch (error) {
      for (const stop of stops.reverse()) stop()
      throw error
    }
    ctx.effect(() => () => {
      for (const stop of stops.reverse()) stop()
      store.clear()
    })
  },
}
