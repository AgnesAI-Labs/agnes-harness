// What the 「交付成果」 card of a live project shows: pure functions over the board snapshot, no React.

const LEVELS = ['UNIT', 'INTEGRATION', 'SYSTEM']
const EVIDENCE = ['TEST_REPORT', 'ACCEPTANCE']

/** The card appears once the verification review (TR5) is submitted, and stays when the project is done. */
export function showDelivery(data, project) {
  if (!project?.live) return false
  const mine = (data.gates ?? []).filter((g) => g.stageId?.startsWith(`${project.id}/`))
  return Boolean(project.actualEnd) || mine.some((g) => g.code === 'TR5')
}

/** The newest run of each test level, in level order; a level never run is left out. */
export function latestRuns(data, projectId) {
  const runs = (data.testRuns ?? []).filter((r) => r.projectId === projectId)
  return LEVELS.flatMap((level) => {
    const newest = runs
      .filter((r) => r.level === level)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
    return newest ? [newest] : []
  })
}

/** The test report and the browser acceptance record of the project, as registered deliverables. */
export function evidenceDocs(data, projectId) {
  return EVIDENCE.flatMap((kind) =>
    (data.artifacts ?? []).filter((a) => a.projectId === projectId && a.kind === kind),
  )
}

/** The entry file of the delivered app, relative to the workspace root. */
export const entryFile = (project) => `${project.workspaceDir}/server.js`

/** A customer may raise a change on a live project from design on, until it is released. */
export const showCustomerChange = (project) =>
  Boolean(
    project?.live &&
      !project.actualEnd &&
      ['DESIGN', 'IMPLEMENTATION', 'VERIFICATION'].includes(project.stage),
  )
