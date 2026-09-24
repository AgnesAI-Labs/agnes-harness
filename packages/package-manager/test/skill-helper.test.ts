import { test } from 'vitest'

type Case = { name: string; run: () => void | Promise<void> }
const cases: Case[] = []
const fixture = (await import(new URL('./skill-helper.cases.mjs', import.meta.url).href)) as {
  registerSkillHelperTests: (register: (name: string, run: Case['run']) => void) => void
}
fixture.registerSkillHelperTests((name, run) => cases.push({ name, run }))
for (const entry of cases) test(entry.name, entry.run)
