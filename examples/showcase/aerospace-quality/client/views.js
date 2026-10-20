import { homeNavigation, openApplicationWork } from '@agnes/web-client'
import { Banner, Button, Chart, Drawer, SearchBar, Segmented, Table, Tag } from '@agnes/web-ui'
import React from 'react'
import { WorkButton } from './workbench.js'

const h = React.createElement
export const section = (title, children, className = '') =>
  h('section', { className: `aero-section ${className}` }, h('h2', null, title), children)
export function status(t, value) {
  return h(
    Tag,
    {
      tone: ['failed', 'critical', 'major', 'hold', 'quarantine'].includes(value)
        ? 'bad'
        : [
              'pending',
              'review',
              'draft',
              'verification-open',
              'untested',
              'missing-design',
              'at-risk',
            ].includes(value)
          ? 'warn'
          : 'info',
    },
    t.status(value),
  )
}
export const table = (caption, columns, rows, t, props = {}) =>
  h(Table, {
    caption,
    captionRepeatsHeading: true,
    rowKey: 'id',
    columns,
    dataSource: rows,
    empty: t.noRows,
    pagination: rows.length > 12 ? { pageSize: 12, showSizeChanger: false } : false,
    ...props,
  })
export const col = (title, dataIndex, extra = {}) => ({ title, dataIndex, key: dataIndex, ...extra })
export function Telemetry({ data, t }) {
  const c = data.campaigns[0]
  return section(
    t.choose('TC-026 · 驱动电流 / A', 'TC-026 · Drive current / A'),
    h(
      React.Fragment,
      null,
      h(
        'div',
        { className: 'aero-chart-note' },
        h(Tag, { tone: 'bad' }, '66–70 min'),
        t.choose(
          '冷平台异常窗口 · −40 °C · 上限 1.80 A',
          'Cold plateau anomaly window · −40 °C · Upper limit 1.80 A',
        ),
      ),
      h(
        'div',
        { className: 'aero-telemetry' },
        h('div', { className: 'aero-window', 'aria-hidden': true }),
        h(Chart, {
          chartType: 'line',
          title: t.anomaly,
          categoryKey: 'min',
          rows: c.samples.map((p) => ({
            min: p.minute,
            current: p.current,
            limit: p.limit,
          })),
          series: [
            { key: 'current', label: t.choose('驱动电流', 'Drive current') },
            { key: 'limit', label: t.choose('上限 1.80 A', 'Upper limit 1.80 A') },
          ],
          dataLabel: t.choose('查看原始测量值', 'View source measurements'),
          formatValue: (v) => (v == null ? '—' : Number(v).toFixed(3)),
        }),
      ),
    ),
    'aero-chart-section',
  )
}
export function Home({ data, t, navigate }) {
  const k = data.health
  const criteria = data.zeroing.flatMap((item) => item.criteria)
  const progress = (prefix) =>
    `${criteria.filter((row) => row.id.startsWith(prefix) && row.accepted).length}/${criteria.filter((row) => row.id.startsWith(prefix)).length}`
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'aero-kpis' },
      ...[
        [
          `${Math.round((k.verified / k.total) * 100)}%`,
          t.choose('需求验证覆盖', 'Requirements verified'),
          `${k.verified} / ${k.total}`,
        ],
        [
          k.ncrs,
          t.choose('未关闭 NCR', 'Open NCRs'),
          t.choose(
            `严重 ${k.bySeverity.critical} · 重大 ${k.bySeverity.major}`,
            `Critical ${k.bySeverity.critical} · Major ${k.bySeverity.major}`,
          ),
        ],
        [
          k.ecrs,
          t.choose('更改待审', 'ECRs under review'),
          t.choose('更改控制委员会', 'Change control board'),
        ],
        [
          k.zeroing,
          t.choose('质量归零进行中', 'Open zeroing items'),
          t.choose(
            `技术 ${progress('T')} · 管理 ${progress('M')}`,
            `Technical ${progress('T')} · Management ${progress('M')}`,
          ),
        ],
      ].map(([value, label, note]) =>
        h(
          'article',
          { className: 'aero-kpi', key: label },
          h('p', null, label),
          h('strong', null, value),
          h('small', null, note),
        ),
      ),
    ),
    h(
      'div',
      { className: 'aero-incident' },
      h(
        'div',
        null,
        h(Tag, { tone: 'bad' }, t.choose('质量关注 · 重大', 'Quality alert · Major')),
        h('h2', null, t.anomaly),
        h(
          'p',
          null,
          t.choose(
            `PVD-011 · BL-C · L2609-B。峰值 ${data.anomaly.peakA.toFixed(3)} A；已中止试验并隔离同批次器件。`,
            `PVD-011 · BL-C · L2609-B. Peak ${data.anomaly.peakA.toFixed(3)} A; test aborted and same-lot parts quarantined.`,
          ),
        ),
      ),
      h(
        Button,
        {
          appearance: 'primary',
          onClick: () => openApplicationWork('investigate', { type: 'anomaly', id: 'AN-027' }),
        },
        t.choose('调查异常', 'Investigate anomaly'),
      ),
    ),
    h(
      'nav',
      { className: 'aero-actions', 'aria-label': t.choose('业务模块', 'Business modules') },
      ...['aero-requirements', 'aero-tests', 'aero-mrb', 'aero-configuration', 'aero-zeroing'].map((id) =>
        h(Button, { key: id, onClick: () => homeNavigation.open(id) }, t.title(id)),
      ),
    ),
    h(
      'div',
      { className: 'aero-grid' },
      h(Telemetry, { data, t }),
      section(
        t.choose('近期里程碑', 'Upcoming milestones'),
        h(
          'ol',
          { className: 'aero-milestones' },
          ...data.milestones.map((m) =>
            h(
              'li',
              { key: m.date },
              h('time', null, m.date),
              h('strong', null, t.value(m.title)),
              status(t, m.status),
            ),
          ),
        ),
      ),
    ),
    section(
      t.choose('试验活动', 'Test campaigns'),
      table(
        t.choose('试验活动状态', 'Campaign status'),
        [
          col('ID', 'id'),
          col(t.choose('试验活动', 'Campaign'), 'title', { render: t.value }),
          col(t.choose('试件 / 基线', 'Unit / baseline'), 'unit', {
            render: (_, r) => `${r.unit} · ${r.configuration}`,
          }),
          col(t.choose('状态', 'Status'), 'status', { render: (v) => status(t, v) }),
        ],
        data.campaigns,
        t,
      ),
    ),
  )
}
export function Requirements({ data, t }) {
  const [filter, setFilter] = React.useState('all'),
    [query, setQuery] = React.useState('')
  const rows = data.matrix.filter(
    (r) =>
      (filter === 'all' || (filter === 'orphan' ? r.orphan : r.gap !== 'covered')) &&
      `${r.id} ${t.value(r.title)}`.toLowerCase().includes(query.toLowerCase()),
  )
  return h(
    React.Fragment,
    null,
    h(SearchBar, {
      label: t.choose('搜索需求', 'Search requirements'),
      value: query,
      onChange: setQuery,
      placeholder: 'CMP-001',
      filters: h(Segmented, {
        label: t.choose('覆盖筛选', 'Coverage filter'),
        value: filter,
        onChange: setFilter,
        options: ['all', 'gaps', 'orphan'].map((value) => ({ value, label: t[value] })),
      }),
    }),
    section(
      t.choose('需求 ↔ 设计 ↔ 验证', 'Requirement ↔ Design ↔ Verification'),
      table(
        t.choose('追溯矩阵', 'Traceability matrix'),
        [
          col('ID', 'id', { width: 130 }),
          col(t.choose('需求 / 上级', 'Requirement / parent'), 'title', {
            width: 310,
            ellipsis: false,
            render: (v, r) =>
              h(
                'div',
                null,
                t.value(v),
                h('small', { className: 'aero-meta' }, r.parent ?? (r.orphan ? t.orphan : 'SYSTEM')),
              ),
          }),
          col(t.choose('方法', 'Method'), 'method', { render: (v) => t.status(v) }),
          col(t.choose('设计证据', 'Design evidence'), 'design', { render: (v) => v.join(', ') || '—' }),
          col(t.choose('验证用例', 'Verification case'), 'tests', { render: (v) => v.join(', ') || '—' }),
          col(t.choose('覆盖', 'Coverage'), 'gap', {
            render: (v, r) => h('div', null, status(t, v), r.orphan && h(Tag, { tone: 'warn' }, t.orphan)),
          }),
        ],
        rows,
        t,
      ),
    ),
  )
}
export function Tests({ data, t }) {
  const [detail, setDetail] = React.useState(false)
  return h(
    React.Fragment,
    null,
    h(
      Banner,
      { tone: 'warning' },
      t.choose(
        '异常分析不等于原因确认。复现、失效分析与措施有效性验证尚未完成。',
        'Investigation is not cause confirmation. Reproduction, failure analysis and effectiveness verification remain open.',
      ),
    ),
    h(
      'div',
      { className: 'aero-grid' },
      h(Telemetry, { data, t }),
      section(
        t.anomaly,
        h(
          React.Fragment,
          null,
          h(
            'dl',
            { className: 'aero-facts' },
            ...[
              [t.choose('试件', 'Unit'), 'PVD-011'],
              [t.choose('批次 / 基线', 'Lot / baseline'), 'L2609-B / BL-C'],
              [t.choose('峰值 / 限值', 'Peak / limit'), `${data.anomaly.peakA.toFixed(3)} / 1.800 A`],
              [t.choose('温度 / 真空度', 'Temperature / vacuum'), '−40 °C / 3×10⁻⁵ Pa'],
            ].map(([k, v]) => h('div', { key: k }, h('dt', null, k), h('dd', null, v))),
          ),
          h(Button, { appearance: 'primary', onClick: () => setDetail(true) }, t.detail),
          h(WorkButton, { action: 'investigate', object: { type: 'anomaly', id: 'AN-027' }, t }),
        ),
      ),
    ),
    section(
      t.choose('试验日志', 'Run log'),
      h(
        'ul',
        { className: 'aero-log' },
        ...data.campaigns[0].logs.map((r) =>
          h('li', { key: r.at }, h('code', null, r.at), t.value(r.message)),
        ),
      ),
    ),
    section(
      t.choose('活动与证据', 'Campaigns and evidence'),
      table(
        t.choose('活动明细', 'Campaign details'),
        [
          col('ID', 'id'),
          col(t.choose('活动', 'Campaign'), 'title', { render: t.value }),
          col(t.choose('批次', 'Lot'), 'lot'),
          col(t.choose('状态', 'Status'), 'status', { render: (v) => status(t, v) }),
        ],
        data.campaigns,
        t,
      ),
    ),
    h(
      Drawer,
      {
        open: detail,
        onClose: () => setDetail(false),
        title: t.anomaly,
        closeLabel: t.close,
        description: t.hypothesis,
      },
      h('p', null, t.value(data.anomaly.hypothesis)),
      section(
        t.choose('关联链', 'Correlation chain'),
        h('ol', null, ...data.anomaly.evidence.map((id) => h('li', { key: id }, h('code', null, id)))),
      ),
      section(
        t.choose('替代解释', 'Alternative explanations'),
        h(
          'ul',
          null,
          ...data.anomaly.alternatives.map((x) => h('li', { key: x }, x.split(' / ')[t.zh ? 1 : 0])),
        ),
      ),
      section(
        t.choose('复现计划', 'Reproduction plan'),
        h(
          'ol',
          null,
          ...data.anomaly.reproduction.map((x) => h('li', { key: x }, x.split(' / ')[t.zh ? 1 : 0])),
        ),
      ),
    ),
  )
}
