import { Button, ConfirmDialog } from '@agnes/web-ui'
import React from 'react'
import { MyTodo } from './approvals.js'
import { h, JumpContext, Shell, useBoard, useRole } from './board.js'
import { FastForward } from './fastforward.js'
import { Service, Trials } from './field.js'
import { Overview, Projects } from './lifecycle.js'
import { Panorama } from './panorama.js'
import { Changes, Quality, Tasks } from './records.js'
import { Trace } from './trace.js'

/** Reset sits next to fast-forward, so one stray click must not wipe a live project in front of an audience. */
function ResetButton({ board }) {
  const [open, setOpen] = React.useState(false)
  return h(
    React.Fragment,
    null,
    h(Button, { disabled: board.busy, onClick: () => setOpen(true) }, '重置演示数据'),
    h(
      ConfirmDialog,
      {
        open,
        title: '重置演示数据？',
        confirmLabel: '重置',
        destructive: true,
        busy: board.busy,
        onCancel: () => setOpen(false),
        onConfirm: () => {
          setOpen(false)
          void board.run('devboard.reset', {}, '已恢复演示数据')
        },
      },
      '看板会回到预置的四个项目，现场项目、审批进度和智能体动态都会清空。devboard-projects/ 下已写出的文件保留在磁盘上。',
    ),
  )
}

/** id → [zh title, en title, icon, view, description]; order is the navigation order. */
const PAGES = {
  'devboard-overview': [
    '总览',
    'Portfolio',
    'activity',
    Overview,
    '当前演示角色的工作台，以及宁川装备研发项目组合：阶段进度、评审门、追溯覆盖率、缺陷、测试与风险。',
  ],
  'devboard-projects': [
    '项目',
    'Projects',
    'file-text',
    Projects,
    '单个项目的阶段时间线：交付物、评审门、基线、负责人、计划与实际。',
  ],
  'devboard-trace': [
    '需求与追溯',
    'Traceability',
    'list',
    Trace,
    '客户条款 → 系统需求 → 软件需求 → 设计 → 测试用例双向追溯，孤立项高亮。',
  ],
  'devboard-tasks': ['任务', 'Tasks', 'check', Tasks, '研发任务看板，按项目、状态和类型过滤。'],
  'devboard-changes': ['变更', 'Changes', 'history', Changes, '变更申请：影响分析、CCB 决议与返工。'],
  'devboard-quality': [
    '缺陷与测试',
    'Defects & tests',
    'circle-alert',
    Quality,
    '缺陷状态流转、缺陷趋势与测试运行记录。',
  ],
  'devboard-reviews': [
    '我的待办',
    'My to-dos',
    'shield',
    MyTodo,
    '待我处理、我发起的与已办：审批流程节点、评审门与人工介入请求；只有节点或门要求的角色能处理，非处理角色只读并可一键切换角色。',
  ],
  panorama: [
    '研发全景',
    'R&D panorama',
    'git-branch',
    Panorama,
    '所有研发项目的进度与卡点：泳道、阶段与评审门、变更与质量问题分支、时间轴；可按项目、卡点责任角色或专业查看。',
  ],
  trials: [
    '试验与首件',
    'Trials & FAI',
    'shield-check',
    Trials,
    '型式试验、例行试验、工厂验收与首件检验：标准、样品、试验室、报告号、结论与偏差；不合格可直接起草变更。',
  ],
  service: [
    '运维与质量',
    'Service & quality',
    'triangle-alert',
    Service,
    'PHM 预警按信号与时间聚合，质量问题 8D 进度、根本原因与关联变更；现场到设计的闭环入口。',
  ],
}

export function apply(ctx) {
  ctx.locale.register('@agnes-showcase/devboard', {
    en: Object.fromEntries(Object.entries(PAGES).map(([id, [, en]]) => [`devboard.nav.${id}`, en])),
    'zh-CN': Object.fromEntries(Object.entries(PAGES).map(([id, [zh]]) => [`devboard.nav.${id}`, zh])),
  })
  Object.entries(PAGES).forEach(([id, [title, , icon, View, description]], index) => {
    function DevBoardPage({ context }) {
      const board = useBoard(ctx)
      const [role, setRole] = useRole()
      const roles = board.data?.roles
      // A role saved by an older version (or not offered any more) falls back to the first one.
      React.useEffect(() => {
        if (roles?.length && !roles.includes(role)) setRole(roles[0])
      }, [roles, role, setRole])
      const reset =
        id === 'devboard-overview' &&
        h(React.Fragment, null, h(FastForward, { board }), h(ResetButton, { board }))
      return h(
        JumpContext.Provider,
        { value: context?.selection?.devboard },
        h(
          Shell,
          { id, title, description, board, role, setRole, actions: reset },
          board.data && h(View, { data: board.data, board, role, setRole }),
        ),
      )
    }
    ctx.homeEntries.register({
      id,
      titleKey: `devboard.nav.${id}`,
      icon,
      order: index + 10,
      placement: 'primary',
      component: DevBoardPage,
    })
  })
}
