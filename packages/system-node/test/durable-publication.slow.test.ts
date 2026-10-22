import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, expect, it } from 'vitest'
import { publishFileDurablySync } from '../src/index.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function record() {
  const root = mkdtempSync(join(tmpdir(), 'agh-durable-reader-'))
  roots.push(root)
  const file = join(root, 'record.json')
  writeFileSync(file, 'old')
  return { root, file }
}

it('publishes after an independent short-lived reader releases the old record', async () => {
  const { root, file } = record()
  const reader = new Worker(
    `const {openSync,closeSync}=require('node:fs');
     const {parentPort,workerData}=require('node:worker_threads');
     const fd=openSync(workerData,'r');parentPort.postMessage('opened');
     parentPort.once('message',()=>setTimeout(()=>{closeSync(fd);parentPort.postMessage('closed')},30));`,
    { eval: true, workerData: file },
  )
  try {
    await new Promise<void>((resolve, reject) => {
      reader.once('message', () => resolve())
      reader.once('error', reject)
    })
    const closed = new Promise<void>((resolve) => reader.once('message', () => resolve()))
    reader.postMessage('release')
    expect(publishFileDurablySync(file, 'new', { replace: true })).toBe(true)
    await closed
    expect(readFileSync(file, 'utf8')).toBe('new')
    expect(readdirSync(root)).toEqual(['record.json'])
  } finally {
    await reader.terminate()
  }
})

it.runIf(process.platform === 'win32')(
  'refuses a sustained reader without deleting the old record or leaking a temporary',
  () => {
    const { root, file } = record()
    const fd = openSync(file, 'r')
    try {
      expect(() => publishFileDurablySync(file, 'new', { replace: true })).toThrow(
        expect.objectContaining({ code: 'EPERM' }),
      )
      expect(readFileSync(file, 'utf8')).toBe('old')
      expect(readdirSync(root)).toEqual(['record.json'])
    } finally {
      closeSync(fd)
    }
  },
)
