// DevBoard v3 review-gate profiles, demo roles and organisations (design §4.1–4.2). Frozen contract
// shared by the seed and the domain; gate codes are ASCII, Chinese names are display only.
export const ROLES = [
  '项目经理',
  '产品经理',
  '系统设计师',
  '机械设计师',
  '电气设计师',
  '软件设计师',
  '验证工程师',
  '质量工程师',
  'RAMS 工程师',
  '配置管理员',
  '诊断工程师',
  '客服工程师',
  '技术负责人',
  '分技术中心主任',
  'IPMT',
  '客户代表',
  '标准化工程师',
  '工艺工程师',
]
export const ORGS = ['集团技术中心', '轨道车辆门分技术中心', '站台门分技术中心', '智能运维分技术中心']

const gate = (code, name, type, approverRoles, extra = {}) => ({ code, name, type, approverRoles, ...extra })

const ORDER = {
  INITIATION: {
    label: '合同评审与立项',
    author: '项目经理',
    gates: [gate('CONTRACT', '合同评审', 'MILESTONE', ['分技术中心主任'])],
  },
  REQUIREMENTS: {
    label: '技术协议与需求',
    author: '系统设计师',
    gates: [gate('DL1', '设计联络（一）', 'MILESTONE', ['项目经理', '客户代表'])],
  },
  DESIGN: {
    label: '方案与详细设计',
    author: '系统设计师',
    gates: [
      gate('DL2', '设计联络（二）', 'MILESTONE', ['项目经理', '客户代表']),
      gate('FREEZE', '设计冻结', 'TR', ['技术负责人']),
    ],
  },
  IMPLEMENTATION: {
    label: '样机试制',
    author: '机械设计师',
    gates: [gate('PROTO', '样机评审', 'TR', ['技术负责人'])],
  },
  VERIFICATION: {
    label: '型式试验与首件',
    author: '验证工程师',
    gates: [
      gate('TYPE', '型式试验评审', 'TR', ['质量工程师']),
      gate('FAI', '首件鉴定', 'MILESTONE', ['质量工程师', '客户代表']),
    ],
  },
  RELEASE: {
    label: '装车交付与验收',
    author: '项目经理',
    gates: [gate('ACCEPT', '交付验收', 'MILESTONE', ['客户代表', '分技术中心主任'])],
  },
}

const RETROFIT_LABELS = {
  INITIATION: '立项与现场勘测',
  REQUIREMENTS: '技术协议与需求',
  DESIGN: '改造方案设计',
  IMPLEMENTATION: '样机与割接方案',
  VERIFICATION: '试点站验证',
  RELEASE: '全线割接与验收',
}

const SOFTWARE = {
  INITIATION: { label: '概念', author: '产品经理', gates: [gate('CDCP', '概念决策评审', 'DCP', ['IPMT'])] },
  REQUIREMENTS: {
    label: '需求',
    author: '系统设计师',
    gates: [gate('TR1', '需求评审', 'TR', ['技术负责人'])],
  },
  DESIGN: {
    label: '设计',
    author: '软件设计师',
    gates: [
      gate('TR2', '概要设计评审', 'TR', ['技术负责人']),
      gate('TR3', '详细设计评审', 'TR', ['技术负责人']),
      gate('PDCP', '计划决策评审', 'DCP', ['IPMT']),
    ],
  },
  IMPLEMENTATION: {
    label: '开发',
    author: '软件设计师',
    gates: [gate('TR4', '代码与集成评审', 'TR', ['技术负责人'], { auto: true })],
  },
  VERIFICATION: {
    label: '验证',
    author: '验证工程师',
    gates: [gate('TR5', '系统验证评审', 'TR', ['质量工程师'])],
  },
  RELEASE: {
    label: '发布',
    author: '产品经理',
    gates: [gate('TR6', '发布评审', 'TR', ['质量工程师']), gate('ADCP', '可获得性决策评审', 'DCP', ['IPMT'])],
  },
}

const withLabels = (profile, labels) =>
  Object.fromEntries(Object.entries(profile).map(([stage, p]) => [stage, { ...p, label: labels[stage] }]))

export const GATE_PROFILES = Object.freeze({
  NEW_BUILD: ORDER,
  RETROFIT: withLabels(ORDER, RETROFIT_LABELS),
  MAINTENANCE: ORDER,
  SOFTWARE,
})

/** Default tailoring for software projects created live on the board (design §4.1). */
export const LIVE_TAILORING = Object.freeze({
  skipped: ['TR2', 'TR6', 'PDCP'],
  reason: '小版本软件项目按裁剪指南合并评审（推断）',
})
