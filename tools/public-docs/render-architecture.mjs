#!/usr/bin/env node
// One layout and two language dictionaries own the animated README architecture illustrations.
// The SVG animates with CSS and SMIL only (no script), so it plays inside an <img> on GitHub and
// stops under prefers-reduced-motion. Every element is in place on the first frame, so the diagram
// stays complete wherever the animation clock does not run; motion only adds flow and highlights.
// An animated SVG image is re-rasterized whole on every frame, so glows are layered strokes and
// halos rather than blur filters, which stall the browser at this size.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const check = process.argv.includes('--check')
const W = 1200
const H = 1400
const c = {
  text: '#eef1ff',
  muted: '#9aa6d8',
  faint: '#6f7bb3',
  line: 'rgba(132,150,255,0.30)',
  panel: 'rgba(255,255,255,0.035)',
  blue: '#7c8cff',
  cyan: '#38d6ff',
  violet: '#b49bff',
  green: '#34d399',
  amber: '#fbbf24',
}

const translations = {
  en: {
    title: 'Agnes Harness',
    subtitle: 'One execution foundation for field delivery and the physical world',
    existing: 'Solid: existing software paths',
    planned: 'Dashed: planned AGH integration',
    roles: [
      ['LLM', 'Brain', 'Reasoning and actions', 'Via AI providers'],
      ['Jev', 'Cerebellum', 'Decisions and routing', 'Planned'],
      ['Harness', 'Memory', 'State, history, methods', 'Sessions, records, Skills'],
      ['MHS', 'Body', 'Physical devices', 'Planned · via MCP'],
    ],
    server: 'APP SERVER',
    serverDetail: 'Shared sessions · task submission · event streaming · approval routing',
    clients: ['Web workbench', 'CLI / TUI', 'IDE · ACP', 'SDK / API'],
    runtime: 'AGENT RUNTIME',
    runtimeDetail: 'Host assembles capabilities; Core advances each task inside the worker',
    llm: ['Model reasoning', 'LLM via AI providers'],
    loop: ['AGENT LOOP', 'until the task is done'],
    steps: ['Reason', 'Act', 'Call tool', 'Result', 'Continue'],
    jev: 'Jev routing · planned',
    memory: 'HARNESS MEMORY',
    memoryLayers: ['Sessions', 'Task state', 'Event records', 'Skills'],
    governance: ['CONTROLLED EXECUTION', 'Tool approvals · command sandbox · execution policy · recovery'],
    plugins: 'PLUGINS · CORDIS',
    pluginsDetail: 'Everything as plug-ins: package trust, dependencies and lifecycle',
    modules: [
      ['Tools & services', 'Backend plugins'],
      ['Data & knowledge', 'MCP connections'],
      ['Methods & workflows', 'Skills · hooks'],
      ['Role workbenches', 'Web panels'],
    ],
    fde: ['FDE · ENTERPRISE DELIVERY', 'Compose plugins into a customer-specific agent'],
    fdeItems: ['Knowledge base', 'Database', 'Business systems', 'Domain software'],
    fdeNote: 'Connectors are built and validated per site',
    mhs: ['MHS · PHYSICAL WORLD', 'Planned · built on MCP'],
    mhsChain: ['MCP adapter', 'Controller'],
    devices: ['Microscope', 'Robotic arm', 'Liquid handler'],
    mhsNote: 'Illustrative devices · interlocks and e-stops stay on devices',
    footer:
      'FDE is a delivery approach. MHS is a device integration direction. Both run on the same foundation.',
    description:
      'Animated AGH architecture. LLM is the brain, Jev the cerebellum, Harness the memory and MHS the body; Jev and MHS are planned, and MHS device adapters build on MCP. Clients reach the App Server, the Agent Runtime runs the agent loop with Harness memory and controlled execution, plugins extend the runtime, and the same foundation serves enterprise FDE delivery and future physical-world integration.',
  },
  'zh-CN': {
    title: 'Agnes Harness',
    subtitle: '一套执行底座，连接企业现场与物理世界',
    existing: '实线：已有软件能力',
    planned: '虚线：规划中的 AGH 接入',
    roles: [
      ['LLM', '大脑', '理解、推理与动作建议', '经 AI Provider 接入'],
      ['Jev', '小脑', '结构化决策与路由', '规划中'],
      ['Harness', '记忆', '状态、历史与可复用方法', '会话、执行记录、Skills'],
      ['MHS', '身体', '连接物理设备的能力', '规划中 · 经 MCP 接入'],
    ],
    server: 'APP SERVER · 统一接入',
    serverDetail: '共享会话 · 任务提交 · 事件推送 · 审批路由',
    clients: ['Web 工作台', 'CLI / TUI', 'IDE · ACP', 'SDK / API'],
    runtime: 'AGENT RUNTIME · 执行底座',
    runtimeDetail: 'Host 装配能力，Core 在 worker 内持续推进任务',
    llm: ['模型推理', '经 AI Provider 接入 LLM'],
    loop: ['AGENT LOOP', '循环推进，直到完成'],
    steps: ['推理', '决定动作', '调用工具', '返回结果', '继续 / 完成'],
    jev: 'Jev 路由 · 规划中',
    memory: 'HARNESS 记忆',
    memoryLayers: ['会话', '任务状态', '事件记录', 'Skills'],
    governance: ['受控执行', '工具审批 · 命令沙箱 · 执行策略 · 中断恢复'],
    plugins: 'PLUGINS · 插件体系',
    pluginsDetail: '一切皆插件：包信任、依赖与生命周期',
    modules: [
      ['工具与业务服务', '后端插件'],
      ['数据与知识', 'MCP 连接'],
      ['方法与流程', 'Skills · hooks'],
      ['岗位工作台', 'Web 面板'],
    ],
    fde: ['FDE · 企业现场交付', '组合插件，构建客户专属 Agent'],
    fdeItems: ['知识库', '数据库', '业务系统', '领域软件'],
    fdeNote: '具体连接器按现场开发与验证',
    mhs: ['MHS · 物理世界', '规划中 · 以 MCP 为基础'],
    mhsChain: ['MCP 适配器', '设备控制器'],
    devices: ['显微镜', '机械臂', '移液工作站'],
    mhsNote: '设备仅为示意 · 互锁与急停由设备负责',
    footer: 'FDE 是交付方式，MHS 是设备接入方向；两者运行在同一套底座上。',
    description:
      'AGH 架构动画：LLM 是大脑，Jev 是小脑，Harness 是记忆，MHS 是身体；Jev 与 MHS 属于规划，MHS 设备适配器基于 MCP。客户端经 App Server 接入，Agent Runtime 以 Harness 记忆和受控执行运行 Agent 循环，插件扩展运行时，同一底座支撑企业 FDE 交付与未来的物理世界接入。',
  },
}

// 24-unit line icons, drawn for this illustration.
const icons = {
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  terminal: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l3 2.5L7 15M12 15h5"/>',
  code: '<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .4-8A5.5 5.5 0 0 0 6.6 9.5 4.3 4.3 0 0 0 7 18z"/>',
  brain:
    '<path d="M12 5.5a3 3 0 0 0-5.6 1.2A3.2 3.2 0 0 0 4.6 12a3.3 3.3 0 0 0 2.3 5 3 3 0 0 0 5.1 1.4z"/>' +
    '<path d="M12 5.5a3 3 0 0 1 5.6 1.2 3.2 3.2 0 0 1 1.8 5.3 3.3 3.3 0 0 1-2.3 5A3 3 0 0 1 12 18.4"/>' +
    '<path d="M8.5 10.5c1 .3 1.8 1 2 2M15.5 10.5c-1 .3-1.8 1-2 2"/>',
  nodes:
    '<circle cx="6" cy="7" r="2.2"/><circle cx="18" cy="7" r="2.2"/><circle cx="12" cy="18" r="2.2"/>' +
    '<circle cx="12" cy="11" r="1.4"/><path d="M8 7.6l2.8 2.6M16 7.6l-2.8 2.6M12 12.4v3.4"/>',
  stack:
    '<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6"/>' +
    '<path d="M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6"/>',
  arm:
    '<path d="M4 20h9M8.5 20v-6l6-5 4 2"/><circle cx="8.5" cy="14" r="1.6"/><circle cx="14.5" cy="9" r="1.6"/>' +
    '<path d="M18.5 11v2.5"/>',
  spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18 16v4M16 18h4"/>',
  doc: '<rect x="5.5" y="3.5" width="13" height="17" rx="2"/><path d="M9 9h6M9 12.5h6M9 16h4"/>',
  wrench:
    '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.8 2.8L16.2 9"/>',
  loop: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.8 4.5v3.6h-3.6"/>',
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  briefcase: '<rect x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M9 7.5V5.5h6v2M3.5 12.5h17"/>',
  book:
    '<path d="M4 5h5.5A2.5 2.5 0 0 1 12 7.5V20a2 2 0 0 0-2-2H4z"/>' +
    '<path d="M20 5h-5.5A2.5 2.5 0 0 0 12 7.5V20a2 2 0 0 1 2-2h6z"/>',
  flow:
    '<rect x="3.5" y="4" width="7" height="5" rx="1.2"/><rect x="13.5" y="15" width="7" height="5" rx="1.2"/>' +
    '<path d="M7 9v3.5a2 2 0 0 0 2 2h4.5"/>',
  layout: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M9.5 4v16M9.5 10h11"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6"/>',
  building: '<rect x="4" y="4" width="10" height="16" rx="1"/><path d="M14 10h6v10h-6M7 8h4M7 12h4M7 16h4"/>',
  chip:
    '<rect x="7" y="7" width="10" height="10" rx="1.6"/>' +
    '<path d="M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3"/>',
  gauge: '<path d="M4.5 16a7.5 7.5 0 1 1 15 0"/><path d="M12 16l3.5-4.5"/><circle cx="12" cy="16" r="1.2"/>',
  microscope: '<path d="M9.5 3.5h4l-1 8h-2zM11.5 11.5v3M5 20h14M15.5 17.5a5 5 0 0 0-3-6"/>',
  flask:
    '<path d="M9.5 3.5h5M10.5 3.5v6l-5 8.8a1.6 1.6 0 0 0 1.4 2.2h10.2a1.6 1.6 0 0 0 1.4-2.2l-5-8.8v-6"/>' +
    '<path d="M7.6 15h8.8"/>',
}

const esc = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const style = [
  '.beat{opacity:0;animation:beat 12s ease-in-out infinite}',
  '@keyframes beat{0%,100%{opacity:0}4%{opacity:1}13%{opacity:0}}',
  '.pulse{animation:pulse 2.6s ease-in-out infinite}',
  '@keyframes pulse{0%,100%{opacity:.35}50%{opacity:.9}}',
  '.march{animation:march 1.4s linear infinite}',
  '@keyframes march{to{stroke-dashoffset:-28}}',
  '.spin{transform-box:fill-box;transform-origin:center;animation:spin 9s linear infinite}',
  '@keyframes spin{to{transform:rotate(360deg)}}',
  '.comet{animation:comet 6s linear infinite}',
  '@keyframes comet{to{stroke-dashoffset:-628.3}}',
  '.sweep{animation:sweep 3.6s ease-in-out infinite}',
  '@keyframes sweep{0%{transform:translateX(-90px)}60%,100%{transform:translateX(330px)}}',
  '.pin{animation:pin 12s ease-in-out infinite}',
  '@keyframes pin{0%,46%,62%,100%{opacity:.35}50%{opacity:1}}',
  '@media (prefers-reduced-motion:reduce){*{animation:none!important}.motion{display:none}}',
].join('')

function render(t, lang) {
  const out = []
  const push = (...s) => out.push(...s)
  const text = (x, y, value, o = {}) =>
    push(
      `<text x="${x}" y="${y}" font-size="${o.size ?? 14}" font-weight="${o.weight ?? 400}" fill="${o.fill ?? c.text}"` +
        `${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.ls ? ` letter-spacing="${o.ls}"` : ''}>${esc(value)}</text>`,
    )
  const icon = (name, cx, cy, size, color, sw = 1.8) =>
    push(
      `<g transform="translate(${cx - size / 2} ${cy - size / 2}) scale(${size / 24})" fill="none" stroke="${color}"` +
        ` stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</g>`,
    )
  const panel = (x, y, w, h, o = {}) =>
    push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.r ?? 18}" fill="${o.fill ?? c.panel}"` +
        ` stroke="${o.stroke ?? c.line}" stroke-width="${o.sw ?? 1.4}"` +
        `${o.dashed ? ' stroke-dasharray="8 6" class="march"' : ''}/>`,
    )
  // A highlight outline that lights up once per 12 s cycle, in story order.
  const beat = (x, y, w, h, color, delay, r = 18) =>
    push(
      `<g class="beat" style="animation-delay:${delay}s" fill="none" stroke="${color}">` +
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" stroke-width="9" stroke-opacity=".22"/>` +
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" stroke-width="2.4"/></g>`,
    )
  // A glowing particle travelling a path; hidden until it starts, so it never sits at the origin.
  const particle = (d, dur, begin, color, r = 4) =>
    push(
      `<g class="motion" fill="${color}" opacity="0"><circle r="${r * 2.6}" opacity=".22"/><circle r="${r}"/>` +
        `<animateMotion path="${d}" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/>` +
        `<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.12;.85;1" dur="${dur}s" begin="${begin}s"` +
        ' repeatCount="indefinite"/></g>',
    )
  const chip = (x, y, w, h, name, label, o = {}) => {
    const color = o.color ?? c.blue
    panel(x, y, w, h, {
      r: 12,
      fill: o.fill ?? 'rgba(124,140,255,0.08)',
      stroke: o.stroke ?? 'rgba(124,140,255,0.42)',
      dashed: o.dashed,
    })
    icon(name, x + 26, y + h / 2, 22, color)
    if (o.sub) {
      text(x + 48, y + h / 2 - 4, label, { size: 15, weight: 650 })
      text(x + 48, y + h / 2 + 15, o.sub, { size: 12, fill: c.muted })
    } else text(x + 48, y + h / 2 + 5, label, { size: o.size ?? 14.5, weight: 600 })
  }

  push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"` +
      ` aria-labelledby="title description" xml:lang="${lang}">`,
    `<title id="title">${esc(`${t.title} — ${t.subtitle}`)}</title>`,
    `<desc id="description">${esc(t.description)}</desc>`,
    '<defs>' +
      '<radialGradient id="bg" cx="50%" cy="0%" r="95%"><stop offset="0" stop-color="#26307a"/>' +
      '<stop offset=".55" stop-color="#121a48"/><stop offset="1" stop-color="#0a0f2b"/></radialGradient>' +
      '<radialGradient id="halo"><stop offset="0" stop-color="#7c8cff" stop-opacity=".9"/>' +
      '<stop offset="1" stop-color="#7c8cff" stop-opacity="0"/></radialGradient>' +
      '<radialGradient id="core"><stop offset="0" stop-color="#2b3690"/><stop offset="1" stop-color="#151c52"/>' +
      '</radialGradient>' +
      '<linearGradient id="sweepGrad" x1="0" x2="1"><stop offset="0" stop-color="#38d6ff" stop-opacity="0"/>' +
      '<stop offset=".5" stop-color="#38d6ff" stop-opacity=".28"/>' +
      '<stop offset="1" stop-color="#38d6ff" stop-opacity="0"/></linearGradient>' +
      '<pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none"' +
      ' stroke="rgba(255,255,255,0.045)" stroke-width="1"/></pattern>' +
      '<clipPath id="memclip"><rect x="880" y="590" width="232" height="196" rx="10"/></clipPath>' +
      `<style>${style}</style>` +
      '</defs>',
    `<rect width="${W}" height="${H}" rx="24" fill="url(#bg)"/>`,
    `<rect width="${W}" height="${H}" rx="24" fill="url(#grid)"/>`,
    '<g font-family="Inter, -apple-system, Segoe UI, PingFang SC, Microsoft YaHei, Arial, sans-serif">',
  )

  // Header and legend.
  text(60, 76, t.title, { size: 38, weight: 800 })
  text(60, 110, t.subtitle, { size: 17, fill: c.muted })
  push(`<path d="M ${W - 380} 64 H ${W - 348}" stroke="${c.cyan}" stroke-width="2.4"/>`)
  text(W - 338, 69, t.existing, { size: 13, fill: c.muted })
  push(
    `<path d="M ${W - 380} 94 H ${W - 348}" stroke="${c.amber}" stroke-width="2.4" stroke-dasharray="6 5"` +
      ' class="march"/>',
  )
  text(W - 338, 99, t.planned, { size: 13, fill: c.muted })

  // Four roles: brain, cerebellum, memory, body.
  const roleIcon = ['brain', 'nodes', 'stack', 'arm']
  const roleColor = [c.violet, c.amber, c.cyan, c.amber]
  t.roles.forEach(([name, role, line, status], i) => {
    const x = 60 + i * 275
    const planned = i === 1 || i === 3
    panel(x, 148, 255, 104, {
      fill: planned ? 'rgba(251,191,36,0.06)' : 'rgba(124,140,255,0.08)',
      stroke: planned ? 'rgba(251,191,36,0.75)' : 'rgba(124,140,255,0.45)',
      dashed: planned,
    })
    push(
      `<circle cx="${x + 46}" cy="200" r="30" fill="url(#halo)" class="pulse"` +
        ` style="animation-delay:${i * 0.6}s"/>`,
      `<circle cx="${x + 46}" cy="200" r="24" fill="url(#core)" stroke="${roleColor[i]}" stroke-width="1.4"/>`,
    )
    icon(roleIcon[i], x + 46, 200, 26, roleColor[i])
    text(x + 86, 186, name, { size: 18, weight: 800 })
    // Bold 18 px Latin: about 13 px per capital and 10.5 px per lower-case letter.
    const nameWidth = [...name].reduce((w, ch) => w + (ch === ch.toUpperCase() ? 13 : 10.5), 0)
    text(x + 86 + nameWidth + 10, 186, role, { size: 15, weight: 600, fill: roleColor[i] })
    text(x + 86, 210, line, { size: 12.5, fill: c.muted })
    text(x + 86, 232, status, { size: 12, weight: 600, fill: planned ? c.amber : c.green })
  })

  // App Server with its entry points.
  {
    panel(60, 284, 1080, 140)
    text(84, 316, t.server, { size: 14, weight: 800, fill: c.cyan, ls: 1.6 })
    text(84, 338, t.serverDetail, { size: 13, fill: c.muted })
    const clientIcons = ['globe', 'terminal', 'code', 'cloud']
    t.clients.forEach((label, i) => {
      chip(84 + i * 264, 356, 240, 48, clientIcons[i], label, { color: c.cyan })
    })
  }
  beat(84, 356, 1032, 48, c.cyan, 0, 12)

  // Flow from the App Server into the runtime.
  for (const x of [300, 600, 900]) {
    push(
      `<path d="M ${x} 424 V 470" stroke="rgba(56,214,255,0.35)" stroke-width="2" stroke-dasharray="3 5"/>`,
    )
    particle(`M ${x} 424 V 470`, 1.6, (x / 300) * 0.4, c.cyan, 3.6)
  }

  // Agent runtime: brain, loop, memory and controlled execution.
  {
    panel(60, 470, 1080, 440, { fill: 'rgba(124,140,255,0.05)', stroke: 'rgba(124,140,255,0.5)' })
    text(84, 502, t.runtime, { size: 14, weight: 800, fill: c.blue, ls: 1.6 })
    text(84, 524, t.runtimeDetail, { size: 13, fill: c.muted })

    // LLM brain card.
    panel(84, 556, 240, 236, { r: 16, fill: 'rgba(180,155,255,0.07)', stroke: 'rgba(180,155,255,0.45)' })
    push(
      '<circle cx="204" cy="642" r="58" fill="url(#halo)" class="pulse"/>',
      `<circle cx="204" cy="642" r="44" fill="url(#core)" stroke="${c.violet}" stroke-width="1.6"/>`,
    )
    icon('brain', 204, 642, 46, c.violet, 1.6)
    text(204, 728, t.llm[0], { size: 17, weight: 700, anchor: 'middle' })
    text(204, 752, t.llm[1], { size: 12.5, fill: c.muted, anchor: 'middle' })
    push('<path d="M 324 674 H 488" stroke="rgba(180,155,255,0.5)" stroke-width="2" stroke-dasharray="3 5"/>')

    // Agent loop ring.
    const cx = 600
    const cy = 680
    const r = 100
    push(
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(124,140,255,0.25)" stroke-width="2"/>`,
      `<g fill="none" stroke="${c.cyan}" stroke-linecap="round" stroke-dasharray="110 518.3"` +
        ` transform="rotate(-90 ${cx} ${cy})">` +
        `<circle cx="${cx}" cy="${cy}" r="${r}" stroke-width="10" stroke-opacity=".2" class="comet"/>` +
        `<circle cx="${cx}" cy="${cy}" r="${r}" stroke-width="3" class="comet"/></g>`,
      `<circle cx="${cx}" cy="${cy}" r="62" fill="url(#core)" stroke="rgba(124,140,255,0.4)"/>`,
    )
    text(cx, cy - 4, t.loop[0], { size: 14, weight: 800, anchor: 'middle', ls: 1.4 })
    text(cx, cy + 16, t.loop[1], { size: 11.5, fill: c.muted, anchor: 'middle' })
    const stepIcon = ['spark', 'doc', 'wrench', 'check', 'loop']
    const angles = [-90, -18, 54, 126, 198]
    const at = (deg) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)]
    const labelAt = [
      [at(-90)[0] + 30, at(-90)[1] + 5, 'start'],
      [at(-18)[0] + 30, at(-18)[1] + 5, 'start'],
      [at(54)[0] + 8, at(54)[1] + 42, 'middle'],
      [at(126)[0] - 8, at(126)[1] + 42, 'middle'],
      [at(198)[0] - 30, at(198)[1] + 5, 'end'],
    ]
    angles.forEach((deg, i) => {
      const [x, y] = at(deg)
      push(
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="21" fill="#18205a" stroke="${c.cyan}"` +
          ' stroke-width="1.6"/>',
      )
      icon(stepIcon[i], x, y, 22, c.cyan)
      const [lx, ly, anchor] = labelAt[i]
      text(lx.toFixed(1), ly.toFixed(1), t.steps[i], { size: 13.5, weight: 650, anchor })
    })
    particle(
      `M ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx} ${cy + r} A ${r} ${r} 0 0 1 ${cx} ${cy - r}`,
      6,
      0,
      '#ffffff',
      4.5,
    )

    // Jev: planned structured-decision helper beside the loop.
    push(
      `<circle cx="806" cy="590" r="27" fill="rgba(251,191,36,0.08)" stroke="${c.amber}" stroke-width="1.6"` +
        ' stroke-dasharray="4 5" class="spin"/>',
    )
    icon('nodes', 806, 590, 24, c.amber)
    text(806, 550, t.jev, { size: 12, weight: 600, fill: c.amber, anchor: 'middle' })
    push(
      `<path d="M 784 606 L 716 636" stroke="${c.amber}" stroke-width="1.6" stroke-dasharray="4 5" class="march"` +
        ' fill="none"/>',
    )

    // Harness memory stack.
    panel(868, 556, 248, 236, { r: 16, fill: 'rgba(56,214,255,0.06)', stroke: 'rgba(56,214,255,0.45)' })
    icon('stack', 896, 578, 22, c.cyan)
    text(916, 584, t.memory, { size: 13, weight: 800, fill: c.cyan, ls: 1.2 })
    t.memoryLayers.forEach((label, i) => {
      const y = 600 + i * 46
      panel(888, y, 216, 38, { r: 10, fill: 'rgba(56,214,255,0.08)', stroke: 'rgba(56,214,255,0.35)' })
      push(
        `<circle cx="906" cy="${y + 19}" r="4" fill="${c.cyan}" class="pulse" style="animation-delay:${i * 0.4}s"/>`,
      )
      text(922, y + 24, label, { size: 14, weight: 600 })
    })
    push(
      '<g clip-path="url(#memclip)"><rect class="sweep" x="880" y="590" width="90" height="196"' +
        ' fill="url(#sweepGrad)"/></g>',
      '<path d="M 712 680 H 868" stroke="rgba(56,214,255,0.5)" stroke-width="2" stroke-dasharray="3 5"/>',
    )

    // Controlled execution strip.
    panel(84, 820, 1032, 66, { r: 14, fill: 'rgba(52,211,153,0.07)', stroke: 'rgba(52,211,153,0.45)' })
    icon('shield', 116, 853, 26, c.green)
    text(144, 848, t.governance[0], { size: 13.5, weight: 800, fill: c.green, ls: 1.2 })
    text(144, 870, t.governance[1], { size: 13, fill: c.muted })
  }
  beat(84, 556, 240, 236, c.violet, 2.4, 16)
  beat(868, 556, 248, 236, c.cyan, 3.4, 16)
  beat(84, 820, 1032, 66, c.green, 4.4, 14)

  // Plugins plug into the runtime from below.
  for (const [i, x] of [206, 470, 734, 998].entries()) {
    push(
      `<path d="M ${x} 940 V 910" stroke="rgba(124,140,255,0.4)" stroke-width="2" stroke-dasharray="3 5"/>`,
    )
    particle(`M ${x} 960 V 910`, 1.4, 6 + i * 0.3, c.blue, 3.4)
  }
  {
    panel(60, 940, 1080, 164)
    text(84, 972, t.plugins, { size: 14, weight: 800, fill: c.blue, ls: 1.6 })
    text(84, 994, t.pluginsDetail, { size: 13, fill: c.muted })
    const moduleIcons = ['briefcase', 'book', 'flow', 'layout']
    t.modules.forEach(([label, sub], i) => {
      const x = 84 + i * 264
      for (const px of [x + 70, x + 120, x + 170]) {
        push(
          `<rect x="${px - 5}" y="1008" width="10" height="8" rx="2" fill="${c.blue}" class="pin"` +
            ` style="animation-delay:${i * 0.15}s"/>`,
        )
      }
      chip(x, 1016, 240, 66, moduleIcons[i], label, { sub })
    })
  }
  beat(84, 1016, 1032, 66, c.blue, 6, 12)

  // Two value directions on the same foundation.
  push('<path d="M 324 1104 V 1150" stroke="rgba(52,211,153,0.5)" stroke-width="2" stroke-dasharray="3 5"/>')
  particle('M 324 1104 V 1150', 1.4, 7.6, c.green, 3.6)
  push(
    `<path d="M 876 1104 V 1150" stroke="${c.amber}" stroke-width="2" stroke-dasharray="5 5" class="march"/>`,
  )
  particle('M 876 1104 V 1150', 1.4, 8.2, c.amber, 3.6)
  {
    panel(60, 1150, 528, 196, { fill: 'rgba(52,211,153,0.06)', stroke: 'rgba(52,211,153,0.55)' })
    text(84, 1182, t.fde[0], { size: 14, weight: 800, fill: c.green, ls: 1.4 })
    text(84, 1204, t.fde[1], { size: 13, fill: c.muted })
    const fdeIcons = ['book', 'database', 'building', 'code']
    t.fdeItems.forEach((label, i) => {
      const x = 84 + (i % 2) * 244
      const y = 1222 + Math.floor(i / 2) * 54
      chip(x, y, 232, 44, fdeIcons[i], label, {
        color: c.green,
        fill: 'rgba(52,211,153,0.08)',
        stroke: 'rgba(52,211,153,0.4)',
      })
    })
    text(84, 1336, t.fdeNote, { size: 12, fill: c.faint })

    panel(612, 1150, 528, 196, {
      fill: 'rgba(251,191,36,0.05)',
      stroke: 'rgba(251,191,36,0.8)',
      dashed: true,
    })
    text(636, 1182, t.mhs[0], { size: 14, weight: 800, fill: c.amber, ls: 1.4 })
    text(636, 1204, t.mhs[1], { size: 13, fill: c.muted })
    const amber = {
      color: c.amber,
      fill: 'rgba(251,191,36,0.07)',
      stroke: 'rgba(251,191,36,0.6)',
      dashed: true,
    }
    chip(636, 1222, 220, 44, 'chip', t.mhsChain[0], amber)
    chip(896, 1222, 220, 44, 'gauge', t.mhsChain[1], amber)
    push(
      `<path d="M 856 1244 H 892" stroke="${c.amber}" stroke-width="2" stroke-dasharray="4 4" class="march"/>`,
    )
    const deviceIcons = ['microscope', 'arm', 'flask']
    t.devices.forEach((label, i) => {
      chip(636 + i * 164, 1276, 152, 44, deviceIcons[i], label, { ...amber, size: 13.5 })
    })
    text(636, 1336, t.mhsNote, { size: 12, fill: c.faint })
  }
  beat(60, 1150, 528, 196, c.green, 8, 18)
  beat(612, 1150, 528, 196, c.amber, 8.6, 18)

  text(W / 2, 1380, t.footer, { size: 13.5, fill: c.muted, anchor: 'middle' })
  push('</g>', '</svg>')
  return `${out.join('\n')}\n`
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
