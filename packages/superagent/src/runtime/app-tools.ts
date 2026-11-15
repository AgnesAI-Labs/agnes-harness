// Adapted from dsh-superagent (MIT)
/**
 * What Superagent's tools read and drive: the prompt binding and skill files, the resources `orchestrator_read` serves,
 * where tool images go, and the tools host of the main session and the workers.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { TextCache } from '../app/cache.js'
import { feishuIo } from '../sources/feishu.js'
import type { SourceContext } from '../sources/host.js'
import type { ImageSink } from '../sources/kind.js'
import type { AppDeps } from './app.js'
import type { AppState, Core } from './app-core.js'
import type { EngineParts } from './app-engine.js'
import { aghHome, PromptBinding, SkillFiles } from './prompt.js'
import { modelCatalog } from './role-models.js'
import { ORCHESTRATOR_KEY } from './sessions.js'
import type { ToolsHost } from './tools.js'

export function buildTools(
  deps: AppDeps,
  state: AppState,
  core: Core,
  parts: EngineParts,
  unavailable: () => string | undefined,
) {
  const { store, sessions, log } = deps
  const { effects, prompts } = core
  const { engine, settings, assessor, outbox, passes, executor } = parts
  const skills = new SkillFiles(prompts, deps.skillsRoot ?? join(aghHome(), 'skills'))
  const binding = new PromptBinding({
    prompts,
    store,
    environment: (ticket) => (state.deployment ? core.environmentOfTicket(ticket) : undefined),
    skills,
  })
  const images: ImageSink = {
    check: async () => ({ maxBytes: 10 * 1024 * 1024 }),
    save: async ({ data, name }) => {
      const dir = join(core.machine.stateDir, 'images')
      await mkdir(dir, { recursive: true })
      const path = join(dir, `${Date.now()}-${basename(name)}`)
      await writeFile(path, data)
      return { path, read: 'Read this file with the read tool to see the image.' }
    },
  }
  const models = () => modelCatalog(core.client)
  const resources = {
    store,
    pages: new TextCache(4_000_000),
    prompts,
    commands: core.commands,
    masterId: ORCHESTRATOR_KEY,
    promptVersion: (id: string) => binding.promptVersion(id),
    mayRead: (id: string, revision: number) => binding.mayRead(id, revision),
    feishuPageSize: () => 50,
    feishu: (signal?: AbortSignal) => feishuIo(core.sources, signal),
    sourceLink: core.link,
    transcript: (id: string) => sessions.transcript(id),
    sessions: {
      status: () => ({
        ...binding.status(sessions.registry.ids()),
        notificationPending: effects.pending('notice', 'prompts'),
      }),
      modelRetry: (id: string | false | undefined) => executor.modelRetry(id),
    },
    settings,
    models,
  }
  const github = (): SourceContext => parts.sourceHost.context({ kind: 'github', health: ['github'] })
  const toolsHost: ToolsHost = {
    registry: sessions.registry,
    store,
    unavailable,
    extra: (ticket) => deps.tools?.(ticket) ?? [],
    main: {
      engine,
      store,
      prompts,
      sessions: core.notices,
      settings,
      assessor,
      resources,
      images,
      log,
      requestPass: () => passes.request(),
      sendReplies: () => outbox.sent(),
      quietly: (run) => {
        state.quiet++
        try {
          return run()
        } finally {
          state.quiet--
        }
      },
    },
    executor: {
      engine,
      store,
      sessions: core.notices,
      resources,
      get github() {
        return github()
      },
      sendReplies: () => outbox.sent(),
    },
  }
  return { skills, binding, models, toolsHost }
}
export type Tools = ReturnType<typeof buildTools>
