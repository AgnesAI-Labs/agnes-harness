// Explicit paid acceptance only. See real-eval.md before running.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { runBehavior } from './real-behavior.mjs'
import { realRuntime, snapshot } from './real-runtime.mjs'

const scenarios = {
  skin: '做一个皮肤插件。绿色，亮暗两种主题。调色板包括 --agnes-text-primary、--agnes-bg-primary、--agnes-text-made-up、--agnes-unicorn-glow，请保留有效 token，只替换无效 token。完成候选测试并提交人工审阅。',
  itinerary:
    '做一个带 UI 面板的每日行程插件。添加、列出和删除行程项目；数据属于插件/应用档案，不是工作区文件，关闭页面和重启后保留。简洁中文界面。完成候选测试并提交人工审阅。',
  todo: '做一个待办清单插件，有自己的 UI 面板。支持添加、勾选完成，数据属于插件/应用档案，关闭页面和重启后保留。简洁中文界面。完成候选测试并提交人工审阅。',
}
const mode = process.argv[2]
assert.ok(mode in scenarios || mode === 'behavior', 'Choose skin, itinerary, todo or behavior')
const rt = await realRuntime(mode)
console.log(JSON.stringify({ root: rt.root, mode }))
const summary = { mode, startedAt: new Date().toISOString(), sessions: [] }
const observed = new Set()

async function run(input, label, answerQuestions) {
  const session = await rt.session()
  await rt.save('active-run.json', {
    sessionId: session.id,
    label,
    model: process.env.AGH_DEMO_MODEL ?? 'deepseek/deepseek-flash',
  })
  const events = []
  session.listeners.add((method, params) => {
    if (method === '_agnes/v1/session.event') {
      events.push(params.event)
      const e = params.event
      if (e.type === 'tool/call') console.log(JSON.stringify({ label, type: e.type, name: e.data?.name }))
    }
  })
  const started = Date.now()
  let answering = false,
    questionError
  const timer =
    answerQuestions &&
    setInterval(async () => {
      if (answering) return
      answering = true
      try {
        const page = await session.uiRead()
        for (const record of page.surfaces) {
          const s = record.surface
          if (
            record.status !== 'open' ||
            s.data?.question?.kind !== 'ask_user_question' ||
            observed.has(s.id)
          )
            continue
          const schema = s.components.find((c) => c.kind === 'form')?.schema
          const answers = Object.fromEntries(
            Object.entries(schema?.properties ?? {}).map(([id, p]) => {
              const fixed =
                '按请求的简洁中文界面实现，使用插件档案持久数据，默认名称即可，测试后提交审阅，不自动发布。'
              const choices = p.enum ?? p.items?.enum
              return [id, p.type === 'array' ? [choices?.[0] ?? fixed] : (choices?.[0] ?? fixed)]
            }),
          )
          await session.uiAction({
            surfaceId: s.id,
            revision: s.revision,
            actionId: 'submit',
            commandId: randomUUID(),
            input: { answers },
            selection: {},
          })
          observed.add(s.id)
        }
      } catch (error) {
        questionError = error.message
      } finally {
        answering = false
      }
    }, 1000)
  let result, error
  try {
    result = await session.prompt(input, { signal: AbortSignal.timeout(25 * 60 * 1000) })
  } catch (cause) {
    error = rt.redact(cause.message)
    await session.cancel().catch(() => {})
  } finally {
    if (timer) clearInterval(timer)
  }
  const data = {
    label,
    sessionId: session.id,
    wallMs: Date.now() - started,
    result,
    error,
    questionError,
    ...(await snapshot(session)),
    events,
  }
  await rt.save(`${label}.json`, data)
  summary.sessions.push({
    label,
    sessionId: session.id,
    wallMs: data.wallMs,
    result,
    error,
    usage: data.timeline.usage,
    turns: data.timeline.turns?.map((t) => t.usage),
    toolCalls: data.tools.length,
  })
  await rt.save('summary.json', summary)
  console.log(
    JSON.stringify({
      label,
      wallMs: data.wallMs,
      result,
      error,
      toolCalls: data.tools.length,
      usage: data.timeline.usage,
    }),
  )
  return data
}

try {
  await rt.connect()
  await rt.configure()
  if (mode === 'behavior') {
    Object.assign(summary, await runBehavior(rt))
  } else {
    const data = await run(scenarios[mode], mode, true)
    const candidates = await rt.client.request('_agnes/v1/plugins.candidates.list', { profile: 'local-dev' })
    await rt.save('candidates.json', candidates)
    for (const item of candidates.candidates) {
      const candidate = await rt.client.request('_agnes/v1/plugins.candidates.show', {
        profile: 'local-dev',
        candidateId: item.candidateId,
      })
      await rt.save(`${candidate.candidateId}.json`, candidate)
    }
    summary.candidates = candidates.candidates
    summary.passed =
      candidates.candidates.length > 0 &&
      candidates.candidates.every((candidate) => candidate.state === 'review') &&
      data.result?.reason === 'completed'
    summary.rejectedWrites = data.tools.filter(
      (t) => t.name === 'plugin_candidate_write' && t.result?.isError,
    ).length
    summary.formalTests = data.tools.filter(
      (t) =>
        t.name === 'plugin_test' || (t.name === 'plugin_helper_install' && t.call?.args?.action === 'test'),
    ).length
  }
} catch (error) {
  summary.error = rt.redact(error.message)
  process.exitCode = 1
  console.error(summary.error)
} finally {
  if (!summary.passed) process.exitCode = 1
  summary.finishedAt = new Date().toISOString()
  await rt.save('summary.json', summary)
  await rt.dispose()
}
