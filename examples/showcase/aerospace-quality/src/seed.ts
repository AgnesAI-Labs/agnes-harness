import { type Criterion, type Method, type State, text } from './model.js'
export const SNAPSHOT = '2026-10-20T08:00:00Z'
export const RULE =
  'Flag ECRs that change part lots on thermally cycled assemblies for additional TVAC screening. Require evidence and human configuration approval; never release hardware automatically. / 热循环组件更换元器件批次时，追加热真空筛选；要求证据和人工技术状态审批，不自动放行硬件。'
const n = (value: number) => String(value).padStart(3, '0')
export function seed(): State {
  const tests = Array.from({ length: 32 }, (_, i) => ({
    id: `VT-${n(i + 1)}`,
    title: text(
      [
        '冷平台驱动电流',
        '阀门动作延时',
        '绝缘电阻',
        '振动后功能',
        '电磁兼容',
        '接口审查',
        '材料检验',
        '热分析',
      ][i % 8]!,
      [
        'Cold plateau drive current',
        'Valve response',
        'Insulation resistance',
        'Post-vibration function',
        'EMC',
        'Interface review',
        'Material inspection',
        'Thermal analysis',
      ][i % 8]!,
    ),
    status: (i === 0 ? 'failed' : i % 7 === 0 ? 'pending' : 'passed') as 'failed' | 'pending' | 'passed',
    configuration: i < 8 ? 'BL-C' : 'BL-B',
    evidence: i % 7 === 0 ? '' : `EV-VT-${n(i + 1)}-R1`,
  }))
  const requirements: State['requirements'] = [
    {
      id: 'SYS-001',
      parent: null,
      title: text('推进阀驱动分系统任务可靠性', 'Propulsion valve-driver mission reliability'),
      method: 'analysis',
      design: ['SYS-SPEC-C'],
      tests: ['VT-008'],
      verified: true,
    },
  ]
  for (let i = 0; i < 6; i++)
    requirements.push({
      id: `SUB-${n(i + 1)}`,
      parent: 'SYS-001',
      title: text(
        ['电气驱动', '热环境适应', '机械环境适应', '电磁兼容', '安全与接口', '材料与工艺'][i]!,
        [
          'Electrical drive',
          'Thermal environment',
          'Mechanical environment',
          'EMC',
          'Safety and interfaces',
          'Materials and processes',
        ][i]!,
      ),
      method: ['test', 'test', 'test', 'test', 'demonstration', 'inspection'][i] as Method,
      design: [`SUB-SPEC-${i + 1}-C`],
      tests: [`VT-${n(i + 1)}`],
      verified: tests[i]!.status === 'passed',
    })
  for (let i = 0; i < 32; i++)
    requirements.push({
      id: `CMP-${n(i + 1)}`,
      parent: i === 31 ? null : `SUB-${n(Math.floor(i / 6) + 1)}`,
      title:
        i === 0
          ? text('−40 °C 冷平台峰值电流 ≤ 1.80 A', 'Peak current ≤ 1.80 A at −40 °C plateau')
          : text(`${tests[i]!.title['zh-CN']}验收条目 ${i + 1}`, `${tests[i]!.title.en} acceptance ${i + 1}`),
      method: ['test', 'analysis', 'inspection', 'demonstration'][i % 4] as Method,
      design: i === 30 ? [] : [`DRV-DWG-${n(i + 1)}-C`],
      tests: i === 29 ? [] : [tests[i]!.id],
      verified: tests[i]!.status === 'passed' && i !== 29,
    })
  const campaigns = Array.from({ length: 6 }, (_, i) => ({
    id: `TC-${n(26 + i)}`,
    title: text(
      [
        '热真空鉴定 · 冷平台',
        '随机振动 · 三轴',
        '电磁兼容 · 传导发射',
        '阀门寿命循环',
        '元器件批次验收',
        '热真空复现试验',
      ][i]!,
      [
        'TVAC qualification · cold plateau',
        'Random vibration · three axes',
        'EMC · conducted emissions',
        'Valve endurance cycling',
        'Component lot acceptance',
        'TVAC reproduction',
      ][i]!,
    ),
    status: ['hold', 'passed', 'passed', 'running', 'pending', 'pending'][i]!,
    configuration: i < 4 ? 'BL-C' : 'BL-D-draft',
    unit: `PVD-${n(11 + i)}`,
    lot: i === 1 ? 'L2607-A' : 'L2609-B',
    started: `2026-10-${18 + (i % 3)}T02:00:00Z`,
    samples: Array.from({ length: i >= 4 ? 0 : 121 }, (_, minute) => ({
      minute,
      current: Number(
        ((i === 0 && minute >= 66 && minute <= 70 ? 2.18 : 1.22) + Math.sin(minute * 0.6) * 0.05).toFixed(3),
      ),
      temperature: Number(
        (minute < 30
          ? 20 - minute * 2
          : minute < 90
            ? -40 + Math.sin(minute) * 0.3
            : -40 + (minute - 90) * 2
        ).toFixed(2),
      ),
      pressure: Number((0.00003 + Math.abs(Math.cos(minute)) * 0.000002).toFixed(7)),
      limit: 1.8,
      anomaly: i === 0 && minute >= 66 && minute <= 70,
    })),
    logs:
      i >= 4
        ? []
        : [
            {
              at: '02:30Z',
              message: text(
                '达到冷平台 −40 °C；真空度 3×10⁻⁵ Pa',
                'Cold plateau −40 °C reached; vacuum 3×10⁻⁵ Pa',
              ),
            },
            {
              at: '03:06Z',
              message:
                i === 0
                  ? text(
                      '电流越限；操作员中止并隔离 PVD-011',
                      'Current limit exceeded; operator aborted and quarantined PVD-011',
                    )
                  : text('按程序记录；无新增异常', 'Procedure logged; no new anomaly'),
            },
          ],
  }))
  const ncrs = Array.from({ length: 18 }, (_, i) => ({
    id: `NCR-${n(i + 1)}`,
    title:
      i === 17
        ? text('AN-027 冷平台电流尖峰', 'AN-027 cold plateau current spike')
        : i === 15
          ? text('冷循环连续性间歇', 'Intermittent continuity during cold cycling')
          : i === 16
            ? text('冷平台重复电流越限', 'Repeated cold-plateau overcurrent')
            : text(
                ['来料标识偏差', '焊点间歇高阻', '尺寸检验偏差'][i % 3]!,
                [
                  'Incoming marking discrepancy',
                  'Intermittent high-resistance solder joint',
                  'Dimensional inspection deviation',
                ][i % 3]!,
              ),
    severity: i > 14 ? 'major' : i % 4 === 0 ? 'critical' : 'minor',
    status: i > 14 ? 'open' : i % 4 === 0 ? 'review' : 'closed',
    opened: `2026-10-${n(1 + i).slice(-2)}T04:00:00Z`,
    lot: i > 14 ? 'L2609-B' : 'L2607-A',
    unit: `PVD-${n(i > 14 ? 11 : i + 1)}`,
    signature:
      i === 15
        ? text(
            '冷循环后连续性测量出现间歇电阻升高；尚未完成切片分析',
            'Intermittent measured resistance after cold cycling; cross-section analysis pending',
          )
        : i > 15
          ? text(
              '冷平台驱动电流越过 1.80 A 限值；失效机理尚未证实',
              'Cold-plateau drive current exceeded the 1.80 A limit; failure mechanism unconfirmed',
            )
          : text('检验记录与受控图样存在差异', 'Inspection record differs from controlled drawing'),
    disposition: i > 14 ? null : ('use-as-is' as const),
    rationale: '',
    approvals: i > 14 ? [] : ['MRB-DEMO-ARCHIVE'],
    evidence: i > 14 ? [`EV-NCR-${n(i + 1)}-waveform`] : [`EV-NCR-${n(i + 1)}-inspection`],
  }))
  const ecrs = Array.from({ length: 12 }, (_, i) => ({
    id: `ECR-${n(i + 14)}`,
    title:
      i === 0
        ? text(
            '驱动器元器件批次替换：L2607-A → L2609-B',
            'Driver component lot substitution: L2607-A → L2609-B',
          )
        : text(`驱动组件变更 ${i + 1}`, `Driver assembly change ${i + 1}`),
    status: i === 0 ? 'approved' : i < 5 ? 'review' : 'draft',
    from: i === 0 ? 'BL-B' : 'BL-C',
    to: i === 0 ? 'BL-C' : 'BL-D-draft',
    part: 'P-001',
    lotChange: i % 2 === 0,
    thermallyCycled: true,
    requirements: ['CMP-001', 'SUB-001', 'SUB-002'],
    interfaces: ['IF-PWR-28V', 'IF-VALVE-J3'],
    tests: ['VT-001', 'VT-004', 'VT-008'],
    rationale:
      i === 0
        ? '2026-09-18: approved alternate lot; additional TVAC screening was not specified / 已批准替代批次，未规定追加热真空筛选'
        : '',
    approvals: i === 0 ? ['CCB-DEMO-20260918'] : [],
  }))
  const titles = [
    ['定位准确', 'Accurate localization'],
    ['机理清楚', 'Mechanism understood'],
    ['问题复现', 'Reproduction'],
    ['措施有效', 'Effective corrective action'],
    ['举一反三', 'Extent of condition'],
    ['过程清楚', 'Clear process'],
    ['责任明确', 'Accountability'],
    ['措施落实', 'Actions implemented'],
    ['严肃处理', 'Serious review'],
    ['完善规章', 'Improved procedures'],
  ]
  const criteria: Criterion[] = titles.map(([zh, en], i) => ({
    id: `${i < 5 ? 'T' : 'M'}${(i % 5) + 1}`,
    title: text(zh!, en!),
    evidence: [0, 5, 6].includes(i) ? [`EV-ZR-001-${i + 1}`] : [],
    accepted: [0, 5, 6].includes(i),
  }))
  return {
    schema: 1,
    revision: 1,
    requirements,
    tests,
    campaigns,
    ncrs,
    ecrs,
    zeroing: [{ id: 'ZR-001', anomaly: 'AN-027', status: 'open', criteria }],
    parts: Array.from({ length: 24 }, (_, i) => ({
      id: `P-${n(i + 1)}`,
      title: text(
        i === 0 ? '阀驱动厚膜混合电路' : `受控器件 ${i + 1}`,
        i === 0 ? 'Valve-driver thick-film hybrid' : `Controlled part ${i + 1}`,
      ),
      supplier: text(`虚构供应单元 ${(i % 4) + 1}`, `Fictional supply cell ${(i % 4) + 1}`),
      grade: i % 3 === 0 ? 'programme-qualified / 项目鉴定级' : 'screened industrial / 筛选工业级',
      lot: i === 0 ? 'L2609-B' : 'L2607-A',
      preferred: i < 18,
      obsolete: i > 21,
      counterfeitRisk: i === 19,
      status: i === 0 || i === 19 ? 'quarantine' : 'available',
    })),
    baselines: ['BL-A', 'BL-B', 'BL-C', 'BL-D-draft'].map((id, i) => ({
      id,
      status: i === 3 ? 'draft' : i === 2 ? 'hold' : 'superseded',
      units: ['PVD-011', 'PVD-012', 'PVD-013'],
      source: i === 2 ? 'ECR-014' : 'CCB-ARCHIVE',
    })),
    milestones: [
      { date: '2026-10-22', title: text('异常复现评审', 'Reproduction review'), status: 'at-risk' },
      {
        date: '2026-10-28',
        title: text('MRB 与更改控制委员会', 'MRB and change control board'),
        status: 'pending',
      },
      { date: '2026-11-06', title: text('鉴定评审', 'Qualification review'), status: 'pending' },
    ],
    rule: { status: 'absent', version: 0, body: RULE, evidence: [], approval: null },
    audit: [],
  }
}
