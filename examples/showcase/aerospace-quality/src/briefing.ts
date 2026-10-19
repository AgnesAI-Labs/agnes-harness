import { investigate } from './domain.js'
import type { State } from './model.js'
/** Data-only Intelligent UI: no HTML/JS or client-owned decisions. */
export function briefing(state: State, locale: 'zh-CN' | 'en') {
  const zh = locale === 'zh-CN',
    a = investigate(state)
  return {
    id: `aero-evidence-${crypto.randomUUID()}`,
    revision: 1,
    title: zh ? 'AN-027 证据简报' : 'AN-027 evidence briefing',
    summary: zh
      ? '冷平台电流越限；批次与 NCR 支持候选机理，复现及有效性证据仍缺。'
      : 'Cold-plateau overcurrent; lot/NCR correlation supports a hypothesis. Reproduction and effectiveness evidence remain open.',
    placement: { inline: true, workbench: true, preferred: 'workbench' },
    components: [
      {
        id: 'telemetry',
        kind: 'chart',
        title: zh ? '冷平台电流与限值 / A' : 'Cold-plateau current and limit / A',
        dataKey: 'telemetry',
        chartType: 'line',
        categoryKey: 'minute',
        series: [
          { key: 'current', label: zh ? '电流' : 'Current' },
          { key: 'limit', label: zh ? '上限' : 'Upper limit' },
        ],
      },
      {
        id: 'evidence',
        kind: 'table',
        title: zh ? '受控证据链' : 'Controlled evidence chain',
        dataKey: 'evidence',
        rowKey: 'id',
        selection: 'none',
        columns: [
          { key: 'id', label: 'ID' },
          { key: 'meaning', label: zh ? '含义' : 'Meaning' },
        ],
      },
      { id: 'hypothesis', kind: 'text', dataKey: 'hypothesis' },
    ],
    data: {
      telemetry: state.campaigns[0]!.samples.filter((p) => p.minute >= 60 && p.minute <= 76).map((p) => ({
        minute: p.minute,
        current: p.current,
        limit: p.limit,
      })),
      evidence: a.evidence.map((id) => ({
        id,
        meaning: id.startsWith('TC-')
          ? zh
            ? '试验观测'
            : 'Test observation'
          : id.startsWith('ECR-')
            ? zh
              ? '受控更改'
              : 'Controlled change'
            : zh
              ? '关联不合格记录'
              : 'Related NCR',
      })),
      hypothesis: a.hypothesis[locale],
    },
    actions: [],
  }
}
