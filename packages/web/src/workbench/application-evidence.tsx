import { readWorkbenchEvidence, type UINode, type WorkbenchEvidenceItem } from '@agnes/protocol'
import type { UiExtensionContext } from '@agnes/web-client'
import type { WorkbenchContext } from '@agnes/web-conversation/workbench'
import { Button, Disclosure, EmptyState, Icon, Tag, useDocumentLanguage } from '@agnes/web-ui'
import { useEffect, useState } from 'react'

type ToolNode = Extract<UINode, { kind: 'tool' }>
type Evidence = WorkbenchEvidenceItem & { node: ToolNode; output: unknown }

function items(output: unknown, node: ToolNode): Evidence[] {
  const record = output && typeof output === 'object' && 'data' in output ? output.data : output
  const declared = readWorkbenchEvidence(output)
  const nested = readWorkbenchEvidence(record)
  if (declared.length || nested.length)
    return [...declared, ...nested].map((item) => ({ ...item, node, output }))
  // Compatible file receipts still represent files, never the execution itself.
  if (!record || typeof record !== 'object') return []
  const lists = ['paths' in record ? record.paths : undefined, 'files' in record ? record.files : undefined]
  return lists
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .flatMap((path) => {
      const parsed = readWorkbenchEvidence({
        evidence: [
          {
            name: typeof path === 'string' ? path.split('/').at(-1) : '',
            kind: /\.(html|md|pdf)$/i.test(String(path)) ? 'report' : 'file',
            status: node.status === 'failed' ? 'failed' : 'available',
            path,
          },
        ],
      })
      return parsed.map((item) => ({ ...item, node, output }))
    })
}

export function ApplicationEvidence({ context }: { context: UiExtensionContext }) {
  const data = context.data as WorkbenchContext
  const zh = useDocumentLanguage() === 'zh-CN'
  const [state, setState] = useState<{ key: string; records: Evidence[]; failed: boolean }>()
  const tools =
    data.timeline?.nodes
      .filter((node): node is ToolNode => node.kind === 'tool' && node.resultSeq !== undefined)
      .slice(-64) ?? []
  const key = JSON.stringify([data.session?.id, tools.map((node) => [node.seq, node.resultSeq])])
  // The key captures the immutable call/result pairs, not unrelated live projection updates.
  // biome-ignore lint/correctness/useExhaustiveDependencies: immutable pairs are serialized above.
  useEffect(() => {
    let live = true
    const session = data.session
    if (!session) return
    void Promise.allSettled(
      tools.map(async (node) => {
        const detail = await session.readToolDetail(node.seq, node.resultSeq)
        return items(detail.result?.structured, node)
      }),
    ).then((results) => {
      if (!live) return
      const unique = new Map<string, Evidence>()
      for (const result of results)
        if (result.status === 'fulfilled') for (const item of result.value) unique.set(item.path, item)
      setState({ key, records: [...unique.values()], failed: results.some((r) => r.status === 'rejected') })
    })
    return () => {
      live = false
    }
  }, [data.session, key])
  const current = state?.key === key ? state : undefined
  const kind = { report: zh ? '报告' : 'Report', file: zh ? '文件' : 'File', record: zh ? '记录' : 'Record' }
  const status = {
    available: zh ? '可查看' : 'Available',
    pending: zh ? '待完成' : 'Pending',
    failed: zh ? '不可用' : 'Unavailable',
  }
  return (
    <section className="application-panel" aria-label={zh ? '证据与报告' : 'Evidence and reports'}>
      {!current && tools.length > 0 && <p role="status">{zh ? '正在读取证据…' : 'Loading evidence…'}</p>}
      {(tools.length === 0 || current?.records.length === 0) && (
        <EmptyState
          icon={<Icon name="file-text" />}
          title={zh ? '尚无证据与报告' : 'No evidence or reports yet'}
          description={
            zh ? '工具声明的证据与输出文件将显示在这里。' : 'Declared evidence and output files appear here.'
          }
        />
      )}
      {current?.failed && (
        <p role="status">
          {zh
            ? '部分证据暂不可用，请查看执行记录。'
            : 'Some evidence could not be loaded. Inspect the execution record.'}
        </p>
      )}
      {current?.records.map((item) => (
        <article key={item.path}>
          <h3>{item.name}</h3>
          <p>
            {kind[item.kind]} ·{' '}
            <Tag tone={item.status === 'failed' ? 'bad' : 'info'}>{status[item.status]}</Tag>
          </p>
          <Button
            disabled={item.status !== 'available'}
            title={item.path}
            onClick={() => context.openPanel?.('files', { path: item.path })}
          >
            {item.path.endsWith('.html')
              ? zh
                ? 'HTML 报告'
                : 'HTML report'
              : item.path.endsWith('.md')
                ? zh
                  ? 'Markdown 报告'
                  : 'Markdown report'
                : zh
                  ? '打开'
                  : 'Open'}
          </Button>
          <Disclosure variant="plain" summary={zh ? '来源与详情' : 'Source and details'}>
            <p>
              <code>{item.node.name}</code> · {zh ? '工具回执' : 'Tool receipt'} #{item.node.resultSeq}
            </p>
            <pre>{JSON.stringify(item.output, null, 2)}</pre>
            <Button
              onClick={() =>
                data.session && context.openRecord?.(data.session.id, item.node.seq, item.node.resultSeq)
              }
            >
              {zh ? '查看来源与审批' : 'Inspect provenance and approval'}
            </Button>
          </Disclosure>
        </article>
      ))}
    </section>
  )
}
