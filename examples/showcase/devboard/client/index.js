import { Button } from '@agnes/web-ui'
import { h, Shell, useBoard, useRole } from './board.js'
import { Overview, Projects } from './lifecycle.js'
import { Changes, Quality, Reviews, Tasks, Trace } from './records.js'

/** id → [zh title, en title, icon, view, description]; order is the navigation order. */
const PAGES = {
  'devboard-overview': [
    '总览',
    'Portfolio',
    'activity',
    Overview,
    '宁川装备研发项目组合：阶段进度、评审门、追溯覆盖率、缺陷、测试与风险。',
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
    '评审待办',
    'Reviews',
    'shield',
    Reviews,
    '待决议的评审门与人工介入请求；在这里批准或驳回。',
  ],
}

export function apply(ctx) {
  ctx.locale.register('@agnes-showcase/devboard', {
    en: Object.fromEntries(Object.entries(PAGES).map(([id, [, en]]) => [`devboard.nav.${id}`, en])),
    'zh-CN': Object.fromEntries(Object.entries(PAGES).map(([id, [zh]]) => [`devboard.nav.${id}`, zh])),
  })
  Object.entries(PAGES).forEach(([id, [title, , icon, View, description]], index) => {
    function DevBoardPage() {
      const board = useBoard(ctx)
      const [role, setRole] = useRole()
      const reset =
        id === 'devboard-overview' &&
        h(
          Button,
          { disabled: board.busy, onClick: () => board.run('devboard.reset', {}, '已恢复演示数据') },
          '重置演示数据',
        )
      return h(
        Shell,
        { id, title, description, board, role, setRole, actions: reset },
        board.data && h(View, { data: board.data, board, role }),
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
