// The coordinator buttons of the pages as data: which work action each opens, for which object type and
// when it is offered. Pure, so the tests can check every entry against the manifest and the hand-off.

/** name → { action, type, label, when(item) } */
export const ENTRIES = {
  continueGate: {
    action: 'continue',
    type: 'gate',
    label: '继续推进',
    when: (g) => g.decision !== 'PENDING',
  },
  continueProject: { action: 'continue', type: 'project', label: '让研发协调员继续推进' },
  runApp: { action: 'run-app', type: 'project', label: '启动并打开' },
  faultEightD: {
    action: 'phm-8d',
    type: 'fault',
    label: '让智能体起草 8D',
    when: (f) => f.state !== 'CLOSED',
  },
  problemEightD: {
    action: 'phm-8d',
    type: 'problem',
    label: '让智能体起草 8D',
    when: (p) => p.state !== 'CLOSED',
  },
  trialChange: { action: 'trial-change', type: 'trial', label: '让智能体起草变更' },
  changeImpact: {
    action: 'change',
    type: 'change',
    label: '让智能体分析影响',
    when: (c) => ['SUBMITTED', 'ANALYZED'].includes(c.state),
  },
  interventionContinue: {
    action: 'interventions',
    type: 'intervention',
    label: '交回智能体继续',
    when: (i) => i.state === 'RESOLVED',
  },
  projectProgress: { action: 'progress', type: 'project', label: '让智能体汇报进度' },
  customerChange: { action: 'customer-change', type: 'change', label: '登记并交给研发协调员' },
}

/** The action and work object of an entry for an item, or undefined when the entry is not offered for it. */
export function workOf(name, item) {
  const entry = ENTRIES[name]
  if (!entry || !item?.id || (entry.when && !entry.when(item))) return undefined
  return { action: entry.action, object: { type: entry.type, id: item.id }, label: entry.label }
}

/** The action and work object a hand-back card opens; the card itself names them, the page adds nothing. */
export function handbackWork(card) {
  if (!card?.action || !card.object?.type || !card.object.id) return undefined
  return {
    action: card.action,
    object: { type: card.object.type, id: card.object.id },
    label: '交回研发协调员继续',
  }
}
