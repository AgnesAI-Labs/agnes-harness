/** Complete, reviewable source. Never activated by this package itself. */
export function ruleFiles() {
  const manifest = {
    name: 'sableleaf-calibration-window',
    version: '1.0.0',
    type: 'module',
    license: 'Apache-2.0',
    exports: './index.mjs',
    files: ['index.mjs', 'skills', 'test'],
    scripts: { test: 'node --test' },
    agnes: {
      provides: ['tool', 'skills'],
      plugins: [
        {
          id: 'ext:sableleaf-calibration-window/main',
          export: 'main',
          apiRange: '^5.0.0',
          inject: ['tools', 'skills'],
        },
      ],
      hostProvidedExternals: { '@agnes/plugin-runtime': '0.0.0', '@sinclair/typebox': '~0.34.0' },
      metadata: {
        displayName: 'Calibration expiry window',
        summary: 'Reviewed synthetic rule: flag equipment use within seven days of expiry.',
        description: 'Read-only date comparison; does not alter or release batches.',
        locales: {
          'zh-CN': {
            displayName: '校准到期窗口',
            summary: '人工审阅的合成检查：使用日期距校准到期 7 天内预警。',
            description: '只读日期比较，不修改或放行批次。',
          },
        },
      },
    },
  }
  const source = `import { defineAgnesPlugin, defineTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'
export function check(processedOn, calibrationDue) {
  const parse = value => { const date = new Date(value + 'T00:00:00Z'); if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value) throw new Error('Invalid date / 日期无效'); return date.getTime() }
  const days = (parse(calibrationDue)-parse(processedOn))/86400000
  return { days, nearExpiry: days >= 0 && days <= 7, expired: days < 0 }
}
export const main = defineAgnesPlugin({ inject: ['tools', 'skills'], apply(ctx) {
  ctx.skills.register({name:'calibration-window',description:'Flag equipment use within 7 days of expiry / 校准到期前7天预警',body:'Compare actual process date with calibration due date using sableleaf_calibration_window. Report expired separately. Do not release a batch. / 比较使用日期和校准到期日，逾期单独报告，不放行。'})
  ctx.tools.register(defineTool({ name:'sableleaf_calibration_window', description:'Read-only reviewed calibration expiry rule / 只读校准到期规则',parameters:Type.Object({processedOn:Type.String({pattern:'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'}),calibrationDue:Type.String({pattern:'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'})},{additionalProperties:false}),result:Type.Object({days:Type.Number(),nearExpiry:Type.Boolean(),expired:Type.Boolean()},{additionalProperties:false}),meta:{isReadOnly:true,isDestructive:false,isConcurrencySafe:true,isOpenWorld:false,replay:'safe',requiresApproval:'never'},async execute(input,call){call.signal.throwIfAborted();const output=check(input.processedOn,input.calibrationDue);return {content:[{type:'text',text:JSON.stringify(output)}],structured:output}}}))
} })
`
  const test = `import { test } from 'node:test'; import assert from 'node:assert/strict'; import {check} from '../index.mjs'; test('window includes 0 and 7 days; separates expired and distant dates',()=>{for(const [date,near,expired] of [['2024-10-13',true,false],['2024-10-20',true,false],['2024-10-12',false,false],['2024-10-21',false,true]])assert.deepEqual(check(date,'2024-10-20'),{days:(Date.parse('2024-10-20')-Date.parse(date))/86400000,nearExpiry:near,expired});assert.throws(()=>check('2024-02-30','2024-10-20'))})\n`
  return [
    { path: 'package.json', content: JSON.stringify(manifest, null, 2) },
    { path: 'index.mjs', content: source },
    { path: 'test/rule.test.mjs', content: test },
    {
      path: 'skills/calibration-window/SKILL.md',
      content:
        '---\nname: calibration-window\ndescription: Reviewed seven-day calibration expiry rule / 校准到期前七天检查\n---\nCompare process date and calibration due date; flag 0–7 days inclusive and report overdue separately. Never authorize batch release. / 比较使用日期和到期日，0–7天预警，逾期单列，不能授权放行。\n',
    },
  ]
}
