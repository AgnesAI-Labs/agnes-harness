# Recovery replay fixtures

The second half of the L1 replay corpus, in the same line-per-case format as
`packages/base/fixtures/replay/` and run by the same runner (`packages/host/test/replay.test.ts`),
which reads both directories as one corpus.

They live here rather than beside base's cases because they are not about base. A recovery case is
about the kernel picking a turn back up after the process that started it died, and staging that
needs the runner to tear a host down between two model calls and bring a second one up on the same
data directory. That is the runner's business, not any one package's fixtures.

## The extra fields

Everything in base's README applies, `shipped` included - a shipped-recipe case lives here rather
than beside base's, because the recipes it loads are @agnes/code's and the assembly that resolves
them is host's. One more field is added:

```jsonc
{
  "kill": { "atStep": 0 },   // kill the process while the model call for script[0] is outstanding
  "expect": { "resumed": "retry" }   // optional: the actions resume() reported, comma-joined
}
```

The first host serves every step **before** `atStep` and then never answers: the request is
announced — `step/start`, `effect/intent`, a `request/header` — and no answer arrives, which is what
the tail of a SIGKILLed session holds. The host is then closed with the call still out. A second host
is assembled on the same data directory, opens the same session key, calls `resume()` and has to
finish the turn.

The second host's script starts at `atStep`, because a resumed request is re-sent rather than
resumed mid-stream: the model is asked the same question again, by a process that was not there when
it was first asked.

That re-sending is what makes these cases combination cases rather than recovery unit tests. The
`needs` of the step after the kill hold the resumed request to the same standard as any other: the
system prompt has to have been contributed again, the tools offered again, the conversation rebuilt.
A resume that restored the counter but not the request would satisfy a unit test and fail here.
