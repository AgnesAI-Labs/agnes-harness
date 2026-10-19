import { type Batch, type Measurement, type Plant, label } from './model.js'

const at = (day: number, hour = 9) =>
  `2024-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`
const measure = (
  id: string,
  zh: string,
  en: string,
  value: number,
  unit: string,
  min: number,
  max: number,
  time: string,
): Measurement => ({ id, name: label(zh, en), value, unit, min, max, at: time, source: `LIMS-${id}` })
const operations = [
  [
    'dispensing',
    '称量',
    'Dispensing',
    'BAL-01',
    'D-101',
    '称量偏差',
    'Dispensing variance',
    0.1,
    '%',
    -0.5,
    0.5,
  ],
  [
    'granulation',
    '制粒',
    'Granulation',
    'GR-01',
    'C-201',
    '进风温度',
    'Inlet air temperature',
    62,
    '°C',
    55,
    70,
  ],
  ['drying', '干燥', 'Drying', 'DR-02', 'C-201', '干燥失重', 'Loss on drying', 1.8, '%', 1, 2.5],
  [
    'blending',
    '混合',
    'Blending',
    'BL-01',
    'D-202',
    '混合均匀度 RSD',
    'Blend uniformity RSD',
    2.1,
    '%',
    0,
    5,
  ],
  [
    'compression',
    '压片 / 胶囊填充',
    'Compression / capsule filling',
    'PR-01',
    'D-203',
    '装量偏差',
    'Unit weight variance',
    1.2,
    '%',
    -5,
    5,
  ],
  ['coating', '包衣', 'Coating', 'CT-01', 'D-204', '包衣增重', 'Coating weight gain', 3, '%', 2.5, 3.5],
  ['packaging', '包装', 'Packaging', 'PK-01', 'D-301', '在线剔除率', 'Online reject rate', 0.2, '%', 0, 1],
] as const

export function seed(): Plant {
  const batches: Batch[] = Array.from({ length: 36 }, (_, i) => {
    const n = i + 1,
      day = n <= 20 ? n : n - 16,
      shift = n > 20 ? 7 : 0,
      incident = n === 17
    const form = n % 5 === 0 ? 'capsule' : 'tablet'
    const steps = operations
      .filter((s) => form === 'tablet' || s[0] !== 'coating')
      .map((op, index) => {
        const [id, zh, en, equipment, room, mzh, men, v, unit, min, max] = op
        const equipmentId =
          id === 'compression' && form === 'capsule'
            ? 'CF-01'
            : equipment === 'DR-02' && ![16, 17, 18].includes(n)
              ? 'DR-01'
              : equipment
        const time = at(day, 7 + index + shift)
        const cpp = [
          measure(
            `${n}-${id}`,
            mzh,
            men,
            incident && id === 'drying' ? 3.4 : v + (n % 3) * (id === 'granulation' ? 1 : 0.01),
            unit,
            min,
            max,
            time,
          ),
        ]
        if (id === 'compression' && form === 'tablet')
          cpp.push(
            measure(`${n}-hardness`, '硬度', 'Hardness', 75 + (n % 8), 'N', 60, 100, time),
            measure(`${n}-friability`, '脆碎度', 'Friability', 0.22, '%', 0, 1, time),
          )
        cpp.forEach((m) => {
          m.source = `EBR:${equipmentId}:${m.id}`
        })
        return {
          id,
          name:
            id === 'compression'
              ? label(
                  form === 'tablet' ? '压片' : '胶囊填充',
                  form === 'tablet' ? 'Compression' : 'Capsule filling',
                )
              : label(zh, en),
          equipment: equipmentId,
          room,
          at: time,
          cpp,
          operator: {
            actor: 'demo.operator.lin',
            at: time,
            meaning: label('操作完成', 'Operation completed'),
          },
          verifier:
            n > 26 && index > 3
              ? null
              : {
                  actor: 'demo.verifier.wen',
                  at: at(day, 8 + index + shift),
                  meaning: label('独立复核', 'Independent verification'),
                },
        }
      })
    return {
      id: `B-2410-${String(n).padStart(3, '0')}`,
      product: label(
        form === 'tablet' ? '示例片剂 250 mg' : '示例胶囊 100 mg',
        form === 'tablet' ? 'Reference tablets 250 mg' : 'Reference capsules 100 mg',
      ),
      form,
      size: 120000 + n * 1000,
      date: at(day),
      status: n < 12 ? 'released' : n > 26 ? 'production' : 'review',
      review: n < 12 ? 'accepted' : 'pending',
      steps,
      qc:
        n > 26
          ? []
          : [
              measure(
                `${n}-assay`,
                '含量',
                'Assay',
                99.1 + (n % 3) * 0.3,
                '% label',
                95,
                105,
                at(day, shift ? 23 : 16),
              ),
              measure(
                `${n}-impurity`,
                '总杂质',
                'Total impurities',
                0.18,
                '%',
                0,
                0.5,
                at(day, shift ? 23 : 16),
              ),
              measure(
                `${n}-dissolution`,
                '溶出度（S1，6 单位最低值）',
                'Dissolution (S1 minimum of 6 units)',
                88,
                '%',
                85,
                100,
                at(day, shift ? 23 : 16),
              ),
              measure(`${n}-micro`, '需氧菌总数', 'TAMC', 12, 'CFU/g', 0, 1000, at(day, shift ? 23 : 16)),
            ],
      deviationIds: incident ? ['DEV-2410-017'] : [],
      retests: [],
      certificate:
        n < 12
          ? {
              id: `REL-SEED-${n}`,
              batch: `B-2410-${String(n).padStart(3, '0')}`,
              at: at(day, 18),
              signer: 'demo.qa.su',
              meaning: 'Synthetic historical release / 合成历史放行',
              approvalId: 'synthetic-seed',
              subjectRevision: 'seed',
              dossierRevision: 0,
            }
          : null,
    }
  })
  const deviationBatches = [11, 12, 13, 14, 18, 19, 20, 21, 22, 23, 24].map((i) => batches[i]!)
  return {
    version: 1,
    revision: 0,
    batches,
    equipment: [
      ...(
        [
          ['BAL-01', '称量天平', 'Dispensing balance'],
          ['GR-01', '流化床制粒机', 'Fluid-bed granulator'],
          ['DR-01', '流化床干燥机 T01', 'Fluid-bed dryer T01'],
          ['BL-01', '料斗混合机', 'Bin blender'],
          ['PR-01', '旋转压片机', 'Rotary tablet press'],
          ['CF-01', '胶囊填充机', 'Capsule filler'],
          ['CT-01', '包衣机', 'Tablet coater'],
          ['PK-01', '泡罩包装线', 'Blister packaging line'],
        ] as const
      ).map(([id, zh, en]) => ({
        id,
        name: label(zh, en),
        due: '2025-02-01',
        qualification: 'qualified' as const,
        calibrated: '2024-08-01',
        evidence: ['CAL-SEED-PASS'],
      })),
      {
        id: 'DR-02',
        name: label('流化床干燥机 · 探头 T02', 'Fluid-bed dryer · probe T02'),
        due: '2024-10-16',
        qualification: 'suspended',
        calibrated: '2024-04-16',
        evidence: [],
      },
    ],
    rooms: [
      {
        id: 'A-001',
        grade: 'A',
        name: label('参考：无菌关键区（未用于本产线）', 'Reference: sterile critical zone (unused)'),
        viableAlert: 0,
        viableAction: 0,
        particleAlert: 2500,
        particleAction: 3520,
      },
      {
        id: 'B-001',
        grade: 'B',
        name: label('参考：背景区（未用于本产线）', 'Reference: background zone (unused)'),
        viableAlert: 5,
        viableAction: 10,
        particleAlert: 250000,
        particleAction: 352000,
      },
      {
        id: 'C-201',
        grade: 'C',
        name: label('制粒 / 干燥间', 'Granulation / drying'),
        viableAlert: 50,
        viableAction: 100,
        particleAlert: 2500000,
        particleAction: 3520000,
      },
      ...['D-101', 'D-202', 'D-203', 'D-204', 'D-301'].map((id) => ({
        id,
        grade: 'D' as const,
        name: label('固体制剂生产区', 'OSD production'),
        viableAlert: 100,
        viableAction: 200,
        particleAlert: 3000000,
        particleAction: 5000000,
      })),
    ],
    samples: Array.from({ length: 240 }, (_, i) => {
      const day = (i % 20) + 1,
        room = ['C-201', 'D-101', 'D-202', 'D-203', 'D-204', 'D-301'][Math.floor(i / 20) % 6]!
      const incident = room === 'C-201' && day === 17,
        action = room === 'C-201' && day === 19
      return {
        id: `EM-${String(i + 1).padStart(4, '0')}`,
        room,
        batch: `B-2410-${String(day).padStart(3, '0')}`,
        at: at(day, i < 120 ? 10 : 14),
        viable: action ? 121 : incident ? 72 : 8 + ((i * 7) % 35),
        particles: 300000 + ((i * 137) % 300000),
        disposition: incident || action ? ('pending' as const) : ('assessed' as const),
        evidence: incident || action ? '' : 'EM-SEED-REVIEW',
      }
    }),
    deviations: [
      {
        id: 'DEV-2410-017',
        batch: 'B-2410-017',
        severity: 'major',
        title: label('干燥 LOD 超限与同室 EM 警戒', 'Drying LOD excursion and same-room EM alert'),
        stage: 'open',
        opened: at(17, 12),
        cause: '',
        impact: [],
        why: [],
        actions: [],
      },
      ...Array.from({ length: 11 }, (_, i) => ({
        id: `DEV-2410-${String(40 + i).padStart(3, '0')}`,
        batch: deviationBatches[i]!.id,
        severity: i === 0 ? ('critical' as const) : i % 3 === 0 ? ('major' as const) : ('minor' as const),
        title: label(
          i === 0 ? '包装混淆险情（隔离中）' : '生产记录复核项',
          i === 0 ? 'Packaging mix-up near miss (quarantined)' : 'Production documentation finding',
        ),
        stage: (['investigation', 'capa', 'effectiveness', 'closed'] as const)[i % 4]!,
        opened: at(Number(deviationBatches[i]!.date.slice(8, 10)), 17),
        cause: 'Synthetic investigation / 合成调查',
        impact: [deviationBatches[i]!.id],
        why: [],
        actions: [
          {
            id: `CAPA-${40 + i}`,
            text: label('培训和独立复核', 'Training and independent verification'),
            owner: 'demo.qa.rao',
            due: new Date(Date.parse(deviationBatches[i]!.date) + 2 * 86400000).toISOString().slice(0, 10),
            evidence: i % 4 === 3 ? 'EV-SEED' : '',
            effective: i % 4 === 3,
          },
        ],
      })),
    ],
    audit: [
      {
        id: 'AUD-0000',
        at: at(20),
        actor: 'synthetic.seed',
        action: 'seed',
        record: 'plant',
        fromRevision: 0,
        toRevision: 0,
        reason: 'Fixed synthetic scenario / 固定合成场景',
        session: null,
        approval: null,
      },
    ],
  }
}
