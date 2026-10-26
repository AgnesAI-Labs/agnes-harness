import { startProviderFixture } from '../acceptance/provider-fixture.js'
import { expect, test } from './fixtures.js'
import { settled } from './quality.js'
import { openWorkspace, turn } from './ui.js'

test('Answer tables keep first and last column text off the frame edge', async ({ page, runtime }) => {
  test.setTimeout(120_000)
  const columns = [
    '任务ID',
    '任务名称',
    '负责人',
    '优先级',
    '开始时间',
    '结束时间',
    '状态',
    '预算(元)',
    '实际支出(元)',
    '备注',
  ]
  const rows = columns.map((name, index) => `| ${String.fromCharCode(65 + index)} | ${name} | 说明 ${name} |`)
  const reply = [
    '## 测试数据表.xlsx 分析',
    '',
    '这是一份项目任务管理表，共 15 条任务记录，字段共 10 列。',
    '',
    '### 表格结构',
    '',
    '| 列 | 字段名 | 说明 |',
    '|---|---|---|',
    ...rows,
    '',
    '### 数据预览',
    '',
    `| ${columns.join(' | ')} |`,
    `|${columns.map(() => '---').join('|')}|`,
    ...Array.from(
      { length: 5 },
      (_, i) =>
        `| T00${i + 1} | 需求调研与方案评审第${i + 1}阶段 | 张三 | P${i % 3} | 2026-07-0${i + 1} | 2026-07-1${i} | 进行中 | 50000 | 32000 | 无 |`,
    ),
    '',
    '### 总结',
    '',
    '收尾段落。',
  ].join('\n')
  const client = await runtime.connect()
  const model = (await client.config.test({ providerId: 'deepseek' })).models[0]?.id
  if (!model) throw new Error('The local provider catalog must contain a model')
  const provider = await startProviderFixture(reply, undefined, model)
  try {
    const config = await client.config.get()
    await client.config.save({
      providerId: 'deepseek',
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model,
      accountId: 'table-fixture',
      label: 'Synthetic table fixture',
      expectedRevision: config.revision,
      makeDefault: true,
    })
    await openWorkspace(page, runtime)
    await turn(page, '分析这个数据表')
    await settled(page)
    const tables = page.locator('.markdown table')
    await expect(tables).toHaveCount(2)
    // The bordered .table-scroll frame owns the edge, so the outer header and body cells of every
    // table keep their own padding. Computed padding does not depend on how the columns stretch.
    const edges = await tables.evaluateAll((all) =>
      all.flatMap((table) => {
        const frame = (table.closest('.table-scroll') as HTMLElement).getBoundingClientRect()
        return ['thead th', 'tbody td'].flatMap((group) =>
          ['first', 'last'].map((end) => {
            const cell = table.querySelector(`${group}:${end}-child`) as HTMLElement
            const style = getComputedStyle(cell)
            const range = document.createRange()
            range.selectNodeContents(cell)
            return {
              cell: `${group}:${end}-child`,
              padding:
                end === 'first'
                  ? Number.parseFloat(style.paddingLeft)
                  : Number.parseFloat(style.paddingRight),
              // Left-aligned text, so the left gap is also the visible distance to the frame.
              gap:
                end === 'first' ? range.getBoundingClientRect().left - frame.left : Number.POSITIVE_INFINITY,
            }
          }),
        )
      }),
    )
    expect(edges).toHaveLength(8)
    for (const edge of edges) {
      expect(edge.padding, edge.cell).toBeGreaterThanOrEqual(8)
      expect(edge.gap, edge.cell).toBeGreaterThanOrEqual(8)
    }
  } finally {
    await provider.close()
  }
})

test('Answer tables honor GFM column alignment', async ({ page, runtime }) => {
  test.setTimeout(120_000)
  const reply = [
    '| 项目 | 预算(元) | 状态 |',
    '|:---|---:|:---:|',
    '| 调研 | 5 | 完成 |',
    '| 评审 | 12000 | 进行中 |',
  ].join('\n')
  const client = await runtime.connect()
  const model = (await client.config.test({ providerId: 'deepseek' })).models[0]?.id
  if (!model) throw new Error('The local provider catalog must contain a model')
  const provider = await startProviderFixture(reply, undefined, model)
  try {
    const config = await client.config.get()
    await client.config.save({
      providerId: 'deepseek',
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model,
      accountId: 'table-align-fixture',
      label: 'Synthetic table alignment fixture',
      expectedRevision: config.revision,
      makeDefault: true,
    })
    await openWorkspace(page, runtime)
    await turn(page, '给出预算表')
    await settled(page)
    const table = page.locator('.markdown table').last()
    await expect(table).toBeVisible()
    // Header and body cells follow the column's `:---`, `---:` and `:---:` markers; the app layer
    // must not flatten them to one alignment.
    const aligns = await table.evaluate((el) =>
      ['thead th', 'tbody tr:first-child td'].map((row) =>
        [...el.querySelectorAll(row)].map((cell) => getComputedStyle(cell).textAlign),
      ),
    )
    expect(aligns).toEqual([
      ['left', 'right', 'center'],
      ['left', 'right', 'center'],
    ])
  } finally {
    await provider.close()
  }
})
