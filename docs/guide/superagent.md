# Superagent deployment

English | [简体中文](superagent.zh-CN.md)

[Documentation](../README.md) · [Plugins](packages.md) · [Security](security.md) · [Network deployment](deployment.md)

Superagent is an optional plugin that ships with AGH. It watches one GitHub repository (and, optionally, Feishu chats
through an AGH Feishu channel instance), turns requests from allowed people into tickets, and gives each ticket its own
session. That session works in the ticket's directory, pushes its own branch and opens a pull request; the main session
answers people. Superagent is not installed or enabled by default; until you enable it, nothing changes.

This page covers running it as a long-lived service: the accounts and the separate AGH home, a launchd or systemd unit,
enabling, disabling, clearing its data, and what its sessions can and cannot reach. The step-by-step setup that a coding
agent walks through with you, including the settings and the panel, is in the plugin's
[setup guide](../../packages/superagent/docs/setup.md).

## Before you start

- **A dedicated operating-system user (strongly recommended).** Every ticket session runs with full access as the user
  that runs the daemon. Only a separate user, with none of your own files, keys or signed-in tools, limits what a mistaken
  or manipulated session can reach. See [Security boundaries](#security-boundaries).
- **A dedicated GitHub account** for the agent, with write access to the one repository, and **branch protection** on the
  default branch: a pull request with an approving review, no force pushes, no deletions. The agent never merges unless
  you turn on auto-merge in its prompts.
- **A separate AGH home** for Superagent, apart from the home you work in, with a model provider configured. Superagent
  restarts with its own daemon without closing your sessions.
- git 2.32 or later and GitHub CLI 2.48 or later on the machine.

## Paths

The examples use these paths; any absolute paths work. Paths under a personal home directory are best avoided for a
service account.

| Path | Holds |
| --- | --- |
| `/srv/superagent/agh` | `AGH_HOME`: the daemon's home, its model configuration, sessions and the Superagent skills it lists |
| `/srv/superagent/state` | Superagent's state directory (the plugin setting `stateDir`): `superagent.sqlite`, the ticket directories in `work/` |
| `/srv/superagent/state/home` | The agent's `HOME`: its `.gitconfig`, written by Superagent on every start |
| `/srv/superagent/state/home/.config/gh` | The agent's GitHub CLI login |
| `/srv/superagent/state/worker-bin` | Shims: `gh` runs the agent's GitHub CLI; blocked commands fail |

Without a `stateDir` setting Superagent uses a directory under the AGH data directory, `bundled-apps/<hash>`, which the
panel's **Deployment** page names. Setting it explicitly before the service starts keeps the unit files below fixed.

## Install and enable

1. As the service user, with `AGH_HOME=/srv/superagent/agh`, start the daemon once (`agh serve`) and configure a model
   provider as in [Install](install.md).
2. Open **Plugins → Marketplace**, install **Superagent**, review what it asks for (model and session access, running
   commands on this machine), and enable it ([Plugins](packages.md)).
3. On the plugin's settings page set `stateDir` to `/srv/superagent/state`. Superagent then reports a setup problem
   because the agent's environment is not in place yet; that is expected.
4. Sign the agent account in, with its own configuration directory, never yours:

   ```sh
   GH_CONFIG_DIR=/srv/superagent/state/home/.config/gh gh auth login
   GH_CONFIG_DIR=/srv/superagent/state/home/.config/gh gh api user --jq .login
   ```

   The second command must print the agent's login.
5. Stop that daemon and run it as a service with the agent's identity, as below.

## Run as a service

The daemon must start with `HOME` set to the agent home and the shims first on `PATH`; the sessions it runs inherit
both, so their commits, pushes and `gh` calls act as the agent account even when the operator is signed in on the same
machine. Superagent checks this when it starts and reports `agentHomeMismatch` or `agentGhNotShim` otherwise. Write the
three variables out in full: a service manager does not expand `~` or read your shell profile, and `PATH` must still
reach `node`, `git` and the real `gh`.

### macOS (launchd)

`/Library/LaunchDaemons/dev.agnes.superagent.plist`, loaded with `sudo launchctl bootstrap system <file>`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.agnes.superagent</string>
  <key>UserName</key><string>superagent</string>
  <key>ProgramArguments</key>
  <array><string>/opt/homebrew/bin/agh</string><string>serve</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>/srv/superagent/state/home</string>
    <key>PATH</key><string>/srv/superagent/state/worker-bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>AGH_HOME</key><string>/srv/superagent/agh</string>
  </dict>
  <key>WorkingDirectory</key><string>/srv/superagent</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ExitTimeOut</key><integer>60</integer>
  <key>StandardErrorPath</key><string>/srv/superagent/agh.log</string>
</dict>
</plist>
```

### Linux (systemd)

`/etc/systemd/system/superagent.service`, started with `systemctl enable --now superagent`:

```ini
[Unit]
Description=AGH with Superagent
After=network-online.target
Wants=network-online.target

[Service]
User=superagent
WorkingDirectory=/srv/superagent
Environment=HOME=/srv/superagent/state/home
Environment=PATH=/srv/superagent/state/worker-bin:/usr/local/bin:/usr/bin:/bin
Environment=AGH_HOME=/srv/superagent/agh
ExecStart=/usr/local/bin/agh serve
Restart=on-failure
KillMode=mixed
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

Stop the service through its manager (`launchctl bootout`, `systemctl stop`): the daemon then ends its sessions' turns
cleanly. A restart is safe at any time: see [Restart and recovery](#restart-and-recovery).

## Settings and first use

Open the **Superagent** entry on the AGH home page and save, in order, the Sources (repository and the agent's GitHub
CLI; the Feishu channel instance if used), the Policy (who may ask), the Execution settings (the ticket directory root and
the prepare command, for example `git clone "https://github.com/<owner>/<name>.git" repo`) and the team prompt sections.
The [setup guide](../../packages/superagent/docs/setup.md) explains each field. Then, from an allowed account, comment
`@<agent login> <request>` on an Issue: a ticket appears on the overview within about a minute.

## Disable

Disable the plugin under **Plugins**, or use **Pause processing** in the panel to stop new work while it keeps running.
Disabling stops polling and sending, cancels every running turn of Superagent's sessions, kills their background jobs
within a few seconds, and records the running assignments as paused. Sessions, ticket directories and the state
directory stay. Enabling again reads each session's real state: work still running is left alone, an interrupted
assignment is dispatched again with a recovery note, and a message that waited in a session's queue runs once.

## Clear data

Only the owner clears data, explicitly; disabling never does. To remove everything:

1. Disable the plugin, then uninstall it under **Plugins**.
2. Delete the state directory (`/srv/superagent/state`, or the `bundled-apps/<hash>` directory the panel named). This
   removes the database, every ticket directory with any branch that was not pushed, and the agent's GitHub login.
3. Delete the sessions you no longer want: the main session `superagent:orchestrator` and the ticket sessions
   `superagent:worker:<ticket id>`.
4. Delete the skills Superagent wrote into the AGH home: the `dsh-superagent-*` directories under `<AGH_HOME>/skills`.

The pushed branches and the pull requests stay on GitHub; remove them there.

## Security boundaries

Superagent keeps the boundaries of its origin: the allowed lists and each ticket's mandate (policy version, scope,
strength), a dedicated GitHub account and Feishu bot, branch protection that requires a person's approval, and an AGH
home of its own. Prompts are not a boundary, and text from GitHub or Feishu is material only: it cannot change a ticket's
directory, its bundle or its permissions.

**The main session can change the settings.** As in the original, the main session has a tool,
`orchestrator_settings_save`, that saves a settings block when a person asks for it in a conversation: the Policy (the
allowed lists and rules), the Eval settings, the Execution settings including the prepare command, a Source, or the
pause. Whether such a request is genuine is the model's judgement, not a check in code. A main session misled by text in
an Issue or a chat, or asked by an allowed person, could therefore add someone to an allowed list, or change the prepare
command, which Superagent then runs for each new ticket. The allowed lists keep out people who are not on them; they do
not hold against an allowed person or against text the main session reads. What limits this:

- Every save keeps a version. The history on the panel's Eval, Execution and Source pages marks each save the main
  session made as **Main Session tool**; review those saves, and correct them in the panel.
- Keep the allowed lists short, and run Superagent as a dedicated operating-system user (below), so a changed prepare
  command reaches only the agent's own account.

Ticket sessions run with full access. That means:

- They can read the operator's home by absolute path, including the keys and the socket of the operator's everyday AGH
  home. The separate `HOME` changes the identity, not what a session can reach; the protected `~/.ssh` is the agent
  home's, and the operator's real `~/.ssh` is not on the protected list.
- In Superagent's AGH home, full access lifts the soft bans on the data directory: `tables`, `audit` and `sessions.db`
  can be read and written. Only `secrets` and the private state root under the data directory stay forbidden.
  Superagent's own SQLite database can be read and written by its sessions.
- Under the same system user, a session can very likely connect to the daemon's local socket on its own and act with
  the owner's rights: local authentication checks only who owns the socket. Not handing the owner-level client to
  sessions is therefore not a boundary.

All of these are addressed only by running this AGH as a dedicated operating-system user, which is strongly recommended
and not enforced.

## Restart and recovery

- **Daemon restart.** Running turns end as aborted and their jobs stop with the daemon. On start Superagent writes and
  checks the agent environment, then reconciles each of its sessions by its real state: a turn still running is left
  alone; an interrupted assignment is dispatched again once with a recovery note; the oldest message waiting in a
  session's queue is started, since nothing resumes it after a restart.
- **Stored work.** Every outward action (a reply, a launch, a delivery) is stored before it runs and removed only once it
  succeeded, and retried with backoff. While processing is paused, Sources keep recording.
- **A delivery whose outcome is unknown** is looked up by its command id; when that cannot be confirmed it is recorded as
  undelivered for a person, and never sent again or under another id.
- **A ticket session the owner archived** fails its assignment for a person to decide; no other session is opened behind
  your back. **One the owner deleted** is opened again under the same key and given its whole assignment again; if that
  fails, the assignment fails with the reason.
- **Model and GitHub failures.** A turn that fails for a rate limit or a server error is resumed after 15, 30 and 60
  seconds; a fourth failure in a row fails the assignment for a person. A GitHub read that times out or fails is read
  again on the next poll. A prepare command that fails fails the ticket and is not run again.

## Troubleshooting

The panel's overview shows setup problems with a link to the setting that fixes them; **Check again** runs the checks
again after you fixed something outside the panel.

| Problem | Fix |
| --- | --- |
| `The daemon runs with HOME …, not the agent home …` | Start the daemon with `HOME` set to `<stateDir>/home` (the unit's `HOME`) |
| `Sessions run gh from …, not the shim in …` | Put `<stateDir>/worker-bin` first on the unit's `PATH` |
| `git would ask other credential helpers than the agent's for github.com` | Remove the named helpers from the system git configuration, or run as a user without them |
| `gh acts as @…, not the agent account @…` | Sign in again with the agent's `GH_CONFIG_DIR`, as in step 4 |
| `The agent GitHub CLI was not found.` | Make `gh` reachable on the unit's `PATH`, or set an absolute path on the GitHub Source |
| A file `… was not written by Superagent` | Move it out of `<stateDir>/worker-bin` or `<stateDir>/home`, or choose another state directory |
| `A session superagent:… exists that Superagent did not open` | Archive or remove that session, which is not Superagent's, then select **Check again** |
| A ticket fails with the prepare command's output | Fix the command in Execution, then retry the ticket |
| The `deliveries` health names a ticket | A relaunch keeps waiting to confirm whether a session got a message; check that the daemon answers, then retry the ticket |
| Nothing happens after a mention | Check that the author is on the allowed list, the Source is on and processing is not paused |
