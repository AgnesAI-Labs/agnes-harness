import { workbenchPanels } from '@agnes/web-client'
import { Button, Field, MetaText, Segmented, Select, SettingsDetails, SettingsState } from '@agnes/web-ui'
import { createElement as h, useEffect, useState } from 'react'

export const catalog = {
  en: {
    'memoryReview.title': 'Memory review',
    'memoryReview.help':
      'Learned preferences are untrusted. AGENTS.md and authorized knowledge sources take precedence. Review each native memory approval; Full access grants no memory permission.',
    'memoryReview.empty':
      'No review in the loaded history. Install and enable Memory review, select its Loop in a new session, and set workspace memory to Ask before writing. Off blocks agent reads and writes.',
    'memoryReview.loading': 'Reading the private review…',
    'memoryReview.incomplete':
      'This run has no complete review yet. Check the conversation for an error or pending work; do not apply an earlier review.',
    'memoryReview.error':
      'Could not read this review. Refresh the receipt; do not repeat a write with an unknown result.',
    'memoryReview.refresh': 'Refresh receipt',
    'memoryReview.groups': 'Findings',
    'memoryReview.diff': 'Changes',
    'memoryReview.views': 'Review view',
    'memoryReview.file': 'File replacement',
    'memoryReview.revision': 'Snapshot revision',
    'memoryReview.sources': 'Source files and hashes',
    'memoryReview.hashes': 'Base → new hash',
    'memoryReview.noChanges': 'No file replacements proposed.',
    'memoryReview.duplicate': 'Duplicate',
    'memoryReview.conflict': 'Conflict',
    'memoryReview.stale': 'Possibly obsolete',
    'memoryReview.completed': 'All proposed file replacements committed.',
    'memoryReview.partial':
      'Only some files committed. Inspect the receipt and current memory in Settings. Start a fresh turn to reconcile; do not retry this batch.',
    'memoryReview.failed':
      'No confirmed file commit. Inspect the error and current memory before starting a fresh turn.',
    'memoryReview.pending':
      'Proposal only. Each write still uses the native memory policy and exact human approval.',
    'memoryReview.receipt': 'Commit receipt',
    'memoryReview.unavailable':
      'This older backend does not provide complete tool details. Open the native approval or upgrade and start a new session.',
  },
  'zh-CN': {
    'memoryReview.title': '记忆复核',
    'memoryReview.help':
      '学习到的偏好是不可信数据，AGENTS.md 和已授权知识源优先。请逐项检查原生记忆审批；完全访问不授予记忆写入许可。',
    'memoryReview.empty':
      '已加载的历史中没有复核记录。请安装并启用记忆复核，在新会话选择其 Loop，并将工作区记忆设为“写入前询问”。关闭会阻止 Agent 读写。',
    'memoryReview.loading': '正在读取私有复核记录…',
    'memoryReview.incomplete': '本次运行尚无完整候选。请检查对话中的错误或待完成工作，不要应用上一轮候选。',
    'memoryReview.error': '无法读取复核记录。请刷新回执；结果未知时不要重复写入。',
    'memoryReview.refresh': '刷新回执',
    'memoryReview.groups': '发现',
    'memoryReview.diff': '变更',
    'memoryReview.views': '复核视图',
    'memoryReview.file': '文件替换',
    'memoryReview.revision': '快照修订',
    'memoryReview.sources': '来源文件与哈希',
    'memoryReview.hashes': '原始 → 新哈希',
    'memoryReview.noChanges': '没有建议的文件替换。',
    'memoryReview.duplicate': '重复',
    'memoryReview.conflict': '矛盾',
    'memoryReview.stale': '可能失效',
    'memoryReview.completed': '所有建议的文件替换均已提交。',
    'memoryReview.partial':
      '仅部分文件已提交。请在设置中检查回执和当前记忆，开启新一轮对话核对；不要重试本批次。',
    'memoryReview.failed': '没有确认成功的文件提交。请检查错误和当前记忆后，再开启新一轮对话。',
    'memoryReview.pending': '当前仅为候选，每次写入仍遵循原生记忆策略和精确人审。',
    'memoryReview.receipt': '提交回执',
    'memoryReview.unavailable': '此旧版后台无法提供完整工具记录。请打开原生审批，或升级后新建会话。',
  },
}

/** Read complete, authorized SDK tool records, never the truncated transcript previews. */
export async function loadReview(session, timeline, signal) {
  if (typeof session?.readToolDetail !== 'function') return { unavailable: true }
  const nodes = timeline?.nodes ?? []
  const node = [...nodes]
    .reverse()
    .find(
      (item) =>
        item.kind === 'tool' &&
        item.name === 'memory_review_preview' &&
        item.resultSeq &&
        item.status === 'completed',
    )
  const scan = [...nodes].reverse().find((item) => item.kind === 'tool' && item.name === 'memory_review_scan')
  if (scan && (!node || scan.seq > node.seq)) return { incomplete: true }
  if (!node) return {}
  const detail = await session.readToolDetail(node.seq, node.resultSeq, { signal })
  const review = detail.result?.structured
  const sourcesValid = (sources) =>
    Array.isArray(sources) &&
    sources.every((source) => typeof source?.path === 'string' && typeof source.hash === 'string')
  if (
    review?.version !== 1 ||
    typeof review.revision !== 'string' ||
    !Array.isArray(review.edits) ||
    !Array.isArray(review.groups) ||
    !review.edits.every(
      (edit) =>
        ['path', 'baseHash', 'newHash', 'diff', 'reason'].every((key) => typeof edit?.[key] === 'string') &&
        sourcesValid(edit.sources),
    ) ||
    !review.groups.every(
      (group) =>
        ['duplicate', 'conflict', 'stale'].includes(group?.kind) &&
        typeof group.reason === 'string' &&
        sourcesValid(group.sources),
    )
  )
    throw new Error('MEMORY_REVIEW_INVALID_RECORD')
  const receiptNode = [...nodes]
    .reverse()
    .find(
      (item) =>
        item.kind === 'tool' && item.name === 'memory_review_apply' && item.seq > node.seq && item.resultSeq,
    )
  const receipt = receiptNode
    ? (await session.readToolDetail(receiptNode.seq, receiptNode.resultSeq, { signal })).result?.structured
    : undefined
  if (receiptNode && (!receipt || !['completed', 'partial', 'failed'].includes(receipt.status)))
    throw new Error('MEMORY_REVIEW_INVALID_RECORD')
  signal.throwIfAborted()
  return { review, receipt }
}

export function MemoryReviewPanel({ context }) {
  const { t } = context
  const session = context.data?.session
  const timeline = context.data?.timeline
  const [view, setView] = useState('groups')
  const [file, setFile] = useState(undefined)
  const [refresh, setRefresh] = useState(0)
  const [state, setState] = useState(
    /** @type {Awaited<ReturnType<typeof loadReview>> & { loading?: boolean; error?: boolean; sessionId?: string }} */ ({
      loading: true,
    }),
  )
  useEffect(() => {
    const controller = new AbortController()
    const sessionId = timeline?.sessionId
    void refresh // Explicit refresh invalidates this read, never a write.
    setState({ loading: true, sessionId })
    loadReview(session, timeline, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ ...data, sessionId })
      },
      () => {
        if (!controller.signal.aborted) setState({ error: true, sessionId })
      },
    )
    return () => controller.abort()
  }, [session, timeline, refresh])
  const review = state.sessionId === timeline?.sessionId ? state.review : undefined
  const edit = review?.edits.find((item) => item.path === file) ?? review?.edits[0]
  return h(
    'section',
    { className: 'memory-review-panel', 'aria-label': t('memoryReview.title') },
    h('p', null, t('memoryReview.help')),
    h(
      Button,
      { onClick: () => setRefresh((value) => value + 1), disabled: state.loading },
      t('memoryReview.refresh'),
    ),
    state.loading
      ? h(SettingsState, { tone: 'loading' }, t('memoryReview.loading'))
      : state.error
        ? h(SettingsState, { tone: 'error' }, t('memoryReview.error'))
        : state.unavailable
          ? h(SettingsState, { tone: 'empty' }, t('memoryReview.unavailable'))
          : state.incomplete
            ? h(SettingsState, { tone: 'empty' }, t('memoryReview.incomplete'))
            : !review
              ? h(SettingsState, { tone: 'empty' }, t('memoryReview.empty'))
              : h(
                  'div',
                  null,
                  h(MetaText, null, `${t('memoryReview.revision')}: ${review.revision}`),
                  h(
                    SettingsState,
                    {
                      tone:
                        state.receipt?.status === 'completed'
                          ? 'success'
                          : ['partial', 'failed'].includes(state.receipt?.status)
                            ? 'error'
                            : 'empty',
                    },
                    t(`memoryReview.${state.receipt?.status ?? 'pending'}`),
                  ),
                  state.receipt &&
                    h(
                      SettingsDetails,
                      { title: t('memoryReview.receipt') },
                      h('pre', null, JSON.stringify(state.receipt, null, 2)),
                    ),
                  h(Segmented, {
                    label: t('memoryReview.views'),
                    value: view,
                    options: [
                      { value: 'groups', label: t('memoryReview.groups') },
                      { value: 'diff', label: t('memoryReview.diff') },
                    ],
                    onChange: setView,
                  }),
                  view === 'groups'
                    ? h(
                        'div',
                        null,
                        ...review.groups.map((group, index) =>
                          h(
                            SettingsDetails,
                            { key: index, title: t(`memoryReview.${group.kind}`), open: true },
                            h('p', null, group.reason),
                            h('p', null, t('memoryReview.sources')),
                            h('pre', null, JSON.stringify(group.sources, null, 2)),
                          ),
                        ),
                      )
                    : !edit
                      ? h(SettingsState, { tone: 'empty' }, t('memoryReview.noChanges'))
                      : h(
                          'div',
                          null,
                          h(
                            Field,
                            { label: t('memoryReview.file') },
                            h(Select, {
                              'aria-label': t('memoryReview.file'),
                              value: edit.path,
                              options: review.edits.map((item) => ({ value: item.path, label: item.path })),
                              onChange: setFile,
                            }),
                          ),
                          h('p', null, edit.reason),
                          h('p', null, t('memoryReview.hashes')),
                          h('pre', null, `${edit.baseHash}\n→ ${edit.newHash}`),
                          h('p', null, t('memoryReview.sources')),
                          h('pre', null, JSON.stringify(edit.sources, null, 2)),
                          h('pre', { tabIndex: 0, 'aria-label': t('memoryReview.diff') }, edit.diff),
                        ),
                ),
  )
}

export const inject = ['session', 'locale']
export function apply(ctx) {
  const off = [
    ctx.locale.register('memory-review', catalog),
    workbenchPanels.register({
      id: 'memory-review',
      order: 85,
      edge: 'right',
      titleKey: 'memoryReview.title',
      component: MemoryReviewPanel,
    }),
  ]
  ctx.effect(() => () => {
    for (const remove of off.reverse()) remove()
  })
}
