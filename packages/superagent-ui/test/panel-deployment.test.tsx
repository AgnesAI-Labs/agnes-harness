// @vitest-environment happy-dom
// The Deployment settings: this machine's values as the plugin configuration holds them, shown read-only.

import { act } from 'react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { PLUGIN_PAGE } from '../src/deployment.js'
import { zh } from '../src/locales.js'
import { all, at, click, find, installPanel, mount, settle, tab, text } from './helpers/panel.js'
import { problemOf, server } from './helpers/panel-server.js'

installPanel()
it("shows this machine's values and the derived accounts read-only, and links to the plugin configuration", async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  await click(find(zh['settingsGroup.deployment'], '.dt-settings-link'))
  for (const fact of [
    '/srv/superagent',
    '100000',
    '10',
    '15000',
    'acme/widgets',
    '@agent-bot',
    'Widgets Bot',
    zh.deploymentIntro,
  ])
    expect(text()).toContain(fact)
  // The panel changes none of it: no fields and no save bar, only the way to the page that does.
  expect(all('.dt-settings-body input, .dt-settings-body textarea, .dt-settings-body select')).toEqual([])
  expect(all('button').some((button) => button.textContent === zh.save)).toBe(false)
  expect(find(zh.deploymentConfigure, 'a').getAttribute('href')).toBe(PLUGIN_PAGE)
})

it('shows the setup problem and rechecks it with one effect', async () => {
  server.setup = { ...server.setup, problem: problemOf('repositoryUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  expect(text()).toContain('部署检查未通过：GitHub 来源没有设置监听的仓库。')
  await click(zh.setupCheck)
  expect(server.requests.filter((request) => request.method === 'POST')).toEqual([
    { path: 'setup/check', method: 'POST' },
  ])
})

it('says Superagent does not answer when the service is not reachable', async () => {
  at({ page: 'settings', query: { group: 'deployment' } })
  server.down = true
  await mount()
  expect(text()).toContain(zh.hostNotRunning)
})

it('reads the state every second after a setup check, until Superagent stopped answering and answers again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(zh.setupCheck)
  const second = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    await settle()
  }
  server.down = true
  await second()
  expect(text()).toContain(zh['setup.agentCliUnset'])
  server.down = false
  server.setup = { ...server.setup, problem: null }
  await second()
  expect(text()).not.toContain(zh['setup.agentCliUnset'])
  // Once it answers, the state is read every five seconds again.
  const reads = server.requests.filter((request) => request.path === 'state').length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  await settle()
  expect(server.requests.filter((request) => request.path === 'state')).toHaveLength(reads)
})

it('ends a restart that never stopped answering after half a minute, and reads the state every five seconds again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(zh.setupCheck)
  const reads = () => server.requests.filter((request) => request.path === 'state').length
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
    await settle()
  }
  const before = reads()
  await advance(10_000)
  expect(reads() - before).toBeGreaterThanOrEqual(8)
  // The restart ends at 30 s; the state is read at once, then every five seconds.
  await advance(21_000)
  const ended = reads()
  await advance(3_000)
  expect(reads()).toBe(ended)
  await advance(2_000)
  expect(reads()).toBe(ended + 1)
})
