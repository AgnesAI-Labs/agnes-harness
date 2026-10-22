import { Button, Field, Select } from '@agnes/web-ui'
import React from 'react'
import { h, NoteField } from './board.js'

/** The form that creates a project on the board; software projects get a coordinator workspace. */
export function NewProject({ data, board, role, onDone }) {
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [projectKind, setProjectKind] = React.useState('SOFTWARE')
  const [org, setOrg] = React.useState('')
  const live = projectKind === 'SOFTWARE'
  const submit = async () => {
    const out = await board.run(
      'devboard.create',
      {
        kind: 'project',
        by: role,
        name: name.trim(),
        projectKind,
        ...(org ? { org } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      },
      live ? '已新建项目，请让研发协调员继续推进' : '已新建项目记录',
    )
    if (out?.result?.id) onDone({ id: out.result.id, live })
  }
  return h(
    'section',
    { className: 'devboard-actions', 'aria-label': '新建项目' },
    h(
      Field,
      { label: '项目名称', htmlFor: 'devboard-new-name' },
      h('input', {
        id: 'devboard-new-name',
        className: 'devboard-note',
        value: name,
        placeholder: '例如：车门健康监测看板',
        maxLength: 120,
        onChange: (e) => setName(e.target.value),
      }),
    ),
    h(
      'div',
      { className: 'devboard-buttons' },
      h(
        Field,
        { label: '项目类型' },
        h(Select, {
          'aria-label': '项目类型',
          value: projectKind,
          onChange: setProjectKind,
          options: [
            { value: 'SOFTWARE', label: '软件平台' },
            { value: 'NEW_BUILD', label: '订单新造' },
            { value: 'RETROFIT', label: '订单改造' },
          ],
          style: { minWidth: 160 },
        }),
      ),
      h(
        Field,
        { label: '归属技术中心' },
        h(Select, {
          'aria-label': '归属技术中心',
          value: org,
          onChange: setOrg,
          options: [{ value: '', label: '按类型默认' }, ...data.orgs.map((o) => ({ value: o, label: o }))],
          style: { minWidth: 200 },
        }),
      ),
    ),
    h(NoteField, {
      id: 'devboard-new-desc',
      label: '项目说明（可选）',
      value: description,
      onChange: setDescription,
    }),
    h(
      'div',
      { className: 'devboard-buttons' },
      h(
        Button,
        { appearance: 'primary', disabled: board.busy || !name.trim(), onClick: submit },
        live ? '新建现场项目' : '新建项目记录',
      ),
      h(
        'span',
        { className: 'devboard-muted' },
        live
          ? '软件平台项目会建工作区，由研发协调员写计划、按裁剪后的评审点推进并现场真跑。'
          : '订单类项目只建记录与评审点档案，不建工作区。',
      ),
    ),
  )
}
