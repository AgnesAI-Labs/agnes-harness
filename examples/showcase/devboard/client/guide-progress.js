// Which main-line steps the board already proves (pure functions over the board snapshot, no React).
// A step's `done` rule is 'project' (a live project exists) or '<GATE>:submitted' / '<GATE>:approved'.

/** The newest live project: the one with a workspace directory (created by the coordinator). */
export function liveProject(data) {
  const live = (data?.projects ?? []).filter((p) => p.workspaceDir)
  return live.length ? live[live.length - 1] : undefined
}

/** The project a step wants selected: its id, '' (all / first), or null when it wants the live project and none exists. */
export function stepProject(step, data) {
  if (step.project !== 'live') return step.project ?? ''
  return liveProject(data)?.id ?? null
}

/** Is the rule satisfied for the live project? A gate exists once submitted; a rejected gate does not count as approved. */
export function ruleDone(data, rule) {
  const project = liveProject(data)
  if (!project) return false
  if (rule === 'project') return true
  const [code, state] = String(rule).split(':')
  const gates = (data.gates ?? []).filter(
    (g) => !g.superseded && g.code === code && g.stageId?.startsWith(`${project.id}/`),
  )
  return state === 'approved' ? gates.some((g) => g.decision === 'APPROVED') : gates.length > 0
}

/** Step id → true for every step whose board rule is met. Steps without a rule are never listed. */
export function mainProgress(data, steps) {
  const out = {}
  for (const step of steps) if (step.done && ruleDone(data, step.done)) out[step.id] = true
  return out
}
