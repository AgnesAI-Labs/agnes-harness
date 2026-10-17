// @vitest-environment happy-dom
import { test } from 'vitest'
import { registerClientTests } from './client.cases.mjs'

type Case = { name: string; run: () => void | Promise<void> }
const cases: Case[] = []
registerClientTests((name, run) => cases.push({ name, run }))
for (const entry of cases) test(entry.name, entry.run)
