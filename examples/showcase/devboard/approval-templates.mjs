// DevBoard 3.1 approval flow templates (pure data). Node names, roles and time limits are inferred from
// the PLM/OA practice of door-system makers and are listed in the README as "待客户确认".
// Node modes: SERIAL (one of the roles approves), ALL (every role approves once), ANY (either role).
// The initiator's own step (编制 / 提出) is not a node: it happens before the flow starts.
// `excludeInitiator` drops the initiator's role from the node's roles, so nobody checks their own work.

const node = (id, name, mode, roles, dueHours, extra = {}) => ({ id, name, mode, roles, dueHours, ...extra })

const DESIGN_ROLES = ['系统设计师', '机械设计师', '电气设计师', '软件设计师', '验证工程师']

export const TEMPLATES = Object.freeze({
  DOC_RELEASE: {
    name: '技术文件发布',
    subject: 'artifact',
    nodes: [
      node('proofread', '校对', 'SERIAL', DESIGN_ROLES, 24, { excludeInitiator: true }),
      node('review', '审核', 'SERIAL', ['技术负责人'], 48),
      node('standard', '标准化审查', 'SERIAL', ['标准化工程师'], 48),
      node('approve', '批准', 'SERIAL', ['分技术中心主任'], 24),
    ],
  },
  ECR: {
    name: '工程变更 ECR',
    subject: 'change',
    nodes: [
      node(
        'cosign',
        '专业会签',
        'ALL',
        ['机械设计师', '电气设计师', '软件设计师', '工艺工程师', '质量工程师'],
        72,
      ),
      node('ccb', 'CCB 决议', 'ANY', ['技术负责人', '分技术中心主任'], 48),
    ],
  },
  ECN_RELEASE: {
    name: 'ECN 发布',
    subject: 'change',
    nodes: [
      node('check', '配置核对', 'SERIAL', ['配置管理员'], 24),
      node('approve', '批准', 'SERIAL', ['分技术中心主任'], 24),
      node('publish', '发布', 'SERIAL', ['配置管理员'], 24),
    ],
  },
  PROBLEM_CLOSE: {
    name: '质量问题关闭（8D）',
    subject: 'problem',
    nodes: [
      node('review', '质量审核', 'SERIAL', ['质量工程师'], 48),
      node('approve', '批准', 'SERIAL', ['分技术中心主任'], 24),
    ],
  },
  TRIAL_REPORT: {
    name: '试验报告',
    subject: 'trial',
    nodes: [
      node('review', '质量审核', 'SERIAL', ['质量工程师'], 48),
      node('approve', '批准', 'SERIAL', ['技术负责人'], 24),
    ],
  },
})
