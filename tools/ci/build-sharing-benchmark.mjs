import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const labels = ['build', 'pack', 'upload', 'download', 'restore']
export function benchmarkResult(measured) {
  const durationsMs = Object.fromEntries(labels.map((label) => [label, measured[label]]))
  const complete = labels.every(
    (label) =>
      typeof measured[label] === 'number' && Number.isFinite(measured[label]) && measured[label] >= 0,
  )
  const consumerMs = complete ? measured.download + measured.restore : null
  const producerMs = complete ? measured.pack + measured.upload : null
  const singleConsumerMs = complete ? consumerMs + producerMs : null
  return {
    durationsMs,
    complete,
    consumerMs,
    producerMs,
    singleConsumerMs,
    consumerFaster: complete ? consumerMs < measured.build : null,
    singleConsumerFaster: complete ? singleConsumerMs < measured.build : null,
  }
}

function output(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
  console.log(`${key}=${value}`)
}
function milliseconds(value) {
  return /^\d+(?:\.\d+)?$/.test(value ?? '') ? Number(value) : undefined
}
function report() {
  const result = benchmarkResult(
    Object.fromEntries(
      labels.map((label) => [label, milliseconds(process.env[`BENCHMARK_${label.toUpperCase()}_MS`])]),
    ),
  )
  const metrics = {
    ...result,
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      imageOS: process.env.ImageOS,
      imageVersion: process.env.ImageVersion,
    },
    archiveBytes: milliseconds(process.env.BENCHMARK_ARCHIVE_BYTES),
    transferTiming: 'Upload and download are wall-clock envelopes across their action steps.',
  }
  output('metrics', JSON.stringify(metrics))
  output('consumer-faster', result.consumerFaster ?? 'unknown')
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = labels.map((label) => `| ${label} | ${result.durationsMs[label] ?? 'missing'} |`).join('\n')
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Local build sharing benchmark (${process.env.BENCHMARK_RUNNER ?? process.platform})\n\n| Phase | Measured ms |\n| --- | ---: |\n${rows}\n\nConsumer download + strict restore: ${result.consumerMs ?? 'incomplete'} ms.\nProducer pack + upload: ${result.producerMs ?? 'incomplete'} ms.\nSingle-consumer total: ${result.singleConsumerMs ?? 'incomplete'} ms.\nConsumer faster than build: ${result.consumerFaster ?? 'unknown'}; single-consumer total faster: ${result.singleConsumerFaster ?? 'unknown'}.\n\n${metrics.transferTiming} This measurement does not enable shared local builds.\n\nImage: ${metrics.environment.imageOS ?? 'unknown'} / ${metrics.environment.imageVersion ?? 'unknown'}; ${process.platform}/${process.arch}; ${process.version}; archive ${metrics.archiveBytes ?? 'unknown'} bytes.\n`,
    )
  }
  if (!result.complete) throw new Error('Incomplete benchmark measurements; comparison is unavailable')
}
function main() {
  const [command, first, ...args] = process.argv.slice(2)
  if (command === 'timestamp' && !first) return output('started', Date.now())
  if (command === 'elapsed' && first && !args.length) {
    const started = milliseconds(first)
    if (started === undefined || started > Date.now()) throw new Error('Invalid benchmark start timestamp')
    return output('duration-ms', Date.now() - started)
  }
  if (command === 'measure' && labels.includes(first) && args.length) {
    const started = performance.now()
    const run = spawnSync(process.execPath, args, { stdio: 'inherit' })
    output('duration-ms', Math.round(performance.now() - started))
    if (run.error) throw run.error
    process.exitCode = run.status ?? 1
    return
  }
  if (command === 'report' && !first) return report()
  throw new Error('Expected measure <phase> <node-script> ...args | timestamp | elapsed <timestamp> | report')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
