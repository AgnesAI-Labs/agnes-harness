import type { UINode } from '@agnes/protocol'
import type { UiExtensionContext } from '@agnes/web-client'
import type { WorkbenchContext } from '@agnes/web-conversation/workbench'
import { Button, Disclosure, EmptyState, Icon, Tag, useDocumentLanguage } from '@agnes/web-ui'
import { useEffect, useState } from 'react'

type ToolNode = Extract<UINode, { kind: 'tool' }>
function EvidenceRecord({ node, context, zh }: { node: ToolNode; context: UiExtensionContext; zh: boolean }) {
  const data = context.data as WorkbenchContext
  const [output, setOutput] = useState<unknown>()
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setOutput(undefined)
    setError('')
    if (!data.session || node.resultSeq === undefined) return
    void data.session.readToolDetail(node.seq, node.resultSeq).then(
      (detail) => {
        if (live) setOutput(detail.result?.structured ?? detail.result?.content)
      },
      () => {
        if (live)
          setError(
            zh ? '完整回执暂不可用，请查看执行记录。' : 'Full receipt unavailable; inspect execution record.',
          )
      },
    )
    return () => {
      live = false
    }
  }, [data.session, node.seq, node.resultSeq, zh])
  const record = output && typeof output === 'object' && 'data' in output ? output.data : output
  const paths =
    record && typeof record === 'object' && 'paths' in record && Array.isArray(record.paths)
      ? record.paths.filter((path): path is string => typeof path === 'string')
      : []
  const title =
    record && typeof record === 'object' && 'title' in record && typeof record.title === 'string'
      ? record.title
      : node.summary
  return (
    <article>
      <h3>{title || node.name}</h3>
      <Tag tone={node.status === 'failed' ? 'bad' : 'info'}>
        {node.status === 'completed' ? (zh ? '已完成' : 'Completed') : node.status}
      </Tag>
      <p>
        <code>{node.name}</code> · {zh ? '工具回执' : 'Tool receipt'} #{node.resultSeq}
      </p>
      {paths.map((path) => (
        <Button key={path} onClick={() => context.openPanel?.('files', { path })}>
          {path.split('/').at(-1)}
        </Button>
      ))}
      {error && <p role="status">{error}</p>}
      <Disclosure summary={zh ? '查看完整证据内容' : 'View full evidence'}>
        <pre>{output === undefined ? node.resultPreview : JSON.stringify(output, null, 2)}</pre>
      </Disclosure>
      <Button onClick={() => data.session && context.openRecord?.(data.session.id, node.seq, node.resultSeq)}>
        {zh ? '查看来源与审批' : 'Inspect provenance and approval'}
      </Button>
    </article>
  )
}
export function ApplicationEvidence({ context }: { context: UiExtensionContext }) {
  const data = context.data as WorkbenchContext
  const zh = useDocumentLanguage() === 'zh-CN'
  const tools =
    data.timeline?.nodes.filter(
      (node): node is ToolNode => node.kind === 'tool' && node.resultSeq !== undefined,
    ) ?? []
  return (
    <section className="application-panel" aria-label={zh ? '证据与报告' : 'Evidence and reports'}>
      {tools.length === 0 && (
        <EmptyState
          icon={<Icon name="file-text" />}
          title={zh ? '工具产出的证据与报告将显示在这里' : 'Tool evidence and reports appear here'}
          description={
            zh
              ? '完成业务工具或报告后，可以查看其来源。'
              : 'Inspect the sources after a business tool or report completes.'
          }
        />
      )}
      {tools.map((node) => (
        <EvidenceRecord key={node.id} node={node} context={context} zh={zh} />
      ))}
    </section>
  )
}
