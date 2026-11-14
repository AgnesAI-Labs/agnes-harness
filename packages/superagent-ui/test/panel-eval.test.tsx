// @vitest-environment happy-dom
// The Eval status and settings.
import { act } from 'react'
import { expect, it } from 'vitest'
import { en, zh } from '../src/locales.js'
import { all, click, field, find, mount, remount, settle, tab, text, type, usePanel } from './helpers/panel.js'
import { server } from './helpers/panel-server.js'

usePanel()
it('opens the Decisions under Policy from the flow line with their reasons, Decisions that start work first, filterable by kind', async () => {
  await mount()
  await click(all('.dt-stat button')[1]!)
  expect(tab(zh['tab.eval']).getAttribute('aria-selected')).toBe('true')
  expect(server.requests.some((request) => request.path === 'decisions?limit=30&kind=accept,reopen&window=24h')).toBe(true)
  expect(text()).toContain(zh['reason.explicitRouted'])
  await click(zh.stop)
  expect(server.requests.some((request) => request.path === 'decisions?limit=30&kind=stop&window=24h')).toBe(true)
  expect(text()).toContain('@bot 修一下')
  await click(zh['decision.ignore'])
  expect(server.requests.some((request) => request.path === 'decisions?limit=30&kind=ignore&window=24h')).toBe(true)
  expect(text()).toContain(zh.none)
  await click(zh.lastDayOnly)
  expect(server.requests.some((request) => request.path === 'decisions?limit=30&kind=ignore')).toBe(true)
})

it('keeps a Policy draft across remounts, and merges another save into it sender by sender and rule by rule', async () => {
  const addUser = async () => {
    await click(all('.dt-part button').find((button) => button.textContent === '添加')!)
    const row = all('.dt-part .dt-rows-item').at(-1)!
    await type(row.querySelector<HTMLInputElement>('input[aria-label="open_id"]')!, 'ou_newperson')
    await type(row.querySelector<HTMLInputElement>('input[aria-label="名字"]')!, '新人')
  }
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(all('.dt-subtab').map((tab) => tab.textContent)).toEqual(['飞书', 'GitHub'])
  await addUser()
  expect(text()).toContain(zh.draftKept)
  await remount()
  expect(text()).toContain(zh.draftRestored)
  expect(all('.dt-part .dt-rows-item')).toHaveLength(2)
  // Someone else renames a rule and allows another sender meanwhile: the draft keeps its own sender and takes both of theirs.
  const { policy } = server.settings
  server.settings = {
    ...server.settings,
    policy: {
      ...policy,
      rules: [{ ...policy.rules[0]!, name: '文案' }],
      sources: {
        ...policy.sources,
        feishu: {
          ...policy.sources.feishu!,
          allowed: [...policy.sources.feishu!.allowed, { id: 'ou_bob', name: 'Bob' }],
        },
      },
    },
  }
  server.revisions.policy = 4
  await click(zh.save)
  expect(text()).toContain(zh.saveMerged)
  await type(all('.dt-part input[aria-label="名字"]').at(-2) as HTMLInputElement, '新同事')
  expect(text()).not.toContain(zh.saveMerged)
  await click(zh.save)
  expect(server.settings.policy.sources.feishu!.allowed).toEqual([
    { id: 'ou_alice', name: 'Alice' },
    { id: 'ou_newperson', name: '新同事' },
    { id: 'ou_bob', name: 'Bob' },
  ])
  expect(server.settings.policy.rules.map((rule) => rule.name)).toEqual(['文案'])
  expect(sessionStorage.getItem('superagent/draft/master/policy')).toBeNull()
})

it("keeps the Policy to its rules and each Source's part, in that Source's own identities", async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  await click(find(zh['term.eval'], '.dt-settings-link'))
  // Auto-merge and its threshold are prompt text, and no Source's settings sit in the Policy core.
  for (const gone of ['自动合并', '行数阈值', '成员', '计入策略版本']) expect(text()).not.toContain(gone)
  expect(all('.dt-lv').map((item) => item.textContent)[0]).toBe('策略版本 abcdef12')
  expect(text()).toContain('名单内的人 @ 机器人或私聊机器人，总是明确的请求')
  await click(find(zh['source.github'], '.dt-subtab'))
  expect(text()).toContain('能发起工作的 GitHub 账号')
  expect(text()).toContain('名单里的账号在 Issue 或评论里 @ 智能体的账号。')
  // A saved account shows as its id; only a row being added is a field.
  expect(all('.dt-part .dt-rows-item .dt-row-label').map((label) => label.textContent)).toEqual(['alice'])
})

it('opens the rule list for an invalid field inside it only', async () => {
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const openRows = () => all('.dt-disclosure[data-open]').length
  await act(async () => {
    field(zh.evalTimeout).dispatchEvent(new Event('invalid', { bubbles: false }))
  })
  expect(openRows()).toBe(0)
  await click(all('.dt-rule [data-disclosure-row]')[0]!)
  await act(async () => {
    all('.dt-rule input')[0]!.dispatchEvent(new Event('invalid'))
  })
  expect(openRows()).toBe(all('.dt-rule').length)
})

it("syncs a Source's list from where the Source keeps it, but not while a Policy draft is unsaved", async () => {
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect([...all('.dt-part select')[0]!.querySelectorAll('option')].map((option) => option.textContent)).toEqual(['不同步', '另一个群', '团队群'])
  await click(find('立即同步', '.dt-part button'))
  expect(server.requests.some((request) => request.path === 'policy-sync/feishu' && request.method === 'POST')).toBe(true)
  await type(all('.dt-part select')[0] as HTMLSelectElement, 'oc_other')
  const before = server.requests.length
  await click(find('立即同步', '.dt-part button'))
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.syncNeedsSave)
  expect(server.requests.slice(before).some((request) => request.path.startsWith('policy-sync'))).toBe(false)
})

it('adds, copies, renames, disables and deletes rules in Policy without touching Eval', async () => {
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await click(zh.addRule)
  await type(field<HTMLInputElement>(zh.ruleName), '文档')
  await type(field<HTMLTextAreaElement>(zh.ruleInstruction), '修复失效链接')
  await click(zh.duplicate)
  expect(all('.dt-rule').map((rule) => rule.querySelector('[data-disclosure-row]')!.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('文档 副本')]))
  await click('启用规则：文案修改')
  const removeButtons = all('button').filter((button) => button.textContent === '删除')
  await click(removeButtons.at(-1)!)
  await click(zh.save)
  expect(server.settings.policy.rules.map((rule) => [rule.name, rule.enabled])).toEqual([
    ['文案修改', false],
    ['文档', true],
  ])
  expect(server.requests.filter((request) => request.method === 'PUT').map((request) => request.path)).toEqual(['settings/policy'])
})

it("shows the current Policy version once, explains what makes it up, and opens a Mandate's version in the Policy history", async () => {
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await settle()
  expect(all('.dt-lv')[0]!.textContent).toBe('策略版本 abcdef12')
  expect(
    all('.dt-info')
      .map((tip) => tip.getAttribute('aria-label'))
      .join('\n'),
  ).toContain('策略版本由接单规则、各来源上的策略和评估的接单模式决定')
  expect(all('.dt-tag').filter((tag) => tag.textContent === '计入策略版本')).toHaveLength(0)
  await click(tab(zh['tab.execution']))
  await click('修复回归')
  await click('abcdef12')
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.eval'])
  await settle()
  // The history opens at the save that made the version, and lists versions that Source saves made too.
  expect(document.querySelector('.dt-highlight')?.textContent).toContain('生成策略版本 abcdef12')
  expect(text()).toContain('生成策略版本 98765432')
})

it('sets the Feishu admission table per receiving scope, offering only the cells a scope can receive, and warns when anyone may originate work', async () => {
  server.settings = {
    ...server.settings,
    sources: {
      ...server.settings.sources,
      feishu: {
        enabled: true,
        config: {
          cli: 'lark-bot',
          chats: [
            { chatId: 'oc_team', listen: 'all' },
            { chatId: 'oc_other', listen: 'mentions' },
          ],
          directMessages: true,
          otherChats: 'none',
        },
      },
    },
  }
  await mount()
  await click(tab(zh['tab.settings']))
  await click(find(zh['term.eval'], '.dt-settings-link'))
  const rows = all('.dt-admission tbody tr').map((row) => [row.querySelector('.dt-admission-scope')!.firstChild?.textContent, row.querySelectorAll('select').length])
  // Chats receiving every message have all three cells; @-only chats only the mention cell; other chats nothing while not received.
  expect(rows).toEqual([
    ['团队群', 3],
    ['另一个群', 1],
    ['其他群', 0],
    ['私聊', 1],
  ])
  const cell = field<HTMLSelectElement>('团队群 · 名单外 · 点名智能体')
  expect(cell.value).toBe('ignore')
  await type(cell, 'explicit')
  // The warning is an icon in a slot every cell reserves, with the text on hover, so the table does not move.
  expect(document.querySelector('.dt-admission .dt-info-warn')?.getAttribute('aria-label')).toBe(zh.admissionAnyoneWarning)
  expect(all('.dt-admission-slot')).toHaveLength(5)
  // A message not addressed to the bot cannot be an explicit request.
  expect([...field<HTMLSelectElement>('团队群 · 名单外 · 未 @').options].map((option) => option.value)).toEqual(['inferred', 'ignore'])
  await click(zh.save)
  expect(server.settings.policy.sources.feishu!.admission).toEqual({
    oc_team: { unlistedAddressed: 'explicit' },
  })
})

it("lists each Source's bots next to its people and saves them, and sets the GitHub admission table by its receiving scopes", async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  // The GitHub Source receives only what is addressed to the agent until a switch opens a scope of the repository.
  const github = all('.dt-card').find((card) => card.querySelector('.dt-card-title')?.textContent === 'GitHub')!
  expect([...github.querySelectorAll('.dt-switch-row')].map((row) => row.textContent)).toEqual(['接收仓库里的新 Issue', '接收仓库里的新 PR', '接收仓库里的评论', '接收默认分支的 CI'])
  expect([...github.querySelectorAll('[role="switch"]')].slice(1).map((item) => item.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false', 'false'])
  await click(find(zh['term.eval'], '.dt-settings-link'))
  const lists = () => all('.dt-part > .dt-field .dt-subhead .dt-field-head').map((head) => head.firstChild?.textContent)
  const list = (label: string) => all('.dt-part > .dt-field').find((item) => item.textContent?.startsWith(label))!
  const add = async (label: string) => {
    await click([...list(label).querySelectorAll('button')].find((button) => button.textContent === zh.addRow)!)
    return [...list(label).querySelectorAll('.dt-rows-item')].at(-1)!
  }
  expect(lists()).toEqual(['能发起工作的飞书用户', '消息可以成为候选的机器人'])
  const bot = await add('消息可以成为候选的机器人')
  await type(bot.querySelector<HTMLInputElement>('input[aria-label="App ID 或 open_id"]')!, 'cli_reviewer')
  await type(bot.querySelector<HTMLInputElement>('input[aria-label="名字"]')!, '评审机器人')
  await click(find(zh['source.github'], '.dt-subtab'))
  expect(lists()).toEqual(['能发起工作的 GitHub 账号', '评论可以成为候选的机器人'])
  await type((await add('评论可以成为候选的机器人')).querySelector<HTMLInputElement>('input[aria-label="账号"]')!, 'dependabot[bot]')
  // Until the GitHub Source receives the repository's Issues, pull requests, comments or CI, only messages that mention the agent arrive.
  const rows = () => all('.dt-admission tbody tr').map((row) => [row.querySelector('.dt-admission-scope')!.firstChild?.textContent, row.querySelector('.dt-admission-scope small')?.textContent, row.querySelectorAll('select').length])
  expect(rows()).toEqual([
    ['新 Issue', '仅 @', 1],
    ['新 PR', '仅 @', 1],
    ['评论', '仅 @', 1],
    ['默认分支的 CI', '不接收', 0],
  ])
  expect(field<HTMLSelectElement>('新 Issue · 名单外 · 点名智能体').value).toBe('ignore')
  await click(zh.save)
  expect(server.settings.policy.sources.feishu!.bots).toEqual([{ id: 'cli_reviewer', name: '评审机器人' }])
  expect(server.settings.policy.sources.github!.bots).toEqual([{ id: 'dependabot[bot]' }])
})

it("shows the GitHub Source's switches for what it receives across the repository, and the admission rows they open, in English", async () => {
  server.settings.sources.github = {
    ...server.settings.sources.github!,
    config: { ...server.settings.sources.github!.config, observeIssues: true, observeCi: true },
  }
  await mount(en)
  await click(tab(en['tab.settings']))
  const github = all('.dt-card').find((card) => card.querySelector('.dt-card-title')?.textContent === 'GitHub')!
  expect([...github.querySelectorAll('.dt-switch-row')].map((row) => [row.textContent, row.querySelector('[role="switch"]')?.getAttribute('aria-checked')])).toEqual([
    ['Receive new Issues in the repository', 'true'],
    ['Receive new pull requests in the repository', 'false'],
    ['Receive comments in the repository', 'false'],
    ["Receive the default branch's CI", 'true'],
  ])
  await click(find('Receive comments in the repository', '[role="switch"]'))
  await act(async () => {
    github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await settle()
  expect(server.settings.sources.github!.config).toMatchObject({
    observeIssues: true,
    observeComments: true,
    observeCi: true,
  })
  await click(find(en['term.eval'], '.dt-settings-link'))
  await click(find(en['source.github'], '.dt-subtab'))
  const rows = all('.dt-admission tbody tr').map((row) => [row.querySelector('.dt-admission-scope')!.firstChild?.textContent, row.querySelectorAll('select').length])
  expect(rows).toEqual([
    ['New Issues', 3],
    ['New pull requests', 1],
    ['Comments', 3],
    ['Default branch CI', 1],
  ])
  // CI has no sender: its one cell is that of a message off the list that does not mention the agent.
  expect(field('Default branch CI · Not on the list · no mention')).toBeTruthy()
  expect(all('.dt-admission thead th').map((cell) => cell.textContent)).toContain(en.admissionAddressed)
})
