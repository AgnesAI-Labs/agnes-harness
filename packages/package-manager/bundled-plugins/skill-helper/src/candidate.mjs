import { fail } from './content.mjs'

// Code-bearing Skills retain static loading, author tests and human publication.
export async function createSkillCandidate(args, checked, ctx) {
  const name = 'agh-skill-' + args.name
  const candidateFiles = [
    {
      path: 'package.json',
      content: JSON.stringify({
        name,
        version: '0.1.0',
        type: 'module',
        license: 'MIT',
        agnes: {
          contributions: [
            {
              kind: 'skill',
              id: name + '/main',
              path: './skills/' + args.name + '/SKILL.md',
            },
          ],
        },
      }),
    },
    {
      path: 'README.md',
      content:
        'Human-reviewed static Skill package. Publication is profile-scoped. Name, description and invocation flags come from SKILL.md. Static package Skills have priority 50; same-name user Skills take precedence. Scripts require normal tool approval. Existing runtime Skill packages require a reviewed update to migrate.\n',
    },
    ...checked.map((f) => ({
      path: 'skills/' + args.name + '/' + f.path,
      content: new TextDecoder('utf-8', { fatal: true }).decode(f.content),
    })),
    {
      path: 'test/skill.test.mjs',
      content: `import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';test('reviewed Skill uses the static document loader',()=>{const pkg=JSON.parse(readFileSync('package.json','utf8'));assert.deepEqual(pkg.agnes.contributions,[{kind:'skill',id:${JSON.stringify(name + '/main')},path:'./skills/${args.name}/SKILL.md'}]);assert.equal(pkg.agnes.plugins,undefined);const body=readFileSync('skills/${args.name}/SKILL.md','utf8');assert.match(body,/^---\\r?\\n/);assert.ok(Buffer.byteLength(body)<=131072)})\n`,
    },
  ]
  // Creation has the candidate tree budget; import keeps its separate source limits.
  if (
    candidateFiles.length > 64 ||
    candidateFiles.some(
      (file) =>
        file.path.length > 240 || Buffer.byteLength(file.content) > 128 * 1024 || file.content.includes('\0'),
    ) ||
    candidateFiles.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > 256 * 1024
  )
    throw fail('SIZE_LIMIT')
  const candidate = await ctx.pluginManage.request({
    action: 'candidate.create',
    files: candidateFiles,
  })
  return { ...candidate, proposalId: candidate.candidateId }
}
