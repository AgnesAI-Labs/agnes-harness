import { validatePackageAdminData } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { summarizePackageIncludes } from '../src/package-includes.js'
import { presentPluginRows } from '../src/package-presentation.js'
import type { AgnesPluginManifestEntry } from '../src/plugin-manifest.js'

const plugin = (capabilities?: AgnesPluginManifestEntry['capabilities']) =>
  ({ id: 'ext:acme/kit/main', ...(capabilities ? { capabilities } : {}) }) as AgnesPluginManifestEntry

it('counts only what the package data states and names the rest by kind', () => {
  // Tools registered in code are named by the declared kind, with no number to show.
  expect(
    summarizePackageIncludes({
      provides: ['bundle', 'loop', 'tool', 'skills', 'mcp'],
      plugins: [plugin({ network: [] })],
      bundles: { triage: {}, review: {} },
    }),
  ).toEqual({ provides: ['tool', 'loop', 'mcp', 'skills', 'bundle'], counts: { bundles: 2 } })

  // Declared tool names, skill files and browser UI are counted; the data alone proves their kinds.
  expect(
    summarizePackageIncludes({
      plugins: [
        plugin({ tools: { prefix: 'kit_', names: ['read', 'write'] }, resources: ['mcp'] }),
        plugin({ tools: { prefix: 'kit_', names: ['write'] } }),
      ],
      contributions: [
        { kind: 'skill', id: 'playbook', path: './skills/playbook/SKILL.md' },
        { kind: 'client', id: 'plugin/0123456789abcdef', rowId: 'ext:acme/kit/main', path: './c.json' },
      ] as never,
    }),
  ).toEqual({ provides: ['tool', 'mcp', 'skills', 'ui'], counts: { tools: 2, skills: 1, ui: 1 } })

  // Nothing declared and nothing provable: no summary at all rather than an empty one.
  expect(summarizePackageIncludes({ plugins: [plugin()] })).toBeUndefined()
})

it('travels on the presentation and satisfies the public schema', () => {
  const presentation = presentPluginRows([plugin()], {
    packageId: 'acme/kit',
    bundles: { triage: {} },
    provides: ['bundle', 'tool'],
  })
  expect(presentation.includes).toEqual({ provides: ['tool', 'bundle'], counts: { bundles: 1 } })
  expect(validatePackageAdminData('PackagePresentation', presentation).ok).toBe(true)
})
