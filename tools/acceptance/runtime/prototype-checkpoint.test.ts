import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import type { JsonSchemaDoc } from '../../../packages/protocol/tools/gen-core.js'
import { generateRuntimeArtifacts } from '../../../packages/protocol/tools/gen-runtime.js'
import {
  ARTIFACT_PATH,
  buildPrototypeSnapshot,
  type PrototypeSnapshot,
  verifyPrototypeSnapshot,
} from '../../runtime-prototype/checkpoint.js'
import { compilePrototype } from '../../runtime-prototype/compile.js'
import { digestFiles, jsonDigest } from '../../runtime-prototype/files.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
let snapshot: PrototypeSnapshot
const rehash = (value: PrototypeSnapshot): PrototypeSnapshot => {
  const { snapshotDigest: _, ...body } = value
  return { ...body, snapshotDigest: jsonDigest(body) }
}

beforeAll(() => {
  snapshot = buildPrototypeSnapshot(root)
}, 60_000)

describe('runtime prototype checkpoint', () => {
  it('accepts the published snapshot after reproducing generation and public compilation', () => {
    const published: unknown = JSON.parse(readFileSync(join(root, ARTIFACT_PATH), 'utf8'))
    expect(verifyPrototypeSnapshot(root, published)).toEqual(snapshot)
    expect(snapshot.compileEvidence.diagnostics).toEqual([])
    expect(snapshot.publicSurface).toHaveLength(25)
  })

  it.each([
    [
      'missing field',
      (value: Record<string, unknown>) => {
        delete value.compileEvidence
      },
    ],
    [
      'unknown field',
      (value: Record<string, unknown>) => {
        value.extra = true
      },
    ],
    [
      'old checkpoint',
      (value: Record<string, unknown>) => {
        value.checkpointId = 'runtime-prototype-api.v0'
      },
    ],
    [
      'old schema version',
      (value: Record<string, unknown>) => {
        value.schemaVersion = 0
      },
    ],
    [
      'different baseline',
      (value: Record<string, unknown>) => {
        value.productBaseline = '0'.repeat(40)
      },
    ],
    [
      'forged digest',
      (value: Record<string, unknown>) => {
        value.snapshotDigest = '0'.repeat(64)
      },
    ],
  ] as const)('rejects %s', (_, mutate) => {
    const candidate = structuredClone(snapshot) as unknown as Record<string, unknown>
    mutate(candidate)
    expect(() => verifyPrototypeSnapshot(root, candidate)).toThrow()
  })

  it.each([
    [
      'sourceFiles',
      (value: PrototypeSnapshot) => {
        const file = value.sourceFiles[0]
        if (!file) throw new Error('source manifest is empty')
        file.sha256 = '0'.repeat(64)
      },
    ],
    [
      'sourceFiles',
      (value: PrototypeSnapshot) => {
        value.sourceFiles.pop()
      },
    ],
    [
      'generatedFiles',
      (value: PrototypeSnapshot) => {
        const file = value.generatedFiles[0]
        if (!file) throw new Error('generated manifest is empty')
        file.sha256 = '0'.repeat(64)
      },
    ],
    [
      'generatedFiles',
      (value: PrototypeSnapshot) => {
        value.generatedFiles.push({ path: '../outside.ts', sha256: '0'.repeat(64) })
      },
    ],
    [
      'publicSurface',
      (value: PrototypeSnapshot) => {
        value.publicSurface.pop()
      },
    ],
    [
      'compileEvidence',
      (value: PrototypeSnapshot) => {
        value.compileEvidence.compilerVersion = '0.0.0'
      },
    ],
    [
      'compileEvidence',
      (value: PrototypeSnapshot) => {
        value.compileEvidence.inputs.pop()
        value.compileEvidence.inputDigest = jsonDigest(value.compileEvidence.inputs)
        const { reportDigest: _, ...report } = value.compileEvidence
        value.compileEvidence.reportDigest = jsonDigest(report)
      },
    ],
  ] as const)(
    'rejects rehashed forged or omitted %s evidence',
    (field, mutate) => {
      const candidate = structuredClone(snapshot)
      mutate(candidate)
      expect(() => verifyPrototypeSnapshot(root, rehash(candidate))).toThrow(`snapshot ${field}`)
    },
    60_000,
  )

  it('rejects a missing method in the actual authority schema', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'agnes-prototype-surface-'))
    try {
      const path = 'packages/protocol/schema/runtime/prototype.json'
      const schema = JSON.parse(readFileSync(join(root, path), 'utf8'))
      delete schema['x-state-store-control'].open
      mkdirSync(dirname(join(fixture, path)), { recursive: true })
      writeFileSync(join(fixture, path), JSON.stringify(schema))
      expect(() => buildPrototypeSnapshot(fixture)).toThrow(
        'required public method or payload missing: StateStoreControl.open',
      )
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('rejects a real public compilation error instead of retaining an earlier pass', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'agnes-prototype-compile-'))
    try {
      for (const { path } of snapshot.compileEvidence.inputs) {
        mkdirSync(dirname(join(fixture, path)), { recursive: true })
        cpSync(join(root, path), join(fixture, path))
      }
      symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'), 'junction')
      const agnes = join(fixture, 'packages/extension-api/node_modules/@agnes')
      mkdirSync(agnes, { recursive: true })
      symlinkSync(join(fixture, 'packages/protocol'), join(agnes, 'protocol'), 'junction')
      for (const pkg of ['protocol', 'protocol-validation']) {
        const target = join(fixture, 'packages', pkg, 'node_modules/@sinclair')
        mkdirSync(target, { recursive: true })
        symlinkSync(
          join(root, 'packages', pkg, 'node_modules/@sinclair/typebox'),
          join(target, 'typebox'),
          'junction',
        )
      }
      expect(compilePrototype(fixture).diagnostics).toEqual([])
      const consumer = join(fixture, 'packages/extension-api/test/runtime/prototype-consumer.compile.ts')
      const source = readFileSync(consumer, 'utf8')
      writeFileSync(consumer, `${source}\nconst invalid: string = 123\n`)
      expect(() => compilePrototype(fixture)).toThrow('public prototype API compilation failed')
      writeFileSync(consumer, source)
      const schemaPath = join(fixture, 'packages/protocol/schema/runtime/prototype.json')
      const schema: JsonSchemaDoc = JSON.parse(readFileSync(schemaPath, 'utf8'))
      const methods = schema['x-state-store-control'] as Record<string, { input: string }>
      const open = methods.open
      if (!open) throw new Error('open must exist before the mutation')
      open.input = 'Id'
      writeFileSync(schemaPath, JSON.stringify(schema))
      for (const [path, content] of Object.entries(generateRuntimeArtifacts(schema)))
        writeFileSync(join(fixture, 'packages/protocol', path), content)
      expect(() => compilePrototype(fixture)).toThrow('public prototype API compilation failed')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  }, 60_000)

  it('refuses absolute paths and traversal before reading manifest bytes', () => {
    for (const path of ['/outside.ts', '../outside.ts', 'tools/../outside.ts', 'tools\\outside.ts'])
      expect(() => digestFiles(root, [path])).toThrow('invalid manifest path')
  })
})
