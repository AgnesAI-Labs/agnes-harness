import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  type HostAllowance,
  hostFindings,
  hostInventory,
  hostViolations,
  templateFindings,
} from './host-business.js'
import { assertHostPackageCoverage, businessCatalogue } from './host-business-catalogue.js'
import { hostAllowanceGrowth, protectedAllowance } from './protected-allowances.js'
import { repoRoot } from './repo.js'
import { CODE_EXTENSIONS, productionFiles, withSourceTrees } from './source-ast.js'

const root = repoRoot()
const catalogue = businessCatalogue(root)
const scratch = mkdtempSync(join(tmpdir(), 'agh-host-fence-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const cases = [
  [
    'spoofed CU',
    `export function bind(trustedCommunity) { if (trustedCommunity.id === 'agnes/computer-use') return true }`,
  ],
  [
    'spoofed Base',
    `export function bind(trustedCommunity) { return trustedCommunity.package === '@agnes/base' }`,
  ],
  ['manifest identity', `const choice = 'tool-policy:default'`],
  ['manifest export', `const name = 'codexChildAgentsPlugin'`],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source for a template-fragment fixture
  ['template fragment', 'const prefix = `builtin:@agnes/base/${name}`'],
  ['regexp', 'const special = /^ext:agnes\\/mcp-[a-z]+$/.test(id)'],
  [
    'default import alias',
    `import { DEFAULT_LOOP as selection } from '@agnes/core'; const alias = selection; if (loop === alias) bind()`,
  ],
  ['namespace default', `import * as core from '@agnes/core'; const choice = core.DEFAULT_LOOP`],
  [
    'business alias branch',
    `const business = '@agnes/base'; const alias = business; if (owner === alias) bind()`,
  ],
  ['dynamic import', `const adapter = import('@agnes/ai')`],
  ['import type', `type Adapter = import('@agnes/ai').Adapter`],
  ['export', `export { Adapter } from '@agnes/ai'`],
  ['implementation leaf', `export { correlatedLogger } from '@agnes/observability'`],
  ['default re-export', `export { DEFAULT_LOOP as selection } from '@agnes/core'`],
  ['namespace element default', `import * as core from '@agnes/core'; const choice = core['DEFAULT_LOOP']`],
  [
    'namespace destructured default',
    `import * as core from '@agnes/core'; const { DEFAULT_LOOP: choice } = core;`,
  ],
  ['daemon peer import', `import type { PublishChildEngines } from '@agnes/daemon-rpc/local/methods/config'`],
  ['daemon peer name branch', `if (owner === '@agnes/daemon-admin') bind()`],
  [
    'typed capabilities',
    `const declaration = { kind: 'child-agent', capabilities: { tools: true, artifacts: true }, owner: community };`,
  ],
  [
    'internal symbols',
    `const owner = Symbol('agnes.host-fs-policy'); const activation = Symbol.for('agnes.activation-owner');`,
  ],
  [
    'wire contract',
    `const event = 'x/agnes/intelligent-ui/action.authenticated'; if (row.type === event) readReceipt()`,
  ],
  [
    'contract leaf',
    `import type { ToolContext } from '@agnes/extension-api'; import type { ObservabilityContract } from '@agnes/observability/contract'; const kind = 'model-adapter';`,
  ],
] as const
const paths = cases.map(([, source], index) => {
  const extension = /\b(?:import\s+type|type\s+\w+\s*=)/.test(source)
    ? '.ts'
    : CODE_EXTENSIONS[index % CODE_EXTENSIONS.length]
  const file = join(scratch, `case-${index}${extension}`)
  writeFileSync(file, source)
  return file
})
const classified = withSourceTrees(paths, (trees) => ({
  host: trees.map((tree) => hostFindings(tree, 'packages/host/src/example.ts', catalogue)),
  core: trees.map((tree) => hostFindings(tree, 'packages/core/src/registry/tools.ts', catalogue)),
  daemon: trees.map((tree) =>
    hostFindings(tree, 'packages/daemon/src/supervisor/assembly-runtime.ts', catalogue),
  ),
}))
const results = classified.host

describe('Host excludes official business identities/implementations; reviewed legacy only shrinks', () => {
  it('checks production sources, templates and dependency manifests', () => {
    const current = hostInventory(root)
    console.info(
      `Host semantic fence: ${current.files} production sources; ${current.manifests} official manifests; ${current.findings.length} occurrences`,
    )
    const path = 'tools/guards/host-business-allowlist.json'
    const text = readFileSync(join(root, path), 'utf8')
    const allowances = JSON.parse(text) as HostAllowance[]
    const contractPath = 'tools/guards/host-business-contracts.json'
    const contractText = readFileSync(join(root, contractPath), 'utf8')
    const contracts = JSON.parse(contractText) as Omit<HostAllowance, 'removal'>[]
    expect(hostViolations(current.findings, allowances, contracts)).toEqual([])
    expect(hostAllowanceGrowth(allowances, protectedAllowance(root, path, text))).toEqual([])
    // Retained contracts also cannot become a new identity escape hatch.
    expect(
      hostAllowanceGrowth(
        contracts.map((entry) => ({ ...entry, removal: 'contract' })),
        protectedAllowance<Omit<HostAllowance, 'removal'>[]>(root, contractPath, contractText).map(
          (entry) => ({ ...entry, removal: 'contract' }),
        ),
      ),
    ).toEqual([])
  })
  it.each(cases.map(([name], index) => [name, index] as const))(
    '%s is classified correctly',
    (_name, index) => {
      expect((results[index]?.length ?? 0) > 0).toBe(index < 18)
      expect((classified.core[index]?.length ?? 0) > 0).toBe(index < 18)
      expect((classified.daemon[index]?.length ?? 0) > 0).toBe(index < 16 || index === 17)
    },
  )
  it('rejects occurrence growth, a new comparison branch, moved symbols, stale/additional/enlarged allowances', () => {
    const finding = results[1]?.[0]
    if (!finding) throw new Error('missing fixture')
    const entry: HostAllowance = {
      ...finding,
      max: 1,
      removal: 'A2: replace name dispatch with reviewed capability binding',
    }
    expect(hostViolations([finding], [entry], [])).toEqual([])
    expect(hostViolations([finding, finding], [entry], [])).not.toEqual([])
    expect(hostViolations([{ ...finding, role: 'literal' }], [entry], [])).not.toEqual([])
    expect(hostViolations([{ ...finding, symbol: 'moved' }], [entry], [])).not.toEqual([])
    expect(hostViolations([], [entry], [])).not.toEqual([])
    expect(hostAllowanceGrowth([entry], [])).not.toEqual([])
    expect(hostAllowanceGrowth([{ ...entry, max: 2 }], [entry])).not.toEqual([])
    expect(hostAllowanceGrowth([], [entry])).toEqual([])
    expect(hostViolations([finding], [{ ...entry, path: 'packages/host/**' }], [])).not.toEqual([])
  })
  it('a wire namespace does not conceal an additional business identity in the same string', () => {
    const file = join(scratch, 'mixed-peer.ts')
    writeFileSync(file, "import '@agnes/daemon-admin/@agnes/base'")
    expect(
      withSourceTrees([file], (trees) =>
        trees.flatMap((tree) =>
          hostFindings(tree, 'packages/daemon/src/supervisor/assembly-runtime.ts', catalogue),
        ),
      ),
    ).toHaveLength(1)
    expect(
      templateFindings('id: "x/agnes/intelligent-ui/action @agnes/base"', 'template.yaml', catalogue),
    ).toHaveLength(1)
  })
  it('checks quoted/unquoted template identities while accepting generic declarations and host paths', () => {
    expect(templateFindings('id: agnes/computer-use', 'template.yaml', catalogue)).toHaveLength(1)
    expect(
      templateFindings('ids: [agnes/computer-use, agnes/computer-use]', 'template.yaml', catalogue),
    ).toHaveLength(2)
    expect(templateFindings('package: "@agnes/base"', 'template.yaml', catalogue)).toHaveLength(1)
    expect(
      templateFindings(
        'kind: child-agent\ncapabilities: [tools]\npath: /etc/agnes/secrets',
        'template.yaml',
        catalogue,
      ),
    ).toEqual([])
  })
  it('scans production fixtures and every handwritten extension; empty and unknown roots fail', () => {
    const dir = join(scratch, 'production')
    mkdirSync(join(dir, 'fixtures'), { recursive: true })
    const files = CODE_EXTENSIONS.map((ext) => {
      const path = join(dir, 'fixtures', `escape${ext}`)
      writeFileSync(path, `const choice = '@agnes/base'`)
      return path
    })
    expect(productionFiles(dir)).toEqual(files.sort())
    const violations = withSourceTrees(files, (trees) =>
      trees.map((tree, index) => hostFindings(tree, files[index] as string, catalogue)),
    )
    expect(violations.every((entries) => entries.length > 0)).toBe(true)
    writeFileSync(join(dir, 'escape.coffee'), "choice = '@agnes/base'")
    expect(() => productionFiles(dir)).toThrow(/suffix/)
    expect(() => productionFiles(join(scratch, 'absent'))).toThrow(/Empty/)
    const hidden = join(scratch, 'packages/host-hidden')
    mkdirSync(hidden, { recursive: true })
    writeFileSync(join(hidden, 'package.json'), JSON.stringify({ name: '@agnes/host-hidden' }))
    expect(() => assertHostPackageCoverage(scratch)).toThrow(/Unclassified Host package/)
  })
})
