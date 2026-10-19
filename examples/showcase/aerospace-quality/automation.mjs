// Explicit deployment action. No schedule is installed as a package-load side effect.
import { createClient, memoryJournal } from '@agnes/sdk'
import { resolve } from 'node:path'
const source = process.env.AGH_SOURCE,
  cwd = process.env.AERO_WORKSPACE
if (!source || !cwd) throw new Error('Set AGH_SOURCE and AERO_WORKSPACE / 请设置源码目录与独立工作区')
const client = createClient({
  transport: {
    kind: 'stdio',
    cmd: [
      process.execPath,
      resolve(source, 'agnes.mjs'),
      'app-server',
      '--stdio',
      '--profile',
      process.env.AGNES_PROFILE ?? 'local-dev',
    ],
  },
  auth: { kind: 'local' },
  journal: memoryJournal(),
})
try {
  await client.initialize()
  await client.workspace.add(resolve(cwd))
  const schedules = await client.request('_agnes/v1/schedules.list', { scope: 'all' })
  const existing = schedules.schedules.find(
    (s) => s.title === 'QV-X27 weekly NCR digest / 每周 NCR 摘要' && s.status !== 'archived',
  )
  if (existing) {
    console.log(JSON.stringify(existing))
    process.exitCode = 0
  } else {
    const result = await client.request('_agnes/v1/schedules.upsert', {
      agent: '@agnes-showcase/aerospace-quality#quality',
      title: 'QV-X27 weekly NCR digest / 每周 NCR 摘要',
      prompt:
        '先调用 aero_playbook 和 aero_quality(view=dashboard)，再调用 aero_report(kind=digest, locale=zh-CN) 生成本周 NCR 摘要。只报告当前证据，不处置硬件、不批准更改。 / Read the playbook and dashboard; generate a weekly digest with aero_report. No hardware disposition or configuration approval.',
      selector: { weekly: { time: '09:00', timeZone: 'Asia/Shanghai', weekdays: [1] } },
      target: { kind: 'new-session', cwd: resolve(cwd), unattendedApproval: 'refuse' },
    })
    if (result.updated === false) throw new Error(`Schedule refused: ${result.code}`)
    console.log(JSON.stringify(result, null, 2))
  }
} finally {
  await client.close()
}
