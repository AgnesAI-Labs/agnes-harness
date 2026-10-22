import { Button, Table } from '@agnes/web-ui'
import React from 'react'
import { fact, guided, h, Markdown, openWork, time } from './board.js'
import { entryFile, evidenceDocs, latestRuns, showDelivery } from './delivery.js'

/** The Markdown body of a deliverable: seed documents ship in the package, live ones are the cached copy. */
export function ArtifactPreview({ board, artifact }) {
  const [doc, setDoc] = React.useState(null)
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    let live = true
    setDoc(null)
    setError('')
    board
      .query('devboard.artifact', { artifactId: artifact.id })
      .then((d) => live && (d.ok === false ? setError(d.error) : setDoc(d)))
      .catch((e) => live && setError(String(e?.message ?? e)))
    return () => {
      live = false
    }
  }, [artifact.id, artifact.updatedAt, board.query])
  return h(
    'div',
    { className: 'devboard-detail' },
    h(
      'p',
      { className: 'devboard-muted' },
      artifact.source?.type === 'workspace' ? `工作区文件：${artifact.source.path}` : '种子文档（包内）',
    ),
    error && h('p', { className: 'devboard-alert', role: 'alert' }, error),
    doc?.truncated && h('p', { className: 'devboard-muted' }, '文档较长，仅显示前 48 KB。'),
    doc ? h(Markdown, { text: doc.markdown }) : !error && h('p', { role: 'status' }, '正在读取文档…'),
  )
}

/** A document that is read only once it is opened. */
function EvidenceDoc({ board, artifact }) {
  const [open, setOpen] = React.useState(false)
  return h(
    'details',
    { className: 'devboard-evidence', onToggle: (e) => setOpen(e.currentTarget.open) },
    h('summary', null, `${artifact.title} ${artifact.version}`),
    open && h(ArtifactPreview, { board, artifact }),
  )
}

/** 交付成果: the app entry and how to start it, the latest test runs, the evidence documents and the app address. */
export function DeliveryCard({ data, board, project }) {
  if (!showDelivery(data, project)) return null
  const runs = latestRuns(data, project.id)
  const app = project.appUrl
    ? h(
        React.Fragment,
        null,
        h('a', { href: project.appUrl, target: '_blank', rel: 'noreferrer' }, project.appUrl),
        h(
          'small',
          { className: 'devboard-muted' },
          ` 仅在登记它的那次运行期间可访问（登记于 ${time(project.appRegisteredAt)}）；服务停止后请重新启动。`,
        ),
      )
    : '尚未登记运行地址'
  return guided(
    'projects-delivery',
    h(
      'section',
      { className: 'devboard-delivery', 'aria-label': '交付成果' },
      h('h3', null, '交付成果'),
      h(
        'dl',
        { className: 'devboard-facts' },
        fact('应用入口文件', entryFile(project)),
        fact(
          '启动方式',
          '在项目目录运行 node server.js；由研发协调员经命令审批启动，服务接管 Host 交接的 loopback 监听器',
        ),
        fact('运行地址', app),
      ),
      h(
        'div',
        { className: 'devboard-buttons' },
        h(
          Button,
          { onClick: () => openWork(board, 'run-app', { type: 'project', id: project.id }) },
          '启动并打开',
        ),
      ),
      h(Table, {
        captionRepeatsHeading: true,
        caption: '最近一次各级测试',
        rowKey: 'id',
        pagination: false,
        size: 'small',
        dataSource: runs,
        empty: '尚未登记测试运行',
        columns: [
          { title: '级别', dataIndex: 'level', render: (v) => data.labels.testLevel[v] ?? v, width: 100 },
          { title: '通过 / 总数', render: (_v, r) => `${r.passed} / ${r.total}`, width: 110 },
          { title: '失败', dataIndex: 'failed', width: 70 },
          { title: '跳过', dataIndex: 'skipped', width: 70 },
          { title: '时间', dataIndex: 'at', render: time, width: 140 },
          { title: '摘要', dataIndex: 'log' },
        ],
      }),
      evidenceDocs(data, project.id).map((artifact) => h(EvidenceDoc, { key: artifact.id, board, artifact })),
    ),
  )
}
