export function releaseProblems(input: {
  version: string
  packageVersion: string
  changelog: string
  surface: { apiVersion: string; runtimeExports: string[] }
  runtimeExports: string[]
}): string[] {
  const problems: string[] = []
  if (input.packageVersion !== input.version) problems.push('package.json version differs from API_VERSION')
  if (!input.changelog.split(/\r?\n/).includes(`## ${input.version}`))
    problems.push('CHANGELOG lacks current API version heading')
  if (input.surface.apiVersion !== input.version) problems.push('surface version differs from API_VERSION')
  if (
    JSON.stringify([...input.surface.runtimeExports].sort()) !==
    JSON.stringify([...input.runtimeExports].sort())
  )
    problems.push('runtime exports differ from API surface snapshot')
  return problems
}
