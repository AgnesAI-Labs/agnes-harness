#!/usr/bin/env node
// One layout and two language dictionaries own the README architecture illustrations.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const check = process.argv.includes('--check')
const colors = {
  ink: '#172b4d',
  muted: '#52647b',
  line: '#c8d5e5',
  blue: '#2459ce',
  pale: '#f3f7ff',
  green: '#176b55',
  amber: '#9a5a13',
  planned: '#fff8eb',
}
const translations = {
  en: {
    title: 'Agnes Harness',
    subtitle: 'One execution foundation. Reusable capabilities for field delivery.',
    existing: 'Solid: existing software paths',
    planned: 'Dashed: planned AGH integration',
    roles: [
      ['LLM / BRAIN', 'Reasoning & action proposals', 'Inference via AI providers'],
      ['Jev / CEREBELLUM', 'Structured decisions & routing', 'Planned integration'],
      ['HARNESS / MEMORY', 'Task state, history & methods', 'Sessions, records & Skills'],
      ['MHS / BODY', 'Physical device capabilities', 'Planned via MCP adapters'],
    ],
    metaphor: 'Role metaphors explain the vision; the layers below show execution responsibilities.',
    server: 'APP SERVER',
    clients: 'CLI / TUI  ·  Web  ·  SDK / API consumers',
    serverDetail: 'SDK + daemon + workers: task submission, shared sessions, events & approval routing',
    runtime: 'AGENT RUNTIME',
    runtimeDetail: 'Host assembles capabilities; Core advances tasks inside the worker.',
    loop: 'Agent Loop / Core',
    loopLines: [
      'Model → action → tool → result → repeat',
      'Continue, pause, recover or finish',
      'LLM via AI Provider; Jev integration planned',
    ],
    execution: 'Controlled tool execution / Sandbox',
    executionLines: [
      'Tool authorization & execution policy',
      'Sandbox applicable command execution',
      'Platform-dependent file, network & process limits',
    ],
    memory: 'Harness memory / persistent task context',
    memoryLines: ['Session history · task state · event records · recovery · reusable Skills'],
    plugins: 'PLUGINS / CORDIS',
    pluginsDetail: 'Capability composition, dependencies, package trust & lifecycle',
    extensions: [
      ['Tools & business services', 'Backend plugins · MCP'],
      ['Methods & task knowledge', 'Skills · hooks'],
      ['Role-specific workbenches', 'Web panels · constrained services'],
    ],
    fde: 'FDE / ENTERPRISE DELIVERY',
    fdeLines: [
      'Knowledge · databases · business systems',
      'Compose tools, Skills & business interfaces',
      'Connectors need implementation & validation.',
    ],
    mhs: 'MHS / PHYSICAL INTEGRATION',
    mhsLines: [
      'Planned: MCP adapter → controller → device',
      'State reads · action requests · receipts',
      'Interlocks & emergency stops stay on devices.',
    ],
    footer:
      'FDE is a delivery approach. MHS is a device integration direction. Both use the same foundation.',
    description:
      'AGH architecture with LLM as brain, Jev as cerebellum, Harness as memory and MHS as body. Jev and MHS integration are planned; MHS device adapters build on MCP. App Server, agent loop, sandbox and plugins support enterprise delivery; device adapters extend the same foundation into physical workflows.',
  },
  'zh-CN': {
    title: 'Agnes Harness',
    subtitle: '一套执行底座，将现场交付沉淀为可复用的能力。',
    existing: '实线：已有软件能力',
    planned: '虚线：AGH 规划中的接入',
    roles: [
      ['LLM / 大脑', '理解、推理与候选动作生成', '通过 AI Provider 接入'],
      ['Jev / 小脑', '结构化决策与执行协调', '规划接入'],
      ['HARNESS / 记忆', '任务状态、历史与可复用方法', '会话、执行记录与 Skills'],
      ['MHS / 身体', '连接物理设备的能力接口', '规划经 MCP 适配器接入'],
    ],
    metaphor: '角色比喻解释产品愿景；下方架构层说明实际执行职责。',
    server: 'APP SERVER / 统一接入',
    clients: 'CLI / TUI  ·  Web  ·  SDK / API 调用方',
    serverDetail: 'SDK + daemon + workers：任务提交、共享会话、事件输出与审批路由',
    runtime: 'AGENT RUNTIME / 执行底座',
    runtimeDetail: 'Host 装配能力，Core 在 worker 内推进任务。',
    loop: 'Agent Loop / 执行循环',
    loopLines: [
      '模型 → 动作 → 工具 → 结果 → 下一步',
      '继续、暂停、恢复或完成',
      'LLM 经 AI Provider 接入；Jev 接入属规划',
    ],
    execution: '受控工具执行 / Sandbox',
    executionLines: [
      '工具授权与执行策略',
      '对适用的命令执行施加沙箱约束',
      '文件、网络与进程约束取决于平台能力',
    ],
    memory: 'Harness 记忆 / 持久任务上下文',
    memoryLines: ['会话历史 · 任务状态 · 事件记录 · 恢复 · 可复用的 Skills'],
    plugins: 'PLUGINS / 插件体系',
    pluginsDetail: 'Cordis 组织能力装配、依赖、包信任与生命周期',
    extensions: [
      ['工具与业务服务', '后端插件 · MCP'],
      ['方法与任务知识', 'Skills · hooks'],
      ['岗位工作台', 'Web 面板 · 受限服务调用'],
    ],
    fde: 'FDE / 企业现场交付',
    fdeLines: [
      '知识检索 · 数据库 · 业务系统',
      '组合工具、Skills 与业务界面',
      '具体连接器需要开发与场景验证。',
    ],
    mhs: 'MHS / 物理设备接入',
    mhsLines: [
      '规划：MCP 适配器 → 控制器 → 设备',
      '状态读取 · 动作请求 · 执行回执',
      '互锁与急停由设备及其控制系统承担。',
    ],
    footer: 'FDE 是交付方式，MHS 是设备接入方向；两者使用同一套执行底座。',
    description:
      'AGH 架构：LLM 是大脑，Jev 是小脑，Harness 是记忆，MHS 是身体。Jev 与 MHS 接入属于规划，MHS 设备适配器基于 MCP。App Server、Agent Loop、Sandbox 与插件体系支撑企业现场交付，设备适配器将同一底座延伸到物理场景。',
  },
}

const xmlText = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
function render(t, lang) {
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1248" viewBox="0 0 1200 1248" role="img" aria-labelledby="title description" xml:lang="${lang}">`,
    `<title id="title">${xmlText(`${t.title} — ${t.subtitle}`)}</title>`,
    `<desc id="description">${xmlText(t.description)}</desc>`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${colors.blue}"/></marker><marker id="planned-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${colors.amber}"/></marker></defs>`,
    '<rect width="1200" height="1248" rx="20" fill="#ffffff"/>',
    '<g font-family="Inter, Segoe UI, PingFang SC, Microsoft YaHei, Arial, sans-serif">',
  ]
  function text(x, y, value, size = 20, weight = 400, color = colors.ink) {
    parts.push(
      `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}">${xmlText(value)}</text>`,
    )
  }
  function box(x, y, width, height, fill = '#ffffff', stroke = colors.line, dashed = false) {
    parts.push(
      `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="14" fill="${fill}" stroke="${stroke}" stroke-width="1.8"${dashed ? ' stroke-dasharray="7 5"' : ''}/>`,
    )
  }
  function arrow(x1, y1, x2, y2, dashed = false, both = false) {
    parts.push(
      `<path d="M ${x1} ${y1} L ${x2} ${y2}" fill="none" stroke="${dashed ? colors.amber : colors.blue}" stroke-width="2.2" marker-end="url(#${dashed ? 'planned-arrow' : 'arrow'})"${dashed ? ' stroke-dasharray="7 5"' : ''}${both ? ' marker-start="url(#arrow)"' : ''}/>`,
    )
  }
  function lines(x, y, values, size = 18, gap = 27) {
    values.forEach((value, index) => {
      text(x, y + index * gap, value, size, 400, colors.muted)
    })
  }
  text(36, 55, t.title, 36, 700)
  text(36, 87, t.subtitle, 20, 400, colors.muted)
  parts.push(`<path d="M 36 116 H 69" stroke="${colors.blue}" stroke-width="2.2"/>`)
  text(80, 122, t.existing, 17, 400, colors.muted)
  parts.push(`<path d="M 530 116 H 563" stroke="${colors.amber}" stroke-width="2.2" stroke-dasharray="7 5"/>`)
  text(574, 122, t.planned, 17, 400, colors.muted)
  t.roles.forEach((role, index) => {
    const x = 36 + index * 288
    const planned = index === 1 || index === 3
    box(
      x,
      146,
      264,
      111,
      planned ? colors.planned : colors.pale,
      planned ? colors.amber : colors.line,
      planned,
    )
    text(x + 17, 179, role[0], 20, 700, planned ? colors.amber : colors.blue)
    lines(x + 17, 207, role.slice(1), 16, 25)
  })
  text(36, 284, t.metaphor, 17, 400, colors.muted)
  box(36, 310, 1128, 111, colors.pale, colors.blue)
  text(58, 344, t.server, 22, 700, colors.blue)
  text(58, 376, t.clients, 21, 600)
  text(58, 402, t.serverDetail, 18, 400, colors.muted)
  arrow(600, 423, 600, 452)
  box(36, 457, 1128, 325, '#f8fafc')
  text(58, 490, t.runtime, 22, 700, colors.blue)
  text(58, 517, t.runtimeDetail, 18, 400, colors.muted)
  box(58, 539, 519, 142)
  text(78, 572, t.loop, 22, 650)
  lines(78, 601, t.loopLines, 18)
  box(625, 539, 517, 142)
  text(645, 572, t.execution, 22, 650)
  lines(645, 601, t.executionLines, 18)
  arrow(580, 610, 620, 610, false, true)
  box(58, 704, 1084, 59, '#edf7f3', '#b5d5c7')
  text(78, 730, t.memory, 20, 650, colors.green)
  lines(78, 751, t.memoryLines, 17)
  arrow(600, 789, 600, 818, false, true)
  box(36, 827, 1128, 164, colors.pale, colors.blue)
  text(58, 860, t.plugins, 22, 700, colors.blue)
  text(58, 887, t.pluginsDetail, 18, 400, colors.muted)
  t.extensions.forEach((extension, index) => {
    const x = 58 + index * 367
    box(x, 908, 350, 65)
    text(x + 16, 935, extension[0], 20, 600)
    text(x + 16, 958, extension[1], 16, 400, colors.muted)
  })
  arrow(316, 995, 316, 1030)
  arrow(886, 995, 886, 1030, true)
  box(36, 1038, 552, 147, '#f0f8f5', '#94bcac')
  text(58, 1072, t.fde, 22, 700, colors.green)
  lines(58, 1103, t.fdeLines, 18)
  box(612, 1038, 552, 147, colors.planned, colors.amber, true)
  text(634, 1072, t.mhs, 22, 700, colors.amber)
  lines(634, 1103, t.mhsLines, 18)
  text(36, 1223, t.footer, 18, 400, colors.muted)
  parts.push('</g>', '</svg>')
  return `${parts.join('\n')}\n`
}

for (const [language, translation] of Object.entries(translations)) {
  const file = resolve(root, `docs/assets/architecture${language === 'en' ? '' : '.zh-CN'}.svg`)
  const svg = render(translation, language)
  if (check) {
    if (readFileSync(file, 'utf8') !== svg) throw new Error(`Architecture illustration is stale: ${file}`)
  } else {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, svg)
  }
}
console.log(
  check
    ? 'Architecture illustrations are current (2 languages).'
    : 'Rendered architecture illustrations (2 languages).',
)
