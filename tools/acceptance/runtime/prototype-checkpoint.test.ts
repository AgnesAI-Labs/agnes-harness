import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { generateFullRuntimeArtifacts } from '../../../packages/protocol/tools/gen-runtime-full.js'
import {
  ARTIFACT_PATH,
  buildPrototypeSnapshot,
  type PrototypeSnapshot,
  verifyPrototypeSnapshot,
} from '../../runtime-prototype/checkpoint.js'
import { compilePrototype, compilerProjectFiles } from '../../runtime-prototype/compile.js'
import { digestFiles, jsonDigest } from '../../runtime-prototype/files.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
let snapshot: PrototypeSnapshot
const rehash = (value: PrototypeSnapshot): PrototypeSnapshot => {
  const { snapshotDigest: _, ...body } = value
  return { ...body, snapshotDigest: jsonDigest(body) }
}

/** Workspace links stay in the copied checkout; external compiler dependencies use the installation. */
function linkFixtureDependencies(
  fixture: string,
  inputs: PrototypeSnapshot['compileEvidence']['inputs'],
): void {
  const packages = new Map<string, string>()
  for (const { path } of inputs) {
    if (!/^packages\/[^/]+\/package\.json$/.test(path)) continue
    const manifest = JSON.parse(readFileSync(join(fixture, path), 'utf8')) as { name: string }
    packages.set(manifest.name, dirname(path))
  }
  const link = (source: string, target: string): void => {
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(source, target, 'junction')
  }
  const dependenciesAt = (directory: string): string[] => {
    if (!existsSync(directory)) return []
    return readdirSync(directory).flatMap((name) => {
      if (name.startsWith('.')) return []
      return name.startsWith('@')
        ? readdirSync(join(directory, name)).map((child) => `${name}/${child}`)
        : [name]
    })
  }
  for (const directory of ['', ...packages.values()]) {
    const installed = join(root, directory, 'node_modules')
    const target = join(fixture, directory, 'node_modules')
    mkdirSync(target, { recursive: true })
    for (const name of dependenciesAt(installed)) {
      if (packages.has(name) || name.startsWith('@agnes/')) continue
      const dependency = realpathSync(join(installed, name))
      // A workspace with another scope must also never point back to the source checkout.
      const workspacePath = relative(join(root, 'packages'), dependency)
      if (workspacePath && !isAbsolute(workspacePath) && !workspacePath.startsWith('..')) continue
      link(dependency, join(target, name))
    }
    for (const [name, packageDirectory] of packages) link(join(fixture, packageDirectory), join(target, name))
  }
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
  }, 60_000)

  it.each([
    ['/checkout', '/checkout/'],
    ['C:\\checkout', 'C:/checkout/'],
    ['C:\\checkout', 'c:\\checkout\\'],
    ['\\\\server\\checkout', '//server/checkout/'],
  ])('recognizes compiler inputs inside %s with platform separators', (checkout, prefix) => {
    const consumer = 'packages/extension-api/test/runtime/prototype-consumer.compile.ts'
    const output = [
      `${prefix}${consumer}`,
      `${prefix}node_modules/typescript/lib/lib.es2023.d.ts`,
      `${prefix}packages/protocol/node_modules/@types/node/index.d.ts`,
      `${prefix.replace(/[\\/]$/, '')}-other/packages/foreign.ts`,
      'compiler diagnostic',
    ].join('\r\n')
    expect(compilerProjectFiles(checkout, output)).toEqual([consumer])
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
      linkFixtureDependencies(fixture, snapshot.compileEvidence.inputs)
      expect(
        realpathSync(join(fixture, 'packages/protocol/node_modules/@agnes/resource-control-contracts')),
      ).toBe(realpathSync(join(fixture, 'packages/resource-control-contracts')))
      expect(compilePrototype(fixture).diagnostics).toEqual([])
      const consumer = join(fixture, 'packages/extension-api/test/runtime/prototype-consumer.compile.ts')
      const source = readFileSync(consumer, 'utf8')
      writeFileSync(consumer, `${source}\nconst invalid: string = 123\n`)
      expect(() => compilePrototype(fixture)).toThrow(/prototype-consumer\.compile\.ts.*error TS/)
      writeFileSync(consumer, source)
      const directory = join(fixture, 'packages/protocol/schema/runtime')
      const metadataPath = join(directory, 'local-api.json')
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
        'x-local-api': { runtime: { StateStoreControl: string } }
      }
      const declaration = metadata['x-local-api'].runtime.StateStoreControl
      expect(declaration).toContain('open(request: Wire.StateOpenRequest,')
      metadata['x-local-api'].runtime.StateStoreControl = declaration.replace(
        'open(request: Wire.StateOpenRequest,',
        'open(request: Wire.Id,',
      )
      writeFileSync(metadataPath, JSON.stringify(metadata))
      // Keep the complete public surface and mutate only its generated Local declarations.
      for (const [path, content] of Object.entries(generateFullRuntimeArtifacts(directory))) {
        if (!/^\.\.\/extension-api\/src\/runtime\/public-\d+\.ts$/.test(path)) continue
        writeFileSync(join(fixture, 'packages/protocol', path), content)
      }
      expect(() => compilePrototype(fixture)).toThrow(/prototype-consumer\.compile\.ts.*error TS/)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  }, 60_000)

  it('refuses absolute paths and traversal before reading manifest bytes', () => {
    for (const path of ['/outside.ts', '../outside.ts', 'tools/../outside.ts', 'tools\\outside.ts'])
      expect(() => digestFiles(root, [path])).toThrow('invalid manifest path')
  })
})
