import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInThisContext } from 'node:vm'
import { candidateTemplate } from '@agnes/base/plugin-creator'
import * as authorTestkit from '@agnes/host/author-testkit'
import { createPackageManager, parseSource } from '@agnes/package-manager'
import * as runtime from '@agnes/plugin-runtime'
import { providedExternalModules } from '@agnes/plugin-runtime/provided-externals'
import * as clientTestkit from '@agnes/web-client/testkit'
import { React } from '@agnes/web-client/testkit'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

type Source = { path: string; content: string }
const require = createRequire(import.meta.url)
const helper = await import(
  new URL('../../package-manager/bundled-plugins/plugin-helper/index.mjs', import.meta.url).href
)
async function guide(kind: string) {
  const tools = new Map()
  helper.pluginHelper.apply({ tools: { register: (tool: { name: string }) => tools.set(tool.name, tool) } })
  const definition = tools.get('plugin_helper_guide')
  expect(
    definition.parameters.properties.kind.anyOf.map((choice: { const: string }) => choice.const),
  ).toContain(kind)
  const receipt = await definition.execute({ kind }, {})
  if (kind === 'tool-with-panel') {
    const text = receipt.content[0].text
    expect(Buffer.byteLength(text)).toBeLessThan(32768)
    const modelGuide = JSON.parse(text)
    expect(modelGuide.templateRead).toContain('plugin_candidate_read')
    expect(modelGuide.previewFiles.map((file: Source) => file.path).sort()).toEqual([
      'client/agnes.client.json',
      'client/index.js',
      'src/index.ts',
    ])
    for (const preview of modelGuide.previewFiles) {
      const full = receipt.structured.files.find((file: Source) => file.path === preview.path)
      expect(full.content.startsWith(preview.content)).toBe(true)
      expect(preview.truncated).toBe(preview.content !== full.content)
    }
    expect(modelGuide.files).toBeUndefined()
    expect(receipt.structured.files.map((file: Source) => file.path)).toEqual(modelGuide.templateFiles)
  }
  return receipt.structured as {
    files: Source[]
    authoringPath: string
  }
}

// Execute the shipped Node test bodies in this process, with the real public Host registration.
// Only node:test scheduling is adapted; no daemon, worker, CLI or OS subprocess is started.
async function runTemplateTests(directory: string, files: Source[]) {
  const cases: { name: string; body: () => Promise<void> }[] = []
  const sdk: Record<string, unknown> = {
    '@agnes/plugin-runtime': runtime,
    react: { ...React, default: React },
    '@agnes/web-client/testkit': clientTestkit,
    ...providedExternalModules,
    '@agnes/host/author-testkit': {
      ...authorTestkit,
      createPluginTestHost: (
        plugin: Parameters<typeof authorTestkit.createPluginTestHost>[0],
        options = {},
      ) => authorTestkit.createPluginTestHost(plugin, { packageDir: directory, ...options }),
    },
    'node:test': { test: (name: string, body: () => Promise<void>) => cases.push({ name, body }) },
  }
  for (const file of files.filter((file) => /\.test\.mjs$/.test(file.path))) {
    const compiled = await build({
      entryPoints: [join(directory, file.path)],
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'cjs',
      write: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'source-asset-urls',
          setup(b) {
            b.onLoad({ filter: /\.(ts|mjs|js)$/ }, (args) => ({
              loader: args.path.endsWith('.ts') ? 'ts' : 'js',
              contents: readFileSync(args.path, 'utf8').replaceAll(
                'import.meta.url',
                JSON.stringify(pathToFileURL(args.path).href),
              ),
            }))
          },
        },
      ],
    })
    const output = compiled.outputFiles[0]
    if (!output) throw new Error('No compiled test output')
    const module = { exports: {} }
    const evaluate = runInThisContext(`(function(require, module, exports) {${output.text}\n})`)
    evaluate(
      (name: string) => {
        if (Object.hasOwn(sdk, name)) return sdk[name]
        if (isBuiltin(name)) return require(name)
        throw new Error(`Unexpected test dependency ${name}`)
      },
      module,
      module.exports,
    )
  }
  expect(cases.length).toBeGreaterThan(0)
  for (const test of cases) {
    try {
      await test.body()
    } catch (error) {
      throw new Error(test.name, { cause: error })
    }
  }
}

it.each(['tool', 'tool-with-panel', 'skin', 'skill', 'scaffold-tool', 'scaffold-tool-with-panel'])(
  'runs %s shipped tests through public real-Host registration/invocation and validates descriptors',
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'agh-template-host-'))
    const directory = join(root, 'candidate')
    try {
      const files = kind.startsWith('scaffold-')
        ? candidateTemplate(kind.slice('scaffold-'.length), 'my-agh-plugin')
        : (await guide(kind)).files
      for (const file of files) {
        mkdirSync(dirname(join(directory, file.path)), { recursive: true })
        writeFileSync(join(directory, file.path), file.content)
      }
      await runTemplateTests(directory, files)
      const dataDir = join(root, 'test-state')
      const preview = await createPackageManager({
        dataDir,
        agnesVersion: '0.1.0',
        cwd: directory,
        ceiling: ['ui', 'store'],
      }).inspect(join(dataDir, 'profiles/local-dev'), parseSource(`file:${directory.split(sep).join('/')}`))
      expect(preview.blockers).toEqual([])
      if (kind.endsWith('tool-with-panel'))
        expect(preview.contributions).toMatchObject([
          { kind: 'client', client: { lifetime: 'profile', homeEntries: [{ placement: 'secondary' }] } },
        ])
      if (kind === 'skin')
        expect(preview.contributions).toMatchObject([{ kind: 'client', skins: [{ id: 'mint' }] }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

it('discovers panel capability on the same shared authoring path and reuses the existing template', async () => {
  const evaluation = JSON.parse(
    readFileSync(
      new URL('../../base/extensions/plugin-creator/test/authoring-behavior.eval.json', import.meta.url),
      'utf8',
    ),
  )
  const session = evaluation.cases.find(
    (entry: { name: string }) => entry.name === 'tool plus panel with plugin app storage',
  )
  expect(session.deterministic.storage).toBe('plugin-profile')
  const panel = await guide(session.deterministic.guideKind)
  expect(panel.authoringPath).toContain('optional ToolContext.store')
  const scaffold = candidateTemplate('tool-with-panel', 'my-agh-plugin')
  for (const path of [
    'src/index.ts',
    'client/index.js',
    'client/agnes.client.json',
    'test/plugin.test.mjs',
    'test/panel.test.mjs',
  ])
    expect(panel.files.find((file) => file.path === path)).toEqual(
      scaffold.find((file) => file.path === path),
    )
  for (const term of [
    'tool-with-panel',
    'SAME candidate',
    'mode: "merge"',
    'Untouched files',
    'remove',
    'FINAL candidateHash',
    'WORKSPACE access',
    '--agnes-text-primary',
  ])
    expect(panel.authoringPath).toContain(term)
})

it('review: panel preserves unresolved operation identity across remount', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agh-panel-review-'))
  const directory = join(root, 'candidate')
  try {
    const files = candidateTemplate('tool-with-panel', 'my-agh-plugin')
    const panel = files.find((file) => file.path === 'test/panel.test.mjs')
    if (!panel) throw new Error('Panel fixture missing')
    const prefix = panel.content.slice(0, panel.content.indexOf("test('"))
    panel.content = `${prefix}
test('unresolved operation retains its identity on reopening', async () => {
  const { client } = JSON.parse(await readFile(new URL('../client/agnes.client.json', import.meta.url), 'utf8'));
  const identity = {
    packageId: 'my-agh-plugin', rowId: 'ext:my-agh-plugin/main', revision: 'one',
    services: client.services, homeEntries: client.homeEntries, publicConfig: client.publicConfig,
    binding: { owner: 'ext:my-agh-plugin/main', packageId: 'my-agh-plugin', lifetime: 'profile', availability: 'active', integrity: 'one', profileId: 'test', activationId: 'current' }
  };
  const operations = [];
  const caller = async (_module, name, input, options) => {
    if (name.endsWith('.list')) return { output: { items: [] } };
    if (!options.read) operations.push(options.operationId);
    return { state: 'unknown', operationId: options.operationId };
  };
  let host;
  let storage = [];
  try {
    for (let pass = 0; pass < 2; pass++) {
      host = await createClientPanelTestHost(module, identity, caller);
      for (const [key, value] of storage) host.window.sessionStorage.setItem(key, value);
      await host.render(client.homeEntries[0].id);
      const input = host.container.querySelector('input:not([type=checkbox])');
      await host.act(async () => {
        input.value = 'Same unresolved task';
        input.dispatchEvent(new host.window.Event('input', { bubbles: true }));
      });
      await host.act(async () => host.container.querySelector('button[type=submit]').click());
      if (pass === 0) {
        assert.equal(input.disabled, true);
        assert.match(host.container.textContent, /unknown/);
        storage = Array.from({ length: host.window.sessionStorage.length }, (_, i) => {
          const key = host.window.sessionStorage.key(i);
          return [key, host.window.sessionStorage.getItem(key)];
        });
        await host.dispose();
        host = undefined;
      }
    }
    assert.equal(operations.length, 1, 'Reopening must retain the unresolved operation rather than dispatch the same intent with a fresh id');
  } finally {
    await host?.dispose();
  }
});
`
    for (const file of files) {
      mkdirSync(dirname(join(directory, file.path)), { recursive: true })
      writeFileSync(join(directory, file.path), file.content)
    }
    await runTemplateTests(directory, [panel])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
