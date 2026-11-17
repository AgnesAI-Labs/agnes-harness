/**
 * Browser fixture: the real panel, mounted the way the host mounts a home entry, against the fake profile services.
 * `browser.ts` bundles this file; the scenario comes from `window.superagentScenario`.
 */
import { createAntdRoot } from '@agnes/web-ui'
import { App } from '../../src/app.js'
import { en, zh } from '../../src/locales.js'
import type { Route } from '../../src/route.js'
import { translator } from '../../src/text.js'
import { problemOf } from './panel-fixtures.js'
import { resetPanelServer, server, services } from './panel-server.js'

export interface Scenario {
  route: Route
  language: 'zh-CN' | 'en'
  /** The plugin is off or the daemon does not answer. */
  offline?: boolean
  /** Superagent runs but its setup check failed. */
  setupProblem?: boolean
}
declare global {
  interface Window {
    superagentScenario?: Scenario
  }
}

const scenario = window.superagentScenario
if (!scenario) throw new Error('No Superagent scenario')
resetPanelServer()
sessionStorage.setItem('superagent/route', JSON.stringify({ route: scenario.route, stack: [] }))
if (scenario.offline) server.down = true
if (scenario.setupProblem) server.setup = { ...server.setup, problem: problemOf('agentCliUnset') }
const host = document.getElementById('home-page-host')
if (!host) throw new Error('No home page host')
createAntdRoot(host).render(
  <App
    t={translator(scenario.language === 'zh-CN' ? zh : en)}
    openSession={async () => {}}
    services={services}
  />,
)
