import React from 'react'
import { h } from './board.js'
import { ArtifactPreview } from './result.js'

/** The analysis files registered for one object (a change, ECN, problem, trial or fault): analysis/<id>/ of its project. */
export const analysisOf = (data, projectId, ...ids) =>
  data.artifacts.filter(
    (a) =>
      a.kind === 'ANALYSIS' &&
      a.projectId === projectId &&
      ids.some((id) => id && a.source?.path?.includes(`/analysis/${id}/`)),
  )

function File({ board, artifact }) {
  const [open, setOpen] = React.useState(false)
  return h(
    'details',
    { className: 'devboard-evidence', onToggle: (e) => setOpen(e.currentTarget.open) },
    h('summary', null, `${artifact.title} ${artifact.version}`),
    open && h(ArtifactPreview, { board, artifact }),
  )
}

/** The files the roles wrote for an object, read only when opened; nothing when none was registered. */
export function AnalysisFiles({ data, board, projectId, ids }) {
  const files = analysisOf(data, projectId, ...ids)
  if (!files.length) return null
  return h(
    'section',
    { className: 'devboard-card', 'aria-label': '分析文件' },
    h('h2', null, `分析文件（${files.length}）`),
    files.map((a) => h(File, { key: a.id, board, artifact: a })),
  )
}
