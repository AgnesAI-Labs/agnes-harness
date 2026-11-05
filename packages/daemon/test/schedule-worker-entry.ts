// Enable the real official reference provider in the scripted worker fixture.
process.env.AGNES_FAKE_WORKER_REFERENCES = '1'
process.env.AGNES_FAKE_WORKER_TURNS = '4'
await import('./fake-worker-entry.js')

export {}
