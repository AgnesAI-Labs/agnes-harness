import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createClient } from '@agnes/sdk'
import type { IBufferCell } from '@xterm/headless'
import xterm from '@xterm/headless'
import { TuiApp } from '../src/tui/app.js'
import { FakeTerminal } from '../src/tui/terminal.js'
import { FakeEndpoint } from '../test/fake-endpoint.js'
import { SCENES, type Scene, SID, SKIPPED } from './tui-gallery-scenes.js'

// The turn ticker is the only interval on this path. Freezing it pins the spinner to its first
// frame, which is what makes two runs byte-identical.
globalThis.setInterval = (() => ({
  unref() {},
  ref() {},
  hasRef: () => false,
})) as unknown as typeof setInterval

type Theme = 'light' | 'dark' | 'mono'
type Tier = 'truecolor' | '256' | '16'
type Variant = { theme: Theme; tier: Tier }
type Run = { text: string; style: string; title: string }
type Shot = Variant & { scene: string; cols: number; rows: number; lines: string[]; runs: Run[][] }

const CWD = '/workspace/demo'
const TIER_ENV: Record<Tier, NodeJS.ProcessEnv> = {
  truecolor: { COLORTERM: 'truecolor', TERM: 'xterm-256color' },
  '256': { TERM: 'xterm-256color' },
  '16': { TERM: 'xterm' },
}
const VARIANTS = 'light/truecolor light/256 light/16 dark/truecolor dark/256 mono/truecolor mono/256'
  .split(' ')
  .map((v) => {
    const [theme, tier] = v.split('/') as [Theme, Tier]
    return { theme, tier }
  })
const BASE16 =
  '000000 cd0000 00cd00 cdcd00 0000ee cd00cd 00cdcd e5e5e5 7f7f7f ff0000 00ff00 ffff00 5c5cff ff00ff 00ffff ffffff'.split(
    ' ',
  )
const CUBE = [0, 95, 135, 175, 215, 255]
const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
function xtermRgb(i: number): string {
  if (i < 16) return `#${BASE16[i] ?? '000000'}`
  if (i < 232) {
    const v = i - 16
    return hex(CUBE[Math.floor(v / 36)] ?? 0, CUBE[Math.floor(v / 6) % 6] ?? 0, CUBE[v % 6] ?? 0)
  }
  const g = Math.min(255, 8 + 10 * (i - 232))
  return hex(g, g, g)
}
function mix(a: string, b: string): string {
  const ch = (s: string, k: number) => Number.parseInt(s.slice(1 + 2 * k, 3 + 2 * k), 16)
  return hex(...([0, 1, 2].map((k) => Math.round((ch(a, k) + ch(b, k)) / 2)) as [number, number, number]))
}
function colour(cell: IBufferCell, fg: boolean): { css: string; label: string } {
  const value = fg ? cell.getFgColor() : cell.getBgColor()
  if (fg ? cell.isFgRGB() : cell.isBgRGB()) {
    const css = hex(value >> 16, (value >> 8) & 255, value & 255)
    return { css, label: `rgb${css}` }
  }
  if (fg ? cell.isFgPalette() : cell.isBgPalette()) return { css: xtermRgb(value), label: `p${value}` }
  return { css: xtermRgb(fg ? 0 : 15), label: 'default' }
}
const escapeHtml = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

function cellRun(cell: IBufferCell): Run {
  let fg = colour(cell, true)
  let bg = colour(cell, false)
  if (cell.isInverse()) [fg, bg] = [bg, fg]
  const flags = ['b', 'd', 'i', 'u', 'v']
    .filter((_, k) => [cell.isBold(), cell.isDim(), cell.isItalic(), cell.isUnderline(), cell.isInverse()][k])
    .join('')
  const style = [
    `color:${cell.isDim() ? mix(fg.css, bg.css) : fg.css}`,
    `background:${bg.css}`,
    ...(cell.isBold() ? ['font-weight:bold'] : []),
    ...(cell.isItalic() ? ['font-style:italic'] : []),
    ...(cell.isUnderline() ? ['text-decoration:underline'] : []),
  ].join(';')
  const ch = cell.getChars() || ' '
  const glyph =
    ch.charCodeAt(0) < 0x80
      ? escapeHtml(ch)
      : `<x${cell.getWidth() === 2 ? ' class=w' : ''}>${escapeHtml(ch)}</x>`
  return { text: glyph, style, title: `fg ${fg.label} · bg ${bg.label}${flags ? ` · ${flags}` : ''}` }
}

async function replay(term: FakeTerminal, cols: number, rows: number) {
  const x = new xterm.Terminal({ cols, rows, allowProposedApi: true })
  for (const w of term.writes) await new Promise<void>((r) => x.write(w, r))
  const buffer = x.buffer.active
  const lines: string[] = []
  const runs: Run[][] = []
  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(buffer.baseY + y)
    lines.push(line?.translateToString(true) ?? '')
    const row: Run[] = []
    for (let col = 0; col < cols && line; col++) {
      const cell = line.getCell(col)
      if (!cell || cell.getWidth() === 0) continue
      const run = cellRun(cell)
      const last = row.at(-1)
      if (last && last.style === run.style && last.title === run.title) last.text += run.text
      else row.push(run)
    }
    runs.push(row)
  }
  x.dispose()
  return { lines, runs }
}

async function settle(term: FakeTerminal, scene: Scene, cols: number, rows: number, anchors: string[]) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const before = term.writes.length
    const screen = await replay(term, cols, rows)
    const joined = screen.lines.join('\n')
    await new Promise((r) => setTimeout(r, 30))
    if (anchors.every((a) => joined.includes(a)) && term.writes.length === before) return screen
    if (Date.now() > deadline)
      throw new Error(`${scene.id}: never showed ${JSON.stringify(anchors)}\n${joined}`)
  }
}

async function capture(scene: Scene, variant: Variant, prefs: string): Promise<Shot> {
  const { cols = 100, rows = 30, ready = ['What do you want to do?'] } = scene
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0' } },
    }))
    .on('session/new', () => ({ sessionId: SID }))
    .on('_agnes/v1/session.attach', () => ({
      generation: 1,
      lastSeq: scene.timeline.upto,
      resolvedProfileHash: 'h',
    }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.projectUI', () => structuredClone(scene.timeline))
  for (const [method, handler] of Object.entries(scene.handlers ?? {})) endpoint.on(method, handler)
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  const session = await client.session.new({ cwd: CWD })
  const term = new FakeTerminal({ columns: cols, rows }, TIER_ENV[variant.tier])
  // A scene that lists files gets them on disk; the rail still names the fixed gallery cwd.
  const files = scene.files && mkdtempSync(join(tmpdir(), 'tui-gallery-files-'))
  for (const file of scene.files ?? []) {
    mkdirSync(dirname(join(files as string, file)), { recursive: true })
    writeFileSync(join(files as string, file), '')
  }
  const app = new TuiApp({
    session,
    term,
    // Fixed clock and dice: the greeting and the tip are part of the screen.
    welcome: {
      now: () => new Date(2026, 9, 21, 20, 30).getTime() + 3_600_000,
      random: () => 0.1,
      ...(scene.welcome ? { version: '0.9.3' } : {}),
    },
    profile: 'local-dev',
    preset: 'standard',
    model: 'deepseek-v4-pro',
    cwd: files || CWD,
    probeWorkspace: async () => scene.workspace ?? { root: CWD, subpath: '' },
    themePreferencePath: join(prefs, `${variant.theme}.json`),
    ...(scene.locale ? { locale: scene.locale } : {}),
  })
  try {
    await app.start()
    let screen = await settle(term, scene, cols, rows, ready)
    if (scene.act) {
      scene.act({ term, endpoint, sessionId: session.id })
      screen = await settle(term, scene, cols, rows, scene.done ?? ready)
    }
    return { scene: scene.id, ...variant, cols, rows, ...screen }
  } finally {
    await app.stop()
    await client.close()
    await endpoint.close()
    if (files) rmSync(files, { recursive: true, force: true })
  }
}

function figure(s: Shot): string {
  const rows = s.runs.map(
    (row) =>
      `<div class=r>${row.map((r) => `<span style="${r.style}" title="${r.title}">${r.text}</span>`).join('')}</div>`,
  )
  return `<figure><figcaption>${s.theme} · ${s.tier} · ${s.cols}×${s.rows}</figcaption><pre class=t style="width:${s.cols}ch">${rows.join('\n')}</pre></figure>`
}

function html(shots: Shot[]): string {
  const sections = SCENES.map(
    (scene) =>
      `<section id="${scene.id}"><h2>${escapeHtml(scene.title)} <small>${scene.id}</small></h2><div class=g>${shots
        .filter((s) => s.scene === scene.id)
        .map(figure)
        .join('\n')}</div></section>`,
  )
  const skipped = SKIPPED.length
    ? SKIPPED.map((s) => `<li><b>${s.scene}</b>: ${escapeHtml(s.reason)}</li>`).join('')
    : '<li>none: every planned scene is reachable through the fakes</li>'
  return `<!doctype html>
<html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>agh TUI gallery</title>
<style>
:root{color-scheme:light dark}
body{margin:16px;background:Canvas;color:CanvasText;font:14px/1.4 system-ui,sans-serif}
nav a{margin-right:8px}
.g{display:flex;flex-wrap:wrap;gap:16px}
figure{margin:0;max-width:100%;overflow-x:auto}
figcaption{font:12px ui-monospace,monospace;margin-bottom:4px}
pre.t{margin:0;font:13px/1.25 ui-monospace,Menlo,monospace;background:${xtermRgb(15)};color:${xtermRgb(0)};outline:1px solid GrayText}
.r{white-space:pre;height:1.25em}
x{display:inline-block;width:1ch;overflow:hidden;vertical-align:top;color:inherit;background:inherit}
x.w{width:2ch}
</style></head><body>
<h1>agh TUI gallery</h1>
<p>Cells replayed through xterm-headless. Palette indices map to standard xterm RGB; unset (terminal default) colours are drawn as palette 0 on palette 15. Hover a run for its fg/bg mode (p&lt;n&gt; palette, rgb#…, default) and flags (b bold, d dim, i italic, u underline, v inverse).</p>
<nav>${SCENES.map((s) => `<a href="#${s.id}">${s.id}</a>`).join(' ')}</nav>
<h3>Skipped scenes</h3><ul>${skipped}</ul>
${sections.join('\n')}
</body></html>
`
}

const out = process.argv[2] ?? join(tmpdir(), 'agh-tui-gallery.html')
const prefs = mkdtempSync(join(tmpdir(), 'agh-tui-gallery-'))
try {
  for (const theme of ['light', 'dark', 'mono'])
    writeFileSync(join(prefs, `${theme}.json`), JSON.stringify({ theme }))
  const shots: Shot[] = []
  for (const scene of SCENES) for (const variant of VARIANTS) shots.push(await capture(scene, variant, prefs))
  writeFileSync(out, html(shots))
  const screens = shots.map(({ runs: _runs, ...rest }) => rest)
  writeFileSync(
    out.replace(/(\.html)?$/, '.json'),
    `${JSON.stringify({ skipped: SKIPPED, screens }, null, 2)}\n`,
  )
  process.stdout.write(`${out}\n${shots.length} screens, ${SKIPPED.length} skipped\n`)
} finally {
  rmSync(prefs, { recursive: true, force: true })
}
