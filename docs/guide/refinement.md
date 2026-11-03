# Task experience (RSI)

English | [简体中文](refinement.zh-CN.md)

[Documentation](../README.md) · [CLI and TUI](cli.md) · [Web workbench](web.md) · [Sessions and recovery](sessions.md) · [Learned memory](memory.md)

Task experience lets AGH review a session in the background and keep short lessons, called **entries**, for the rest of that session: a command that needs a flag, a file that lives somewhere unexpected, a rule the user stated. Later turns of the same session get the entries as notes.

It is **off by default**. A review is a separate model call on your account. It has not yet been shown to improve results.

## Turn it on

Open **Settings → General → Task experience** in the Web workbench.

| Setting | Default | Notes |
| --- | --- | --- |
| Learn from finished work | Off | The switch for this profile |
| How reviews start | Manual only | **Manual only** or **Manual and automatic** |

- Turning it **on** takes effect the next time AGH starts. Restart AGH (the daemon, or the TUI that runs it) before you use it. Until then `/refine` says it is not active.
- Turning it **off** takes effect at once, also in open sessions.
- The setting is kept per profile. No preset key or older `auto_refine` setting can turn it on.
- Saving the settings again, even with the same values, cancels reviews that are still waiting or not yet applied.

### What turning it on allows

The settings panel lists what turning it on allows. All three items are **not available yet** and do nothing in this release:

1. Install proven skills in the workspace: a skill that was confirmed twice and is plain instructions or a sandboxed script would be installed without the usual install confirmation.
2. Let the model save skills in the workspace without waiting for a second confirmation, if it cites evidence from the session and passes the static checks.
3. Let the model save memory in the workspace. The workspace memory setting (off, ask or auto) would still decide what is written.

None of them would bring back something you uninstalled, rolled back or deleted. Today every entry stays inside its session.

## Manual and automatic reviews

A **manual** review is one you ask for:

- `/refine [focus]` in the TUI or the Web message box. The optional focus (at most 512 characters) tells the review what to look at. The reply says the review is queued; the result shows in the conversation.
- `/refine --workspace` only answers that saving to the workspace is not available yet.

With **Manual and automatic**, a review can also start by itself:

- after a compaction that replaced the history with a model summary (not after the fallback that cuts history without a summary);
- when the same tool fails with the same error three times in one turn. Numbers, paths and long hex strings are ignored when errors are compared. Refusals do not count: a rejected approval, a permission, credential or budget error, a pause or a cancel;
- when the model asks for one with the `harness_refine` tool.

Automatic reviews have limits. Manual reviews are not counted against them; they only wait for a review that is already running.

| Limit | Value |
| --- | --- |
| Completed turns since the last automatic review started | at least 5 (the first one needs none) |
| Automatic reviews per hour | at most 4 |
| Wait after any review ends | 120 s |
| Automatic reviews per session | at most 10 |
| Tokens for all reviews of a session, input and output | 65,536 (manual reviews included) |

One review runs per session at a time. A newer request replaces one that is still waiting, but an automatic one never replaces a waiting manual one. A review plans in the background, so you can keep working. Its result is applied only between two turns: if a turn is running, it waits for the end of that turn.

A review reads this session's requests, tool calls and results, and compaction summaries. It uses the session's current main model and gives it up to 60 seconds (90 seconds for a manual review).

## What a review saves

An **entry** has a kind, an id, a title and a text. There are four kinds:

| Kind | What it holds |
| --- | --- |
| Prompt | A narrow behaviour rule |
| Memory | A fact or preference for this session |
| Skill | Steps worth repeating, written as instructions |
| Subagent | How to hand a repeated kind of work to a subagent |

A skill or subagent entry is text the model can read and follow. It does not install a skill or start a subagent.

A review changes at most 5 entries, each at most 2,000 characters, and it is applied whole or not at all. If an entry changed after the review read it, nothing from that review is saved. Each kind keeps at most 200 entries; a review that would go past that is not applied.

### Session and task entries

Every entry has a level:

- A **session** entry lasts until the session ends, or until it is changed, deleted or withdrawn. To get this level, a lesson must quote at least 12 characters of your own request word for word, or rest on a failure followed by a success of the same tool on the same target. Lessons proposed directly by the model with `harness_propose` are session entries too.
- A **task** entry belongs to the current goal (see [Persistent goals](sessions.md#persistent-goals)). It expires when the goal is completed, cleared, or replaced by a new goal. Pausing, resuming or editing the goal keeps it. Without a goal, task lessons are not saved. While the goal cannot be read, its task entries are held back and come back when it can.

The model is told when a task entry expires.

## How entries reach the model

Entries never change the system prompt. They reach the model as notes added to the conversation:

- At the start of a session, and after a compaction, a **snapshot**: a fixed short guidance text, then the entries. Prompt and memory entries are given in full. Skill and subagent entries are given as one line of metadata each, only the 3 most relevant of each kind; the note says how many more are saved.
- After a review is applied, an **update** with the entries it added or changed.
- Withdrawals, deletions and expiries are announced first, before any new entry text.

The entry text is marked as untrusted data, not as instructions, and ranks below system rules, project rules and your latest instructions. The model reads the rest with the `harness_inspect` tool: search (up to 10 results), list (20 per page) or read one entry (up to 2,000 characters). To change a saved entry directly, the model must first read it in full.

When the switch is on, the guidance text is added even before the session has any entry.

### The model's tools

With the switch on, the model has three tools:

- `harness_refine` asks for a review (automatic mode only; it counts as an automatic review).
- `harness_propose` saves a change directly, without a review call. It can create an entry, or change or delete one it has read in full.
- `harness_inspect` reads the saved entries, as above.

## Withdraw a review

In the Web conversation, each review has a line that shows what started it, how it ended and the names of the entries it saved or removed (never their text). An applied review has a **Withdraw** action:

- The entries go back to how they were before that review. The model is told in its next request that they were withdrawn.
- If an entry changed after that review, nothing is withdrawn and the line says which entries changed. Resolve it by hand.
- Withdrawing works while task experience is off, and at any time, also during a turn.
- The line then shows "Withdrawn since".

The TUI shows the same lines as text but has no withdraw action. A client can call `_agnes/v1/session.refine.rollback` ([API and schemas](../reference/api.md)).

## Cost

- Each review is a model call billed to your account, from a token budget of its own: 65,536 tokens for all reviews of a session. It never draws on a turn's budget.
- In the TUI, the footer, `/status` and the `/usage` figures leave review spend out, and `/usage` lists it on its own **RSI cost** line.
- The Web counts review spend in the session's usage totals.
- The guidance and entry notes add tokens to every request of a session where task experience is on.

## Turn it off

Turning the switch off stops new reviews, stops applying results that are waiting, and stops sending entries, at once. The model gets one note that task experience is switched off. The three tools stay listed until AGH restarts, but answer that it is off. Saved entries stay in the session's record and are sent again once it is on and active. If it was on when AGH started, turning it back on works at once; otherwise restart. Withdrawing still works while it is off.

## Compared with Prime Agent

- Prime Agent keeps session entries and global entries for every session (`/refine --global`). AGH keeps entries in the session only and promotes nothing to the workspace.
- Prime Agent applies a review edit by edit. AGH applies the whole review or nothing.
- Prime Agent starts automatic reviews only after a compaction, with a 20-minute cooldown. AGH also starts them after repeated failures and on the model's request, within the limits above.
- AGH delivers entries as untrusted data, and the feature is off until you turn on the switch of your profile.

## Known limits

- Forks are child sessions. A fork, a rewind and a subagent get no reviews and no entry notes, and cannot withdraw.
- Entries are kept per session. A new session starts empty.
- Saving to the workspace is not available yet.
- A terminal started with `--standalone` runs its own embedded host, which does not serve `/refine`: it answers that the command is not supported. Automatic reviews still run there.
- No review runs on a main model with no price, or with a zero input or output price: automatic reviews do not start, and a review you ask for ends without a model call.
- Turns that carry an entry note may ask you to approve more commands. The note is untrusted content, so approval rules that would allow a command in a clean turn may not apply. The same is true for turns that read entries with `harness_inspect`.
- Obvious credentials in tool output are masked before the review model sees it. The masking is not complete.

## Diagnostics and exports

Diagnostics bundles, diagnostic event exports and session exports contain the conversation as it was written, including the entry notes the model received and the text of the experience tools. Review them before you share them.
