// Code-bearing Skills retain the existing candidate, Node author test and human publication path.
export async function createSkillCandidate(args, checked, ctx) {
  const name = `agh-skill-${args.name}`
  const candidateFiles = [
    {
      path: 'package.json',
      content: JSON.stringify({
        name,
        version: '0.1.0',
        type: 'module',
        license: 'MIT',
        exports: './index.mjs',
        agnes: {
          kinds: ['skills'],
          plugins: [
            {
              apiRange: '^4.0.0',
              id: `ext:${name}/main`,
              export: 'main',
              inject: ['skills'],
              capabilities: {},
            },
          ],
        },
      }),
    },
    {
      path: 'index.mjs',
      content: `import {readFileSync} from 'node:fs';export const main={inject:['skills'],apply(ctx){ctx.skills.register({name:${JSON.stringify(args.name)},description:'Use this human-reviewed workflow.',body:readFileSync(new URL('./skills/${args.name}/SKILL.md',import.meta.url),'utf8')})}}\n`,
    },
    {
      path: 'README.md',
      content:
        'Human-reviewed authored Skill package. Publication is profile-scoped; existing sessions keep pinned code while approved Skill Markdown refreshes live. Markdown is data. Scripts require normal tool approval.\n',
    },
    ...checked.map((f) => ({
      path: `skills/${args.name}/${f.path}`,
      content: new TextDecoder('utf-8', { fatal: true }).decode(f.content),
    })),
    {
      path: 'test/skill.test.mjs',
      content: `import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';test('reviewed Skill is Markdown data',()=>{const body=readFileSync('skills/${args.name}/SKILL.md','utf8');assert.match(body,/^---\\r?\\n/);assert.match(body,/description:/);assert.ok(body.length>20)})\n`,
    },
  ]
  const candidate = await ctx.pluginManage.request({
    action: 'candidate.create',
    files: candidateFiles,
  })
  return { ...candidate, proposalId: candidate.candidateId }
}
