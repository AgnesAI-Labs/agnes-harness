import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validatePackageAdminData } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { presentPluginRows, readPackagePresentation } from '../src/package-presentation.js'
import type { AgnesPluginManifestEntry } from '../src/plugin-manifest.js'
import { summarizeBundlePresets } from '../src/preset-policy-summary.js'

const plugin = (capabilities?: AgnesPluginManifestEntry['capabilities']) =>
  ({ id: 'ext:acme/kit/main', ...(capabilities ? { capabilities } : {}) }) as AgnesPluginManifestEntry
const preset = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  extends: 'standard',
  ...extra,
})

it('answers yes or no only from what the platform enforces, and unknown for a policy written in code', () => {
  const bundles = {
    base: { profile: { toolPolicy: { readOnly: true } } },
    review: {
      extends: ['acme/kit#base'],
      presets: {
        // Inherits the platform read-only filter, which holds under any provider.
        strict: preset('strict', { providers: { 'tool-policy': { provider: 'acme.strict' } } }),
        // The session bundle is applied after the preset, retaining its read-only filter.
        open: preset('open', { composition: { toolPolicy: { readOnly: false } } }),
      },
    },
    plain: { presets: { plain: preset('plain') } },
    coded: {
      presets: { coded: preset('coded', { providers: { 'tool-policy': { provider: 'acme.coded' } } }) },
    },
    // A parent published by another package is not visible to this package's inspection.
    remote: { extends: ['other/pkg#base'], presets: { remote: preset('remote') } },
  }
  const summaries = summarizeBundlePresets('acme/kit', bundles, [plugin({ network: [] })])
  expect(summaries).toEqual([
    {
      bundle: 'acme/kit#review',
      id: 'strict',
      toolPolicy: 'acme.strict',
      readOnly: 'yes',
      confirmBeforeActions: 'unknown',
      network: 'none',
    },
    {
      bundle: 'acme/kit#review',
      id: 'open',
      toolPolicy: 'default',
      readOnly: 'yes',
      confirmBeforeActions: 'no',
      network: 'none',
    },
    {
      bundle: 'acme/kit#plain',
      id: 'plain',
      toolPolicy: 'default',
      readOnly: 'no',
      confirmBeforeActions: 'no',
      network: 'none',
    },
    {
      bundle: 'acme/kit#coded',
      id: 'coded',
      toolPolicy: 'acme.coded',
      readOnly: 'unknown',
      confirmBeforeActions: 'unknown',
      network: 'none',
    },
    {
      bundle: 'acme/kit#remote',
      id: 'remote',
      toolPolicy: 'default',
      readOnly: 'unknown',
      confirmBeforeActions: 'no',
      network: 'none',
    },
  ])
  // Session bundle patches win over preset patches, including an explicit false. Parent bundles
  // apply in declaration order, once each, rather than treating false as an absent setting.
  for (const [extends_, profile, expected] of [
    [[], { toolPolicy: { readOnly: false } }, 'no'],
    [['acme/kit#base', 'acme/kit#writable'], {}, 'no'],
    [['acme/kit#writable', 'acme/kit#base'], {}, 'yes'],
    [['acme/kit#base', 'acme/kit#writable', 'acme/kit#diamond'], {}, 'no'],
    [['other/pkg#base'], {}, 'unknown'],
  ] as const) {
    expect(
      summarizeBundlePresets(
        'acme/kit',
        {
          ...bundles,
          writable: { profile: { toolPolicy: { readOnly: false } } },
          diamond: { extends: ['acme/kit#base'] },
          selected: {
            extends: extends_,
            profile,
            presets: { selected: preset('selected', { composition: { toolPolicy: { readOnly: true } } }) },
          },
        },
        [plugin({})],
      ).find((entry) => entry.bundle === 'acme/kit#selected')?.readOnly,
    ).toBe(expected)
  }
})

it('reads network use from declared capabilities and omits the field set when a package has no presets', () => {
  const bundles = { plain: { presets: { plain: preset('plain') } } }
  const network = (plugins: AgnesPluginManifestEntry[]) =>
    summarizeBundlePresets('acme/kit', bundles, plugins)[0]?.network
  expect(network([plugin({ network: ['api.example.org'] }), plugin({})])).toBe('allowed')
  expect(network([plugin({ model: true })])).toBe('none')
  expect(network([plugin({ network: [] }), plugin()])).toBe('unknown')
  expect(network([plugin({ network: ['api.example.org'] }), plugin()])).toBe('allowed')
  expect(network([plugin()])).toBe('unknown')
  expect(network([])).toBe('unknown')

  const presentation = presentPluginRows([plugin()], { packageId: 'acme/kit', bundles })
  expect(validatePackageAdminData('PackagePresentation', presentation).ok).toBe(true)
  expect(presentPluginRows([plugin()], { packageId: 'acme/kit', bundles: { base: {} } })).not.toHaveProperty(
    'presets',
  )
  expect(presentPluginRows([plugin()])).not.toHaveProperty('presets')
})

it('gives an installed package the same summary, read from its own directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-preset-summary-'))
  try {
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'acme/kit',
        version: '1.0.0',
        agnes: {
          provides: ['bundle'],
          bundles: {
            safe: { profile: { toolPolicy: { readOnly: true } }, presets: { safe: preset('safe') } },
          },
        },
      }),
    )
    expect(readPackagePresentation(directory, false).presets).toEqual([
      {
        bundle: 'acme/kit#safe',
        id: 'safe',
        toolPolicy: 'default',
        readOnly: 'yes',
        confirmBeforeActions: 'no',
        network: 'unknown',
      },
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
