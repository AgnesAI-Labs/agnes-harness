# L1 replay fixtures

One JSON object per line, one case per object. The runner is
`packages/host/test/replay.test.ts`: it assembles a **real** host — package loading, the extension
host, the seams, the prompt contribution — and replaces only the model, because the model is the
only nondeterministic part. That is what makes asserting a tool-call *sequence* meaningful.

These cases exist because two features can each pass their own demo and still be broken together.
Every combination defect found from here becomes a row in this directory.

## Adding a case

Copy a line, change it, done. No code changes are needed for a new case.

```jsonc
{
  "id": "0003-something",                 // unique; it is the test name
  "exercises": ["scheduler/tool-calls"],  // which capabilities this case holds to account
  "workspace": { "NOTE.md": "..." },      // optional: files written into the session cwd first
  "policy": [                             // optional: run against base's real approval seam with
    { "tool": "shell",                    //   these rules in the resolved preset. Without it the
      "argv": "^/bin/echo ok",            //   assembly keeps the faked approval that allows
      "action": "allow" }                 //   everything, which is what every other case wants.
  ],
  "prompterSays": "allowed-session",   // optional: what the connected operator answers
  "prompt": "what the user typed",
  "script": [                             // one entry per model turn, in order
    {
      "needs": {                          // what the scripted model insists the request contains
        "systemIncludes": ["..."],        //   substrings of the assembled system prompt
        "messagesInclude": ["..."],       //   substrings of the conversation, where tool results land
        "toolsOffered": ["read"]          //   tool names the request must offer
      },
      "toolCall": { "name": "read", "args": { "path": "NOTE.md" } }
    },
    { "needs": { "messagesInclude": ["4417"] }, "text": "The launch code is 4417." }
  ],
  "expect": { "toolCalls": ["read"], "finalTextIncludes": "4417" }
}
```

### Scripting the model at the wire instead

`"wire": true` on a case moves the scripted model one layer down: instead of standing in for the
whole model layer, the script stands in for what the wire carried, and the real `@agnes/ai` provider
runs on top of it — the decode chain, the sequence guard and the credit estimate included. Use it
for anything that happens *inside* the model layer, because a case scripted at the Provider boundary
hands the kernel a finished tool call and a finished usage event and can say nothing about how
either was arrived at.

Two extra fields come with it:

```jsonc
{
  "wire": true,
  "script": [
    // Raw model output. Whatever the decode chain makes of it is what the kernel sees - so this is
    // how a call written in a model's own prose syntax gets into the corpus.
    { "wireText": "<function=read>\n<parameter=path>\nNOTE.md\n</parameter>\n</function>\n" }
  ],
  "expect": {
    "toolCalls": ["read"],
    "eventTypes": ["cost/ledger"],   // ledger event types the turn must have written
    "creditsAbove": 0                // the credits on those cost rows must add up to more than this
  }
}
```

A wire case is priced by the runner at a stated credit rate rather than the default one, so a number
asserted here is a fact about that configuration and not about a fallback nobody chose.

`needs` is what makes a capability load-bearing rather than merely present. A step whose needs are
not met refuses to play its part and answers with a fixed sentinel instead, so `expect` goes red and
the failure message names the unmet requirement. A model that was not told its situation, or was not
offered the tool, behaves differently — which is the real failure this corpus is written against,
not a separate assertion bolted on beside it.

Two rules keep a case honest:

- **`expect.finalTextIncludes` must not be a substring of anything a `needs` entry looks for.** The
  sentinel carries none of the fixture's own words, so this is safe by construction today; keep it
  that way if you change the sentinel.
- **Only claim an `exercises` tag you can show going red.** Switch the capability off, watch this
  case fail, switch it back on. A tag nobody can falsify is a label, not a claim. The known tags,
  and what each one means, are listed in the runner.

`prompterSays` is what makes a policy verdict falsifiable. With nobody connected, an unmatched call
and a denied one both come back as `approval rejected`, so a deny case would stay green with its own
rule deleted. Connect an operator who says the opposite of what the rule says, and only the rule can
produce the outcome the case asserts.

A rule in `policy` is read twice: this package's approval seam evaluates it, and the host validates
it when the session opens. The host's validator requires every `argv` to start with `^`, and an
`allow` rule's `argv` to require an absolute path - so an `allow` for a shell command line has to
name the binary by absolute path, which is why the case above says `/bin/echo` rather than `echo`.
The action is spelled `allow`, `require_approval` or `deny`. `ask` still parses for one version and
is reported on the host audit when the session opens; do not write a new case in it.

## Running a case against the recipes that ship

```jsonc
{ "shipped": true }   // instead of `policy`
```

The assembly then loads @agnes/base's `base` and every recipe @agnes/code registers, off disk, and
runs base's real approval seam behind them. It is the one document a real installation loads, and it
was the only one nothing here ran: a case that hands the host a preset object written for the case at
hand cannot see a defect in the delivered one, and two of them lived there at once. A shipped case
states no `policy` of its own - the shipped table is the thing under test - and the runner refuses a
case that tries.

## The count gate

`AGNES_REPLAY_MIN` (default 36, matching `REPLAY_FLOOR` in `packages/host/test/replay.test.ts`) is
the floor the runner enforces, counted across **both**
fixture directories: this one and `packages/host/test/fixtures/replay/`, which holds the cases that
need the runner to kill a host and bring a second one up, and the ones that run the recipes
@agnes/code ships. It rises with the corpus. Raise the default in the runner whenever you add cases
— a floor below the corpus stops nobody deleting a case rather than fixing it.

The Base directory itself now contains 30 cases. The five cases added at the I7 closeout keep using
the default assembled Host path and cover distinct negative or bounded branches; they do not pad the
floor with duplicate happy paths.

Privacy and consent cannot honestly be claimed as default-Host replay yet: the resolved
`telemetry.consent` value is not part of the current `session_start` hook payload, and the privacy
extension therefore remains intentionally inert. Its deterministic capability corpus lives at
`../capability/privacy-consent.jsonl` and is replayed by
`packages/base/test/privacy-capability-replay.test.ts` against the real implementation modules.
Move those cases into this Host runner only after that contract is delivered; do not add a fake hook
that silently treats every resolved profile as `DISABLED`.
