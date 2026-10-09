export function verifyStoryResult(report, pattern) {
  const name = new RegExp(pattern)
  const selected = (report.testResults ?? [])
    .flatMap((file) => file.assertionResults ?? [])
    .filter((test) => name.test(test.fullName))
  if (!report.success || selected.length === 0 || selected.some((test) => test.status !== 'passed'))
    throw new Error(`Story fixture must execute and pass: ${pattern}`)
  return selected.length
}
