import { appendFileSync, readFileSync } from 'node:fs'
import { availableParallelism, cpus, totalmem } from 'node:os'

if (!process.argv[2]) {
  console.log(
    JSON.stringify(
      {
        node: process.version,
        cpus: cpus().length,
        availableParallelism: availableParallelism(),
        // An unlimited Linux cgroup can report UINT64_MAX; it is not available RAM.
        memoryBytes: Math.min(totalmem(), process.constrainedMemory() || Infinity),
        systemMemoryBytes: totalmem(),
        pool: 'forks',
        maxWorkers: 1,
        note: 'One test worker leaves capacity for the Vite coordinator; isolation remains enabled.',
      },
      null,
      2,
    ),
  )
} else {
  const report = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  const rows = report.testResults
    .flatMap((file) =>
      file.assertionResults.map((test) => ({
        file: file.name.replace(`${process.cwd()}/`, ''),
        name: test.fullName,
        duration: test.duration ?? 0,
        status: test.status,
      })),
    )
    .sort((a, b) => b.duration - a.duration)
  const slow = rows.filter((row) => row.duration > 2000)
  const markdown = [
    '## Fast test timing',
    `${rows.length} cases; ${slow.length} exceed 2 seconds. Full durations are in the JSON artifact.`,
    '',
    '| ms | status | file | case |',
    '| --- | --- | --- | --- |',
    ...rows
      .slice(0, Math.max(20, slow.length))
      .map(
        (row) =>
          `| ${Math.round(row.duration)} | ${row.status} | ${row.file} | ${row.name.replaceAll('|', '\\|').replaceAll('\n', ' ')} |`,
      ),
    '',
  ].join('\n')
  console.log(markdown)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
}
