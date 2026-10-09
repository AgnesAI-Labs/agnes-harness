export function storyPattern(names) {
  if (!Array.isArray(names) || names.length === 0 || names.some((name) => typeof name !== 'string' || !name))
    throw new Error('Story fixture must name required tests')
  return `(?:^| )(?:${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`
}

export function verifyStoryResult(report, names) {
  const tests = (report.testResults ?? []).flatMap((file) => file.assertionResults ?? [])
  let count = 0
  storyPattern(names)
  for (const name of names) {
    const pattern = new RegExp(storyPattern([name]))
    const selected = tests.filter((test) => pattern.test(test.fullName))
    if (!report.success || selected.length === 0 || selected.some((test) => test.status !== 'passed'))
      throw new Error(`Story fixture must execute and pass: ${name}`)
    count += selected.length
  }
  return count
}
