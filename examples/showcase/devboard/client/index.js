import { Badge, Button, PushPage, Segmented, Select, Table, usePushStack } from '@agnes/web-ui'
import React from 'react'
import {
  fact,
  HistoryTable,
  h,
  options,
  Shell,
  stateBadge,
  TransitionBar,
  time,
  useBoard,
  useRole,
} from './board.js'

const PAGES = {
  'devboard-overview': ['DevBoard 总览', 'DevBoard overview', 'activity'],
  'devboard-requirements': ['需求', 'Requirements', 'list'],
  'devboard-tasks': ['任务', 'Tasks', 'check'],
  'devboard-interventions': ['人工介入', 'Human interventions', 'shield'],
}
const KINDS = { requirement: '需求', task: '任务', intervention: '人工介入' }

const idLink = (open) => (id) => h(Button, { appearance: 'link', onClick: () => open(id) }, id)
const byId = (list, id) => list.find((item) => item.id === id)

function Overview({ data }) {
  const recent = ['requirements', 'tasks', 'interventions']
    .flatMap((c) =>
      data[c].flatMap((item) =>
        item.history.map((e) => ({ ...e, id: item.id, title: item.title ?? item.ask })),
      ),
    )
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 12)
  const overdue = data.counts.intervention.EXPIRED
  return h(
    React.Fragment,
    null,
    overdue > 0 &&
      h(
        'p',
        { className: 'devboard-alert', role: 'alert' },
        `有 ${overdue} 项人工介入请求已超时，请到「人工介入」页处理。`,
      ),
    h(
      'div',
      { className: 'devboard-cards' },
      Object.entries(KINDS).map(([kind, title]) =>
        h(
          'section',
          { className: 'devboard-card', key: kind },
          h('h2', null, title),
          h(
            'ul',
            null,
            Object.entries(data.counts[kind]).map(([state, n]) =>
              h('li', { key: state }, stateBadge(data, state), h('strong', null, n)),
            ),
          ),
        ),
      ),
    ),
    h('h2', { className: 'devboard-heading' }, '最近动态'),
    h(Table, {
      captionRepeatsHeading: true,
      caption: '最近动态',
      rowKey: (r) => `${r.id}-${r.at}-${r.to}`,
      pagination: false,
      size: 'small',
      dataSource: recent,
      columns: [
        { title: '时间', dataIndex: 'at', render: time, width: 140 },
        { title: '编号', dataIndex: 'id', width: 100 },
        { title: '标题', dataIndex: 'title' },
        { title: '操作人', dataIndex: 'by', width: 140 },
        { title: '流转', render: (_v, r) => `${r.from ?? '—'} → ${r.to}`, width: 200 },
      ],
    }),
  )
}

function Requirements({ data, board, role }) {
  const push = usePushStack()
  const [selected, setSelected] = React.useState('')
  const [state, setState] = React.useState('')
  const open = (id) => {
    setSelected(id)
    push.open('detail')
  }
  const rows = data.requirements.filter((r) => !state || r.state === state)
  const item = byId(data.requirements, selected)
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'devboard-filters' },
      h(Select, {
        'aria-label': '按状态过滤',
        value: state,
        onChange: setState,
        options: options(stateLabels(data, 'requirement'), '全部状态'),
        style: { minWidth: 160 },
      }),
    ),
    h(Table, {
      captionRepeatsHeading: true,
      caption: '需求列表',
      rowKey: 'id',
      pagination: false,
      dataSource: rows,
      columns: [
        { title: '编号', dataIndex: 'id', render: idLink(open), width: 110 },
        { title: '标题', dataIndex: 'title' },
        { title: '优先级', dataIndex: 'priority', width: 90 },
        { title: '负责人', dataIndex: 'owner', width: 150 },
        { title: '状态', dataIndex: 'state', render: (s) => stateBadge(data, s), width: 100 },
        {
          title: '任务',
          render: (_v, r) => data.tasks.filter((t) => t.requirementId === r.id).length,
          width: 70,
        },
      ],
    }),
    item &&
      h(
        PushPage,
        { id: 'detail', title: `${item.id} ${item.title}`, description: item.description },
        h(
          'div',
          { className: 'devboard-detail' },
          h(
            'dl',
            { className: 'devboard-facts' },
            fact('状态', stateBadge(data, item.state)),
            fact('优先级', data.labels.priority[item.priority]),
            fact('负责人', item.owner),
            fact('创建时间', time(item.createdAt)),
          ),
          h(TransitionBar, { key: item.id, data, kind: 'requirement', item, board, role }),
          h('h3', null, '关联任务'),
          h(TaskTable, { data, rows: data.tasks.filter((t) => t.requirementId === item.id) }),
          h('h3', null, '流转记录'),
          h(HistoryTable, { history: item.history }),
        ),
      ),
  )
}

const stateLabels = (data, kind) =>
  Object.fromEntries(Object.keys(data.machines[kind]).map((s) => [s, data.labels.state[s]]))

function TaskTable({ data, rows, open }) {
  return h(Table, {
    captionRepeatsHeading: true,
    caption: '任务列表',
    rowKey: 'id',
    pagination: false,
    dataSource: rows,
    empty: '暂无任务',
    columns: [
      { title: '编号', dataIndex: 'id', render: open ? idLink(open) : undefined, width: 110 },
      { title: '标题', dataIndex: 'title' },
      { title: '类型', dataIndex: 'type', render: (t) => data.labels.taskType[t], width: 100 },
      { title: '需求', dataIndex: 'requirementId', width: 90 },
      { title: '负责人', dataIndex: 'owner', width: 150 },
      { title: '状态', dataIndex: 'state', render: (s) => stateBadge(data, s), width: 100 },
    ],
  })
}

function Tasks({ data, board, role }) {
  const push = usePushStack()
  const [selected, setSelected] = React.useState('')
  const [state, setState] = React.useState('')
  const [type, setType] = React.useState('')
  const [view, setView] = React.useState('list')
  const open = (id) => {
    setSelected(id)
    push.open('detail')
  }
  const rows = data.tasks.filter((t) => (!state || t.state === state) && (!type || t.type === type))
  const item = byId(data.tasks, selected)
  const columns = Object.keys(data.machines.task).filter((s) => !state || s === state)
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'devboard-filters' },
      h(Select, {
        'aria-label': '按状态过滤',
        value: state,
        onChange: setState,
        options: options(stateLabels(data, 'task'), '全部状态'),
        style: { minWidth: 150 },
      }),
      h(Select, {
        'aria-label': '按类型过滤',
        value: type,
        onChange: setType,
        options: options(data.labels.taskType, '全部类型'),
        style: { minWidth: 150 },
      }),
      h(Segmented, {
        label: '视图',
        value: view,
        onChange: setView,
        options: [
          { value: 'list', label: '列表' },
          { value: 'board', label: '看板' },
        ],
      }),
    ),
    view === 'list'
      ? h(TaskTable, { data, rows, open })
      : h(
          'div',
          { className: 'devboard-columns' },
          columns.map((s) =>
            h(
              'section',
              { className: 'devboard-column', key: s, 'aria-label': data.labels.state[s] },
              h('h3', null, stateBadge(data, s), ` ${rows.filter((t) => t.state === s).length}`),
              rows
                .filter((t) => t.state === s)
                .map((t) =>
                  h(
                    'button',
                    { type: 'button', className: 'devboard-tile', key: t.id, onClick: () => open(t.id) },
                    h('span', { className: 'devboard-muted' }, `${t.id} · ${data.labels.taskType[t.type]}`),
                    h('span', null, t.title),
                    h('span', { className: 'devboard-muted' }, t.owner),
                  ),
                ),
            ),
          ),
        ),
    item &&
      h(
        PushPage,
        { id: 'detail', title: `${item.id} ${item.title}` },
        h(
          'div',
          { className: 'devboard-detail' },
          h(
            'dl',
            { className: 'devboard-facts' },
            fact('状态', stateBadge(data, item.state)),
            fact('类型', data.labels.taskType[item.type]),
            fact(
              '所属需求',
              `${item.requirementId} ${byId(data.requirements, item.requirementId)?.title ?? ''}`,
            ),
            fact('负责人', item.owner),
            fact('依赖', item.dependsOn.length ? item.dependsOn.join('、') : '无'),
            fact('创建时间', time(item.createdAt)),
          ),
          h(TransitionBar, { key: item.id, data, kind: 'task', item, board, role }),
          h('h3', null, '流转记录'),
          h(HistoryTable, { history: item.history }),
        ),
      ),
  )
}

function Interventions({ data, board, role }) {
  const push = usePushStack()
  const [selected, setSelected] = React.useState('')
  const [type, setType] = React.useState('')
  const open = (id) => {
    setSelected(id)
    push.open('detail')
  }
  const rows = data.interventions.filter((i) => !type || i.type === type)
  const item = byId(data.interventions, selected)
  // Engineers may not claim; resolving needs a resolution, which the note field carries.
  const hidden = role === '工程师' ? ['CLAIMED'] : []
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'devboard-filters' },
      h(Select, {
        'aria-label': '按类型过滤',
        value: type,
        onChange: setType,
        options: options(data.labels.interventionType, '全部类型'),
        style: { minWidth: 160 },
      }),
      h('span', { className: 'devboard-muted' }, '超时项置顶并标红，其余按创建时间倒序。'),
    ),
    h(Table, {
      captionRepeatsHeading: true,
      caption: '人工介入请求',
      rowKey: 'id',
      pagination: false,
      dataSource: rows,
      rowClassName: (r) => (r.state === 'EXPIRED' ? 'devboard-overdue' : ''),
      columns: [
        { title: '编号', dataIndex: 'id', render: idLink(open), width: 100 },
        { title: '类型', dataIndex: 'type', render: (t) => data.labels.interventionType[t], width: 100 },
        { title: '问题', dataIndex: 'ask' },
        { title: '关联', render: (_v, r) => r.entity.id, width: 100 },
        { title: '截止', dataIndex: 'dueAt', render: time, width: 140 },
        { title: '处理人', dataIndex: 'handler', render: (v) => v ?? '—', width: 100 },
        { title: '状态', dataIndex: 'state', render: (s) => stateBadge(data, s), width: 100 },
      ],
    }),
    item &&
      h(
        PushPage,
        {
          id: 'detail',
          title: `${item.id} ${data.labels.interventionType[item.type]}`,
          description: item.ask,
        },
        h(
          'div',
          { className: 'devboard-detail' },
          item.state === 'EXPIRED' &&
            h('p', { className: 'devboard-alert', role: 'alert' }, '该请求已超过截止时间。'),
          h(
            'dl',
            { className: 'devboard-facts' },
            fact('状态', stateBadge(data, item.state)),
            fact('关联', `${KINDS[item.entity.kind]} ${item.entity.id}`),
            fact('发起人', item.requestedBy),
            fact('截止时间', time(item.dueAt)),
            fact('处理人', item.handler),
            fact('处理结论', item.resolution),
          ),
          role === '工程师' &&
            item.state !== 'CLAIMED' &&
            h(Badge, { tone: 'warn' }, '工程师角色不能认领介入请求，请切换演示角色。'),
          h(TransitionBar, {
            key: item.id,
            data,
            kind: 'intervention',
            item,
            board,
            role,
            hidden,
            noteLabel: '处理结论 / 备注',
          }),
          h('h3', null, '流转记录'),
          h(HistoryTable, { history: item.history }),
        ),
      ),
  )
}

const VIEWS = {
  'devboard-overview': Overview,
  'devboard-requirements': Requirements,
  'devboard-tasks': Tasks,
  'devboard-interventions': Interventions,
}
const DESCRIPTIONS = {
  'devboard-overview': '研发多智能体协作的需求、任务与人工介入总览。',
  'devboard-requirements': '按状态过滤需求，点开详情做细化、打回、分配等流转。',
  'devboard-tasks': '按状态和类型过滤任务，列表与看板两种视图。',
  'devboard-interventions': '智能体遇到决策点时发起的请求，由人认领并处理。',
}

export function apply(ctx) {
  ctx.locale.register('@agnes-showcase/devboard', {
    en: Object.fromEntries(Object.entries(PAGES).map(([id, [, en]]) => [`devboard.nav.${id}`, en])),
    'zh-CN': Object.fromEntries(Object.entries(PAGES).map(([id, [zh]]) => [`devboard.nav.${id}`, zh])),
  })
  for (const [id, [title, , icon]] of Object.entries(PAGES)) {
    function DevBoardPage() {
      const board = useBoard(ctx)
      const [role, setRole] = useRole()
      const reset =
        id === 'devboard-overview' &&
        h(
          Button,
          {
            disabled: board.busy,
            onClick: () => board.run('devboard.reset', {}, '已恢复演示数据'),
          },
          '重置演示数据',
        )
      return h(
        Shell,
        { id, title, description: DESCRIPTIONS[id], board, role, setRole, actions: reset },
        board.data && h(VIEWS[id], { data: board.data, board, role }),
      )
    }
    ctx.homeEntries.register({
      id,
      titleKey: `devboard.nav.${id}`,
      icon,
      order: Object.keys(PAGES).indexOf(id) + 10,
      placement: 'primary',
      component: DevBoardPage,
    })
  }
}
