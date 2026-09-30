import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { compilePrototype } from './compile.js'
import { digestFiles, GENERATED_FILES, jsonDigest, SOURCE_FILES } from './files.js'

export const CHECKPOINT_ID = 'runtime-prototype-api.v1'
export const IMPLEMENTATION_BASELINE = '5da40731214976ad8aff982cd5626d3a676fdd88'
export const ARTIFACT_PATH = 'artifacts/runtime-prototype-api/v1/snapshot.json'

export const REQUIRED_METHODS = [
  'open',
  'lease',
  'createRun',
  'probeAdmission',
  'admitInvocation',
  'admitQuery',
  'closeInvocation',
  'advanceRun',
  'advanceProvider',
  'dispatchAdmission',
  'probeDispatchAdmission',
  'commitControl',
  'intakeReceipt',
  'publishActionResult',
  'probeActionResult',
  'acceptInbox',
  'claimOutbox',
  'ackOutbox',
  'failOutbox',
  'pruneRecordVersions',
] as const

export const REQUIRED_TYPES = [
  'OwnerRef',
  'HookStageRequest',
  'ResultHookPlan',
  'ReceiptIntakeRequest',
  'DispatchBudgetPlan',
] as const

const PUBLIC_SURFACE = [
  ...REQUIRED_METHODS.map((name) => `StateStoreControl.${name}`),
  ...REQUIRED_TYPES,
].sort()

function checkGeneration(root: string): void {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'packages/protocol/tools/gen.ts', '--check'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    },
  )
  if (result.error || result.status !== 0)
    throw new Error(
      `prototype generation check failed: ${result.error?.message ?? result.stderr ?? result.stdout}`,
    )
}

function checkDeclaredSurface(root: string): void {
  const schema = JSON.parse(readFileSync(resolve(root, SOURCE_FILES[0]), 'utf8')) as {
    $defs: Record<string, unknown>
    'x-state-store-control': Record<string, { input: string; output: string }>
  }
  for (const name of REQUIRED_TYPES)
    if (!Object.hasOwn(schema.$defs, name)) throw new Error(`required public type missing: ${name}`)
  for (const name of REQUIRED_METHODS) {
    const method = schema['x-state-store-control'][name]
    if (!method || !Object.hasOwn(schema.$defs, method.input) || !Object.hasOwn(schema.$defs, method.output))
      throw new Error(`required public method or payload missing: StateStoreControl.${name}`)
  }
}

export function buildPrototypeSnapshot(root: string) {
  checkDeclaredSurface(root)
  checkGeneration(root)
  const snapshot = {
    checkpointId: CHECKPOINT_ID,
    schemaVersion: 1,
    productBaseline: IMPLEMENTATION_BASELINE,
    sourceFiles: digestFiles(root, SOURCE_FILES),
    generatedFiles: digestFiles(root, GENERATED_FILES),
    publicSurface: PUBLIC_SURFACE,
    compileEvidence: compilePrototype(root),
  }
  return { ...snapshot, snapshotDigest: jsonDigest(snapshot) }
}

export type PrototypeSnapshot = ReturnType<typeof buildPrototypeSnapshot>

/** Rebuild evidence instead of trusting a caller's successful compiler report or rehashed manifest. */
export function verifyPrototypeSnapshot(root: string, candidate: unknown): PrototypeSnapshot {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    throw new Error('snapshot must be an object')
  const snapshot = candidate as Record<string, unknown>
  const fields = [
    'checkpointId',
    'schemaVersion',
    'productBaseline',
    'sourceFiles',
    'generatedFiles',
    'publicSurface',
    'compileEvidence',
    'snapshotDigest',
  ]
  if (
    Object.keys(snapshot).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(snapshot, field))
  )
    throw new Error('snapshot fields are missing or unknown')
  if (snapshot.checkpointId !== CHECKPOINT_ID || snapshot.schemaVersion !== 1)
    throw new Error('unknown checkpoint or schema version')
  if (snapshot.productBaseline !== IMPLEMENTATION_BASELINE)
    throw new Error('snapshot implementation baseline differs')
  const { snapshotDigest, ...body } = snapshot
  if (typeof snapshotDigest !== 'string' || snapshotDigest !== jsonDigest(body))
    throw new Error('snapshot digest differs')
  const actual = buildPrototypeSnapshot(root)
  for (const field of ['sourceFiles', 'generatedFiles', 'publicSurface', 'compileEvidence'] as const)
    if (jsonDigest(snapshot[field]) !== jsonDigest(actual[field]))
      throw new Error(`snapshot ${field} is missing, forged or stale`)
  return actual
}

export function writePrototypeSnapshot(root: string): PrototypeSnapshot {
  const snapshot = buildPrototypeSnapshot(root)
  const path = resolve(root, ARTIFACT_PATH)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`)
  return snapshot
}
