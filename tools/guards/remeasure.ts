import { parseRemeasureArgs, remeasure } from './src/ratchet-remeasure.js'
import { repoRoot } from './src/repo.js'

try {
  const options = parseRemeasureArgs(process.argv.slice(2))
  const measurements = remeasure(repoRoot(), options)
  for (const { key, actual, budget, ceiling } of measurements)
    console.log(`${key}: actual=${actual}, ratchet=${budget}, INITIAL_CEILING=${ceiling}`)
  if (!measurements.length) console.log('No changed source scopes match a ratchet key.')
  if (
    options.check &&
    measurements.some(({ actual, budget, ceiling }) => actual !== budget || actual !== ceiling)
  )
    process.exitCode = 1
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Ratchet remeasurement failed')
  process.exitCode = 1
}
