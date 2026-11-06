import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const manifest = JSON.parse(readFileSync(new URL('./web-batches.json', import.meta.url), 'utf8'))
const fail = (reason) => {
  throw new Error(`Web batches: ${reason}`)
}
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/
const batchKeys = ['args', 'id', 'timeoutMinutes', 'widths']
function validateBatch(batch, nightly = false) {
  if (
    !batch ||
    Object.keys(batch).sort().join(',') !== batchKeys.join(',') ||
    typeof batch.id !== 'string' ||
    !idPattern.test(batch.id)
  )
    fail('invalid batch identity')
  const expectedWidths = nightly ? '' : ({ 'narrow-phone': '375', 'narrow-tablet': '768' }[batch.id] ?? '')
  if (batch.widths !== expectedWidths || batch.timeoutMinutes !== (nightly ? 20 : 10))
    fail('invalid batch widths or timeout')
  if (
    !Array.isArray(batch.args) ||
    !batch.args.length ||
    !batch.args.every((arg) => typeof arg === 'string' && arg.length)
  )
    fail('invalid argument array')
  let files = 0
  for (let at = 0; at < batch.args.length; at++) {
    const arg = batch.args[at]
    if (arg === '--grep' || arg === '--grep-invert') {
      if (!files || at !== batch.args.length - 2 || batch.args[at + 1].startsWith('--'))
        fail('invalid selector arguments')
      break
    }
    if (!/^[a-z0-9-]+\.spec\.ts$/.test(arg) || !existsSync(new URL(`../e2e-web/${arg}`, import.meta.url)))
      fail('unknown browser argument')
    files++
  }
  if (!files) fail('batch has no spec files')
}

export function buildMatrices(source = manifest) {
  if (source?.schema !== 1) fail('unsupported manifest schema')
  const matrices = {}
  for (const [platform, count, size] of [
    ['macos', 16, 2],
    ['linux', 6, 3],
  ]) {
    const { batches, groups } = source[platform] ?? {}
    if (
      !Array.isArray(batches) ||
      batches.length !== count * size ||
      !Array.isArray(groups) ||
      groups.length !== count
    )
      fail(`incomplete ${platform} batches`)
    const canonical = new Map()
    for (const batch of batches) {
      validateBatch(batch)
      if (canonical.has(batch.id)) fail('duplicate canonical batch id')
      canonical.set(batch.id, batch)
    }
    const selected = new Set()
    const groupIds = new Set()
    const include = groups.map((group) => {
      if (
        typeof group.id !== 'string' ||
        !idPattern.test(group.id) ||
        groupIds.has(group.id) ||
        !Array.isArray(group.batches) ||
        group.batches.length !== size
      )
        fail('invalid or duplicate batch group')
      groupIds.add(group.id)
      return {
        id: group.id,
        batches: group.batches.map((id) => {
          if (!canonical.has(id) || selected.has(id)) fail('unknown or repeated canonical batch reference')
          selected.add(id)
          return canonical.get(id)
        }),
      }
    })
    if (selected.size !== canonical.size) fail('missing canonical batch')
    matrices[platform] = { include }
  }
  const nightlyIds = ['narrow-en-light', 'narrow-en-dark', 'narrow-zh-CN-light', 'narrow-zh-CN-dark']
  if (!Array.isArray(source.nightly) || source.nightly.length !== nightlyIds.length)
    fail('incomplete nightly batches')
  for (let index = 0; index < nightlyIds.length; index++) {
    const batch = source.nightly[index]
    validateBatch(batch, true)
    if (
      batch.id !== nightlyIds[index] ||
      JSON.stringify(batch.args) !==
        JSON.stringify([
          'narrow.spec.ts',
          '--grep',
          `${batch.id.slice('narrow-'.length).replace(/-(light|dark)$/, '/$1')}$`,
        ])
    )
      fail('unknown nightly selector')
  }
  return matrices
}

export function canonicalBatch(batch) {
  buildMatrices()
  const candidates = [...manifest.macos.batches, ...manifest.linux.batches, ...manifest.nightly]
  if (!batch || Object.keys(batch).sort().join(',') !== batchKeys.join(',')) fail('invalid batch identity')
  const found = candidates.find((candidate) =>
    batchKeys.every((key) => JSON.stringify(candidate[key]) === JSON.stringify(batch[key])),
  )
  if (!found) fail('batch identity or arguments do not match a canonical selector')
  return found
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2 || !process.env.GITHUB_OUTPUT)
      fail('GITHUB_OUTPUT is required; no arguments accepted')
    const matrices = buildMatrices()
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `macos-matrix=${JSON.stringify(matrices.macos)}\nlinux-matrix=${JSON.stringify(matrices.linux)}\n`,
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
