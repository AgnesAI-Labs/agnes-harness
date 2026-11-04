# Task experience (RSI)

English | [简体中文](refinement.zh-CN.md)

[Documentation](../README.md) · [CLI and TUI](cli.md) · [Web workbench](web.md) · [Sessions and recovery](sessions.md) · [Learned memory](memory.md)

Task experience lets AGH review a session in the background and keep short lessons, called **entries**, for the rest of that session: a command that needs a flag, a file that lives somewhere unexpected, a rule the user stated. Later turns of the same session get the entries as notes. Memory and prompt entries can also be saved to the workspace memory, where later sessions of the workspace read them (see [Save to the workspace](#save-to-the-workspace)).

It is **off by default**. A review is a separate model call on your account. It has not yet been shown to improve results.

## Turn it on

Open **Settings → General → Task experience** in the Web workbench.

| Setting | Default | Notes |
| --- | --- | --- |
| Learn from finished work | Off | The switch for this profile |
| How reviews start | Manual only | **Manual only** or **Manual and automatic** |

- Turning it **on** applies to the sessions opened from then on; no restart is needed. Sessions that are already open are not affected: they keep running without it, and `/refine` in them says it is not active. A session that has already sent requests without it stays without it when it is opened again later, also after a restart; one that never sent a request follows the switch.
- Turning it **off** takes effect at once, also in open sessions.
- The setting is kept per profile. No preset key or older `auto_refine` setting can turn it on.
- Saving the settings again, even with the same values, cancels reviews that are still waiting or not yet applied.

### What turning it on allows

The settings panel lists what turning it on allows:

1. Install proven skills in the workspace: a skill entry a review wrote is installed in the workspace as soon as it passes the checks, trusted and switched on, without the usual install confirmation. See [Saved skills](#saved-skills).
2. Let the model save skills in the workspace without waiting for a second confirmation, if it cites evidence from the session and passes the static checks.
3. Let the model save memory in the workspace: lessons a review wrote, your own saves and the model's saves go into the workspace memory. The workspace memory setting (off, ask or auto) still decides what is written.
4. Write lessons that hold everywhere to user memory: a lesson that holds in every workspace is written to user memory **automatically, without asking** (see [Save to user memory](#save-to-user-memory)).

None of them brings back something you uninstalled, rolled back or deleted.

If task experience was already on before this release, the panel shows a one-time notice that saving to the workspace memory and as workspace skills now takes effect without asking again here, that lessons holding in every workspace are written to user memory automatically, and that turning off **Learn from finished work** stops it. Dismissing the notice is remembered by that browser only; nothing is saved to your profile.

## Manual and automatic reviews

A **manual** review is one you ask for:

- `/refine [focus]` in the TUI or the Web message box. The optional focus (at most 512 characters) tells the review what to look at. The reply says the review is queued; the result shows in the conversation.
- `/refine --workspace [focus]` queues the same review, and what it keeps is also saved to the workspace as your own save (see below).
- `/refine --user [focus]` queues the same review, and what it keeps is also saved to user memory as your own save, without waiting for a second confirmation (see [Save to user memory](#save-to-user-memory)). Use either `--workspace` or `--user`, not both.
- `/refine --unpriced [focus]` (it combines with `--workspace` or `--user`) runs a review on a model with no known price. Without it, `/refine` on such a model is refused and says so; see [Cost](#cost).

With **Manual and automatic**, a review can also start by itself:

- after a compaction that replaced the history with a model summary (not after the fallback that cuts history without a summary);
- when the same tool fails with the same error twice in one session (offered once for that tool and error). Numbers, paths and long hex strings are ignored when errors are compared. Refusals do not count: a rejected approval, a permission, credential or budget error, a pause or a cancel;
- when the model asks for one with the `harness_refine` tool. This works in manual mode too, since the model chose to call it; the tool is always listed in a session opened while task experience is on.

Automatic reviews have limits. Manual reviews are not counted against them; they only wait for a review that is already running. The model's own requests are held only to a cap of 40 reviews a session (one that found nothing does not count), with no cooldown or other limit; the limits below are for the compaction and repeated-failure reviews.

| Limit | Value |
| --- | --- |
| Wait after any review ends | 120 s |
| Automatic reviews per session | at most 40 (a review that found nothing does not count) |
| Tokens for all reviews of a session, input and output | 524,288 (manual reviews and the model's requests included) |

One review runs per session at a time. A newer request replaces one that is still waiting, but an automatic one never replaces a waiting manual one. A review plans in the background, so you can keep working. Its result is applied only between two turns: if a turn is running, it waits for the end of that turn.

A review reads the session's last 5 turns: your requests, the model's replies, tool calls and results, and compaction summaries (up to about 24,000 tokens, and it may answer with up to 4,096). The model's own words are marked as untrusted, like tool output. It uses the session's current main model and gives it up to 60 seconds (90 seconds for a manual review).

## What a review saves

An **entry** has a kind, an id, a title and a text. There are four kinds:

| Kind | What it holds |
| --- | --- |
| Prompt | A narrow behaviour rule |
| Memory | A fact or preference for this session |
| Skill | Steps worth repeating, written as instructions |
| Subagent | How to hand a repeated kind of work to a subagent |

A skill or subagent entry is text the model can read and follow. It does not install a skill or start a subagent; saving a skill entry to the workspace does install it (see [Saved skills](#saved-skills)).

A review changes at most 5 entries, each at most 2,000 characters. An edit that breaks a rule is left out and the others are kept: a sixth edit is ignored, a longer text is cut, and an edit is dropped when it cites evidence the review was not shown, rewrites an entry it only saw as a reference, changed after the review read it, or is bound to a skill or role that cannot be used now. The review is refused only when nothing valid is left. Each kind keeps at most 200 entries; a review that would go past that is not applied.

### Session and task entries

Every entry has a level:

- A **session** entry lasts until the session ends, or until it is changed, deleted or withdrawn. A lesson the review marks as a session lesson gets this level as long as it cites at least one request of your own or one finished tool result from the session; it needs no quoted words. A lesson that cites only page or file text, the model's own words or a summary is kept as a task entry instead. Lessons proposed directly by the model with `harness_propose` are session entries too.
- A **task** entry is for a lesson that names this task and stops mattering when it ends; the review uses it only then, and session level is the default. A task entry belongs to the current goal (see [Persistent goals](sessions.md#persistent-goals)). It expires when the goal is completed, cleared, or replaced by a new goal. Pausing, resuming or editing the goal keeps it. Without a goal, task lessons are not saved. While the goal cannot be read, its task entries are held back and come back when it can.

The model is told when a task entry expires.

## Save to the workspace

Entries live in their session. Saving a memory or prompt entry to the workspace writes it into the workspace memory index (`MEMORY.md`, see [Learned memory](memory.md#saved-task-experience)) as one **saved paragraph**: its title, a line break and its text. Every session of the workspace then reads it with the rest of the workspace memory. Saving a skill entry installs it as a workspace skill (see [Saved skills](#saved-skills)).

### Who saves what

There are four ways in, and all go through the same checks:

| Way | Who it counts as | Needs |
| --- | --- | --- |
| Automatic: an entry a review wrote or confirmed | automatic | **Manual and automatic** mode; it is saved the first time the review applies it, once per version of the entry |
| `/refine --workspace [focus]` in the TUI or the Web message box | you | The review's applied result; each entry it wrote is saved |
| `/refine --user [focus]` in the TUI or the Web message box | you | The review's applied result; each memory or prompt entry it wrote is saved to user memory |
| **Save … to workspace** or **Save … to user memory** on an applied review line in the Web conversation | you | Nothing else; no model is called |
| The model, with `target: 'workspace'` or `target: 'user'` on `harness_propose` or `harness_refine` | the model | **Manual and automatic** mode; evidence from this session |

Only **session** entries of the **memory**, **prompt** and **skill** kinds are saved. Task entries stay in their session, and subagent entries are not saved to the workspace. A forked or child session saves nothing. An entry must rest on what happened in this session; a model save without evidence from the session is refused.

Each save is judged in a fixed order, and the first check that fails ends it:

1. Task experience is on.
2. You have not taken the content back (see below); only your own save gets past this.
3. An automatic save is of an entry a review has applied (a lesson proposed directly by the model waits for a later review to confirm it).
4. The entry passes the source and safety rules (session level, evidence, length, no secret-like text).
5. For memory and prompt entries, the workspace memory mode: **off** refuses; **ask** puts the save in the decision list; **auto** writes it. A skill entry passes the skill checks instead (below).
6. There is room in the workspace memory, or the skill is installed.

### Approvals

In **ask** mode, a save waits in **Needs attention** in the Web workbench, under **Task experience** (not under plugin requests). The request shows the exact change to `MEMORY.md` (a very long change is cut short on the card, with a note; the full change is in the request details) and the hashes of the file before and after. **Allow once** writes exactly that change, and only onto the file it was made for: if the file changed meanwhile, the save is asked again for the new file. **Reject** refuses it and counts as taking the content back. A request is open for **7 days**; after that it ends as `approval-expired`. Saves made in the background are never approved automatically, also not under full access.

### When memory is full

When the workspace memory has no room for the paragraph, the save ends with **memory full** in every mode. Nothing is merged or removed automatically. Free space yourself, by withdrawing or editing paragraphs on the memory page or editing the file, then save again.

### Review date and renewal

Every saved paragraph has a **review date 30 days** after it was saved. From that date the agent no longer sees it: the memory note of the next request leaves it out, while the system prompt stays the same. The text stays in the file.

- A later review in any session of the workspace that confirms the paragraph with new evidence renews it for another 30 days, before the date passes. The evidence that led to the save does not count again.
- On the memory page you can **Renew** a paragraph at any time, also after its date has passed.

### Taking it back

What you take back wins over automatic and model saves:

- Deleting a saved paragraph from the file (the next session open records it), **Withdraw** on the memory page, or rejecting an approval records that you took it back. After that, automatic and model saves of the same entry, or of the same content under another entry id, are refused (`user-revoked`). Content that differs only in spacing or letter case counts as the same.
- For a saved skill, uninstalling it, rolling it back or deleting its folder does the same, and also bars any skill entry of the same name.
- Your own save (`/refine --workspace` or the per-entry button) saves it again and clears the record.

### Paragraphs a person edited

A save never replaces a paragraph a person edited in place: an automatic or model save of a new version of the entry is refused as `conflict` and the person's text stays. Only your own save or an approved request replaces it. An edit that changes only spacing or letter case counts as untouched, so the next version may replace it. If a save that updated a paragraph in place was cut off by a crash and the file changed before it was settled, later automatic and model versions of that entry are refused `conflict` too, until you save the entry yourself or withdraw the paragraph.

### Save lines in the conversation

Every save gets a line in the conversation: who asked for it (automatic, you, or the model), where it went (a save to user memory says **user memory (all workspaces)**, where to withdraw it, and when this workspace does not read user memory), how it ended (saved, waiting for your approval, not saved, unknown result) and, when refused, why: for example memory full, approval expired, taken back by you (`user-revoked`), edited by a person or the file changed (`conflict`), or not available right now (`unavailable`). The line never shows the entry's text or where it was written. The TUI shows the same as text.

A save cut off by a crash is settled the next time the workspace is used. If the file changed in between so that it cannot tell what happened, the result is **unknown**: the paragraph, if it was written, stays hidden from the agent until you make it ordinary memory or withdraw it on the memory page.

## Saved skills

A skill entry saved to the workspace becomes a workspace skill. It is installed by the host in the background, without a turn and without an install confirmation: turning task experience on is the permission (item 1 and 2 above). It goes through the same order of checks as any save, then:

- **What the skill holds.** One `SKILL.md`: the entry id is the skill's name (lower case letters, digits, `.`, `_`, `-`), the entry title its description (at most 200 characters) and the entry text its instructions. Saved skills are **instructions only**: no scripts, no executable or binary files. When a script would help, the skill tells the agent to write it with its own file tools, under its usual permissions and approvals. An entry bound to a skill you already approved is a pointer to that skill and is never installed as a skill of its own.
- **Where it goes.** Only the workspace's own skill folder (`.agh/skills/<name>`), never your user skills. It is installed trusted and switched on. A name already used by a skill a person wrote (in the workspace, or a user skill) is never taken: the change is kept as a draft instead.
- **Hand-off.** Once installed, the session entry hands off to the skill: it is no longer given to the model as an entry and no longer counts toward the 200-entry limit, and the model is told once to use the workspace skill instead. The entry stays in the session's record. The next session finds the skill in its skill catalogue like any other.
- **30-day review.** Every saved skill has a review date 30 days on. A later review that confirms the skill with new evidence renews it. A skill not confirmed again is switched off (not removed) when a session opens after that date, or when you turn task experience on; it then shows as **awaiting review**. Switching it back on, on the Skills page, renews it for another 30 days. Switching off by the review is not taking it back.
- **Updates.** A new version of a skill entry (written by a review, or saved by you or the model) updates a saved skill **of the same name**, from any session, only while nobody changed the skill since it was saved. Up to five earlier versions are kept, and you can roll back to the previous one. A skill switched off by the review stays off through an update.
- **A person's skill is never overwritten.** When the skill was written by a person, or a person changed a saved skill (even between the decision and the write), the change is kept as a **draft** for you and the save is refused as `conflict`. Drafts are listed under **Saved skills** in the task experience settings, as plain text with a whole-file diff; copy what you want by hand. A workspace keeps at most 20 drafts.
- **Taking it back.** **Uninstall** or **Roll back to the previous version** under **Saved skills** in the task experience settings, removing the skill on the Skills page, or deleting its folder, records that you took it back. A deleted folder is noticed the next time a skill is saved in that workspace; until then **Saved skills** still shows the skill as on. After that, automatic and model saves of the same entry, of any skill entry with the same name, or of the same content under another name, are refused (`user-revoked`). Only your own save (`/refine --workspace`, or **Save … to workspace** on a review line) installs it again, and clears the record.

Installing, updating, switching off or removing a saved skill changes the skill catalogue, and with it the system prompt of the next request. This is expected and recorded as a refinement prefix change (`skill-catalog`).

## Workflows saved as skills

When the agent has run a staged `workflow` (stages of parallel members, each stage waiting for the one before) and every member of every stage finished, a review can keep that run as a skill. The next similar task then starts from the same stages with one sentence.

- **What is saved.** An ordinary workspace skill, installed and managed exactly like the other [saved skills](#saved-skills). Its text says when to use it, tells the model to run it with the `workflow` tool, and carries the run's definition: the run's name, and for each stage its name and the name and task of each member, as one `json` block. A skill is still only instructions: it starts nothing by itself.
- **Who writes the definition.** The host does, from the run's record in this session. The review proposes only the skill's name, title and when to use it. Any block of its own that it adds to the text is dropped, and the member tasks are never rewritten. The same run always gives the same text.
- **From what.** One run of this session that finished with every member completed. One finished run is enough; it is not kept back until it happens twice. A run that is not in this session, that is still running, or that has a member that failed, was cancelled or was interrupted, is not used: only that edit is dropped (`workflow-run-unavailable` or `workflow-run-not-completed`) and the rest of the review is kept.
- **Checks.** The names and tasks go through the same secret check as other saved text; one that looks like a credential refuses the save, and nothing is rewritten. The definition has to fit in one skill file (256 KiB); a larger one is refused as `workflow-definition-too-large`, never cut. The same stages are not saved twice, whatever the run was called and however the text is spaced: the second save is refused as `workflow-already-saved`.
- **Later changes.** The skill is a workspace skill like any other: a name taken by a person's skill, or a saved skill a person has changed, only gets a draft; it has a 30-day review; **Uninstall** and **Roll back** work as for other saved skills, and a skill you uninstalled is not brought back by the same stages under another name. Under **Saved skills** such a skill is marked as made from a workflow run; the line of its review in the conversation says the lesson is based on a finished workflow run.
- **Using it again.** The model sees the skill in its skill list like any other, reads it when the task fits, and calls `workflow` with the definition. A reused `workflow` obeys the same limits as any other: the child depth, how many members run at once, the budget of the whole tree, and approvals, which come to you. Saving a run changes none of them, and the `workflow` tool itself is unchanged.
- **Known limit.** `workflow` does not merge the members' worktrees. If several members write the same file, they overwrite each other, and a saved skill does not change that. Give members different files, or make them read-only, when you write the task texts.

To keep a run, ask for a review after it finished (`/refine --workspace`, or let the model call `harness_refine`); in automatic mode a review after compaction may also pick it up.

## Save to user memory

Some lessons hold in every workspace: a preference you stated yourself, such as "answer in short sentences". Such a lesson can go to **user memory** (`$AGH_HOME/memory/user/MEMORY.md`), which every workspace may read, instead of one workspace's memory. This happens **automatically, without asking**, like an assistant's own memory, once all of these hold:

- A review suggested it for every workspace. The review model only suggests this (`"reach": "user"`); AGH keeps the suggestion only for a **memory** or **prompt** entry held for the session and citing a **request of your own**, from a review the model did not start (yours, after a compaction or after repeated failures), and not one you asked to save to the workspace. Evidence from tool output alone never makes a lesson reach every workspace.
- Its text names no workspace: no absolute path (`/a/b`, `~/…`, `C:\…`), and neither the workspace's path nor its folder name. A lesson that does is saved to its workspace instead, as an automatic save. This check is about structure only; it does not judge what the lesson means.
- The review that wrote it applied it, in **Manual and automatic** mode. It does not wait for a second confirmation.
- It passes the same checks as a save to the workspace (session level, evidence from this session, no secret-like text), and you have not taken the same content back, from user memory or from this workspace.
- It fits: user memory holds about **512 bytes** (the agent is shown at most `userTokenBudget`, 512 by default, counted as UTF-8 bytes). Your own text comes first; the lesson is written only if your text, the lessons already in force and the new one fit together. Otherwise it is not written (`user-memory-budget`) and nothing is trimmed, merged or removed.

**Saving it yourself.** `/refine --user [focus]` (TUI or Web message box) and **Save … to user memory** on a review line in the Web conversation save a lesson to user memory as your own save. They skip the second confirmation and the suggestion from the review; the other checks above still apply: the text must name no workspace (if it does, it is saved to the workspace instead, and the line says so), it must fit the user memory budget, pass the same checks as a save to the workspace, and not be something you took back from user memory or from this workspace (a withdrawn lesson is not saved again, even by you). Only **memory** and **prompt** entries can go to user memory. The line in the conversation says it was saved to user memory at your request, and whether this workspace reads user memory.

**The model.** The model can ask for it too, with `target: 'user'` on `harness_refine` or `harness_propose`, only in **Manual and automatic** mode (as for `target: 'workspace'`). It is saved as the model's save, with the same checks and without waiting for a second confirmation. A **memory** or **prompt** lesson held for the session goes to user memory only if it cites at least one request of your own or one finished tool result; otherwise it is saved to the workspace at most. It should use this only for lasting facts or preferences that apply in every workspace of yours.

**Who reads it.** User memory reaches the agent only in workspaces whose memory is on and that turn user memory on (`userEnabled`). A lesson is still written when the workspace it came from does not read user memory: other workspaces that do will see it. The save line says so. Task experience never turns these settings on for you.

**What the agent sees.** Your own text first, then the lessons in force, without their marker lines. Each lesson has a **30-day** review date, like a workspace paragraph; past it the agent no longer sees it until you renew it, and the note counts what was left out.

**Taking it back.** On the memory page (**Memory files**), **Task experience in user memory** lists each lesson with its review date. **Renew** starts a new 30-day period; **Withdraw** removes it from user memory and records that you took it back, so the same content is not written again. Deleting it in the file by hand, or taking off or damaging its marker lines, counts as taking it back too. A lesson a person edited in place is never overwritten by a later version.

**Turning it off** stops promotions at once, also one under way: the switch is checked again right before the file is written.

## How entries reach the model

Entries never change the system prompt. They reach the model as notes added to the conversation:

- At the start of a session, and after a compaction, a **snapshot**: a fixed short guidance text, then the entries. Prompt and memory entries are given in full, at most the 3 most relevant of each kind. Skill and subagent entries are given as one line of metadata each, only the 3 most relevant of each kind. For every kind the note says how many more are saved.
- After a review is applied, an **update** with the entries it added or changed.
- Withdrawals, deletions and expiries are announced first, before any new entry text.

The entry text is marked as untrusted data, not as instructions, and ranks below system rules, project rules and your latest instructions. The model reads the rest with the `harness_inspect` tool: search (up to 10 results), list (20 per page) or read one entry (up to 2,000 characters). To change a saved entry directly, the model must first read it in full.

When the switch is on, the guidance text is added even before the session has any entry.

### The model's tools

With the switch on, the model has three tools:

- `harness_refine` asks for a review (works in manual mode too; with `target` it needs automatic mode). With `target: 'workspace'` or `'user'` its result is also saved to the workspace or to user memory.
- `harness_propose` saves a change directly, without a review call. It can create an entry, or change or delete one it has read in full; `target` works as for `harness_refine`.
- `harness_inspect` reads the saved entries, as above.

## Withdraw a review

In the Web conversation, each review has a line that shows what started it, how it ended and the names of the entries it saved or removed (never their text). An applied review has a **Withdraw** action:

- The entries go back to how they were before that review. The model is told in its next request that they were withdrawn.
- If an entry changed after that review, nothing is withdrawn and the line says which entries changed. Resolve it by hand.
- Withdrawing works while task experience is off, and at any time, also during a turn.
- The line then shows "Withdrawn since".

The TUI shows the same lines as text but has no withdraw action. A client can call `_agnes/v1/session.refine.rollback` ([API and schemas](../reference/api.md)).

## Cost

- Each review is a model call billed to your account, from a token budget of its own: 524,288 tokens for all reviews of a session. It never draws on a turn's budget.
- A model priced at zero (a free or local model) has a known price: reviews run on it, automatic ones included, cost nothing and are bounded by the token budget alone.
- A model with no known price runs no automatic review. A review you ask for runs on it only once you agree to the unknown cost with `/refine --unpriced`; the token budget still bounds it, and its cost shows as unknown.
- In the TUI, the footer, `/status` and the `/usage` figures leave review spend out, and `/usage` lists it on its own **RSI cost** line (a free model shows a zero cost, a model with no known price shows "price unknown").
- The Web counts review spend in the session's usage totals.
- The guidance and entry notes add tokens to every request of a session where task experience is on.

## Turn it off

Turning the switch off stops new reviews, stops applying results that are waiting, and stops sending entries, at once, in every session. The model gets one note that task experience is switched off. The three tools stay listed in the sessions that are open, but answer that it is off. Saved entries stay in the session's record and are sent again once it is on again. Turning it back on works at once in a session that was opened while it was on; other sessions get it when they are opened after that. Withdrawing still works while it is off.

Nothing is saved to the workspace or to user memory while it is off, and requests waiting for approval are withdrawn. Paragraphs saved earlier stay in the workspace memory and user memory and keep their review dates. You can still renew, withdraw or convert them on the memory page. Saved skills stay installed; no skill is installed, updated or reviewed while it is off, and you can still uninstall or roll one back.

## Compared with Prime Agent

- Prime Agent keeps session entries and global entries for every session (`/refine --global`). AGH keeps entries in the session and saves them to the current workspace only: memory and prompt entries as paragraphs of the workspace memory, skill entries as workspace skills, each with a 30-day review date, on your request (`/refine --workspace`, per entry) or the model's, and automatically when a review applies a lesson in **Manual and automatic** mode.
- Prime Agent's global library is written on your request (`/refine --global`) or by the model. AGH writes a lesson to user memory (read in every workspace that turns it on) on your request (`/refine --user`, or **Save … to user memory**), on the model's (`target: 'user'`), or automatically when a review applies a lesson from your own words that holds in every workspace; it always stays within about 512 bytes and has a 30-day review date.
- Prime Agent's self-written skills can be Python functions run in its own kernel. AGH's saved skills are instructions only; the agent writes and runs any script itself, under its usual permissions.
- Prime Agent applies a review edit by edit, and so does AGH: an edit that breaks a rule is left out and the others are applied.
- Prime Agent starts automatic reviews only after a compaction, with a 20-minute cooldown. AGH also starts them after repeated failures and on the model's request, within the limits above (the model's own requests have only a high cap).
- AGH delivers entries as untrusted data, and the feature is off until you turn on the switch of your profile.

## Known limits

- Forks are child sessions. A fork, a rewind and a subagent get no reviews and no entry notes, and cannot withdraw.
- Entries are kept per session. A new session starts with no entries; what was saved to the workspace reaches it through the workspace memory.
- A saved skill is updated by name: a skill entry of the same name from any session updates it (automatically, when a review applies it).
- An entry bound to an approved skill or role, once delivered, keeps its line in the entry note until the next snapshot (a new session or a compaction), even if the skill is switched off meanwhile; `skill_read` and `subagent_spawn` check again when the model calls them.
- Saved skills are written to the workspace's `.agh/skills` folder through the same publishing step as other skill installs. While a skill is being published, a process that can rewrite `.agh` could swap the folder; `.agh` is a configuration path, and the agent's own writes there need your approval.
- Drafts and earlier versions of saved skills are kept in the profile's data directory, not in the workspace.
- A skill saved from a `workflow` run carries the stages as they were when the run finished. If your tools or files change later, the skill does not follow; edit or replace it. `workflow` does not merge the members' worktrees, so members that write the same file overwrite each other. See [Workflows saved as skills](#workflows-saved-as-skills).
- Whether a lesson holds in every workspace, and whether it names a workspace, is checked by structure only: it is a memory or prompt lesson held for the session, it cites a request of your own (for the automatic promotion; a finished tool result is enough for the model's own request), and its text has no path, workspace path or folder name. Page or file text and the model's own words alone never back a lesson. It does not judge what the lesson means. Review what reaches user memory on the memory page.
- Tool output and page or file text can influence what is saved: a review reads them as evidence, and a lesson can echo what they say, even though they are marked as untrusted data and credentials are masked. Nothing is saved without a section you can see and take back: withdraw a lesson on the memory page (a paragraph in the workspace memory or a section in user memory), and the same content is not saved again.
- A lesson in user memory past its review date stays in the file, hidden from the agent, until you withdraw or delete it; nothing removes it for you. Its records sit next to the file (`$AGH_HOME/memory/user/refinement.json`), shared by every profile of the installation.
- The checks on a save are about structure: the source, the length, secret-like text, the size of memory. They do not judge whether a lesson is right. Review what is saved on the memory page.
- On a platform without a system sandbox (for example Windows, or a container without bubblewrap under full access), the agent's shell can read and change the memory files directly, including paragraphs it is not shown. A shell that takes the two marker lines off a paragraph turns it into ordinary memory at the next session open. See [Learned memory](memory.md#approval-and-privacy).
- A terminal started with `--standalone` runs its own embedded host, which does not serve `/refine`: it answers that the command is not supported. Automatic reviews still run there.
- On a planning model with no known price, automatic reviews do not start, and a review you ask for needs `/refine --unpriced`. A model priced at zero counts as known. A model added in the model settings without a price is recorded with a zero price, so it counts as free.
- Turns that carry an entry note may ask you to approve more commands. The note is untrusted content, so approval rules that would allow a command in a clean turn may not apply. The same is true for turns that read entries with `harness_inspect`.
- Obvious credentials in tool output are masked before the review model sees it. The masking is not complete.

## Diagnostics and exports

Diagnostics bundles, diagnostic event exports and session exports contain the conversation as it was written, including the entry notes the model received and the text of the experience tools. Review them before you share them. The save lines and the workspace's save records hold no entry text, but the conversation around them does. A saved skill's text is in its `SKILL.md` in the workspace, like any other skill.
