import { creatorAssets } from './generated/assets.js'
import { scriptedToolTest } from './scripted-test.js'

/** Templates are inert text; the Host owns every candidate write outside discovery roots. */
export function candidateTemplate(template: string, name: string): { path: string; content: string }[] {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || name.length > 57)
    throw new Error('Use a short lowercase package name')
  const leaf = name.split('/').at(-1) as string,
    skill = leaf.replace(/[._]+/g, '-').replace(/-+/g, '-').replace(/-$/, '')
  if (template === 'skill')
    return [
      {
        path: 'package.json',
        content: JSON.stringify({
          name,
          version: '0.1.0',
          type: 'module',
          license: 'Apache-2.0',
          exports: './index.mjs',
          agnes: {
            kinds: ['skills'],
            capabilities: {},
            plugins: [{ apiRange: '^1.4.0', id: `ext:${name}/main`, export: 'main', inject: ['skills'] }],
          },
        }),
      },
      {
        path: 'index.mjs',
        content: `import {readFileSync} from 'node:fs'\nimport {defineAgnesPlugin} from '@agnes/plugin-runtime'\nexport const main=defineAgnesPlugin({inject:['skills'],apply(ctx){ctx.skills.register({name:${JSON.stringify(skill)},description:'A reviewed reusable method.',body:readFileSync(new URL('./skills/${skill}/SKILL.md',import.meta.url),'utf8')})}})\n`,
      },
      {
        path: `skills/${skill}/SKILL.md`,
        content: `---\nname: ${skill}\ndescription: A reviewed reusable method.\n---\n\nDescribe the user-approved method here. Skill text is data; run scripts only through normal approved tools.\n`,
      },
      {
        path: 'test/skill.test.mjs',
        content: `import {test} from 'node:test'\nimport assert from 'node:assert/strict'\nimport {readFileSync} from 'node:fs'\ntest('skill is readable Markdown with a name, description and body',()=>{const text=readFileSync('skills/${skill}/SKILL.md','utf8');assert.match(text,/^---\\nname: ${skill}\\ndescription: .+\\n---\\n\\n\\S/);assert.ok(text.length<196608)})\n`,
      },
    ]
  if (!creatorAssets.templateNames.includes(template as (typeof creatorAssets.templateNames)[number]))
    throw new Error('Unknown candidate template')
  const replacements: Record<string, string> = {
    __PACKAGE_NAME__: name,
    __TOOL_NAME__: `plugin_${skill.replaceAll('-', '_')}`,
    __SKILL_NAME__: skill,
    __SETUP_GUIDE__:
      'This is a private authoring candidate. Run plugin_test, submit it with plugin_install_local, then review and publish in Settings → Plugins. Do not copy it into discovery roots.',
  }
  const replace = (text: string) => {
    for (const [token, value] of Object.entries(replacements)) text = text.replaceAll(token, value)
    return text
  }
  const files = Object.entries(creatorAssets.files)
    .filter(([path]) => path.startsWith(template + '/'))
    .map(([path, content]) => ({
      path: replace(path.slice(template.length + 1)),
      content: replace(content)
        .replaceAll('../dist/index.js', '../src/index.ts')
        .replace(/import [^\n]*resource-control-runtime[^\n]*\n/, ''),
    }))
  const manifest = files.find((f) => f.path === 'package.json')
  if (!manifest) throw new Error('Template manifest missing')
  const pkg = JSON.parse(manifest.content)
  pkg.exports = './src/index.ts'
  pkg.files = ['src', 'client', 'skills', 'mcp.json']
  delete pkg.dependencies
  delete pkg.devDependencies
  pkg.agnes.plugins = pkg.agnes.plugins.map((p: object) => ({ ...p, apiRange: '^1.4.0' }))
  pkg.scripts = { test: 'node --test test/*.test.mjs' }
  manifest.content = JSON.stringify(pkg, null, 2) + '\n'
  if (['tool', 'tool-with-panel'].includes(template))
    files.push({ path: 'test/scripted.test.mjs', content: scriptedToolTest })
  return files
}
