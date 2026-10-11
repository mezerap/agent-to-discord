# Agent to Discord

Control your Codex agent through Discord. A standalone Node.js bridge with a continuous main chat, independent threads, reply routing, archive browsing, and persistent scheduled tasks. Conversation mappings survive restarts.

Inspired by [Agent2Telegram](https://github.com/petrludwig-collab/Agent2Telegram). This is an independent implementation for Discord using the [Codex app-server](https://developers.openai.com/codex/app-server/), without tmux or terminal screen parsing.

## Features

- The main channel keeps one continuous Codex conversation and receives replies directly.
- Each Discord thread has its own conversation; a thread created from a tracked message forks history through that message’s completed turn when created (or on its first user request if the creation event was missed).
- Discord replies include the referenced text; replies to automation results continue the automation’s own conversation.
- `/new` starts fresh and archives the old conversation for 90 days. `/archive` privately lists, displays, restores or deletes tracked histories.
- Natural-language scheduling with persistent one-time, interval and cron schedules. Results and questions return to their configured channel or thread; `/automations` lists, pauses and redirects schedules.
- Agent messages and final status, with long responses split to fit Discord's message limit.
- Slash commands `/help`, `/new`, `/archive`, `/automations`, `/status`, `/stop`, `/file`, and `/answer` in Discord's command menu. The bot's command descriptions and user-facing messages are currently in Czech.
- A native typing indicator during work instead of separate “Working…” and “Done” messages.
- Buttons to approve or reject a specific command or set of file changes, with full details in a JSON attachment. Requests are rejected after 10 minutes without a response.
- Answers to structured questions through `/answer` or `!answer`, using plain text for one question or the provided JSON template for multiple questions.
- Incoming files and images, saved under `discord-uploads/` in the workspace. The bridge imposes no attachment count or file size limit; Discord's own limits still apply to uploads and downloads.
- Agent-sent file attachments on request, including reports from scheduled tasks. Manual downloads remain available through `/file` or `!file path`.
- One authorized user, server, and channel. Automatic user and role mentions are disabled.
- Persistent conversation mapping, duplicate message protection, and connection diagnostics.
- Deleting a Discord thread interrupts the running task, rejects pending approvals, and archives the Codex conversation. Tracked archives are permanently deleted after 90 days; files in the workspace are preserved.

Version 0.2 is intended for a personal agent. Voice, multiple users, and connections to arbitrary existing terminals are not implemented. Each destination runs at most one task at a time: incoming requests are rejected while busy, and scheduled tasks wait until that destination is idle. Different destinations can work concurrently in the same workspace. It does not allow general permission expansion requests or MCP forms. If the command or file changes cannot be displayed, the approval button remains disabled.

## Requirements

- Node.js 22.12+ and `ps` (the `procps` package on Debian).
- Codex CLI installed and signed in. The integration has been verified with version **0.162.1**; the app-server interface may change between versions.
- A Discord bot with **Message Content Intent** enabled under Developer Portal → Bot.
- The bot added to your server with **View Channel, Send Messages, Create Public Threads, Send Messages in Threads, Read Message History, Attach Files** permissions in the designated text channel. Administrator permission is not required.
- Outbound HTTPS/WebSocket connections to Discord and OpenAI. No inbound port or public webhook is needed.

## Installation

The package can be installed directly from GitHub without being published to the npm registry:

```sh
npm install --global git+https://github.com/mezerap/agent-to-discord.git#v0.5.1
agent-to-discord setup
agent-to-discord doctor
agent-to-discord start
```

`start` runs in the foreground; use Docker or a service manager for continuous operation. If you cannot write to the global npm directory, use a custom prefix—see the Docker instructions below.

Alternatively, clone the source repository:

```sh
git clone https://github.com/mezerap/agent-to-discord.git
cd agent-to-discord
npm ci --ignore-scripts
node src/cli.js setup
```

The setup wizard asks for the channel, user, workspace, and bot token. Token input is hidden. It verifies channel access, detects the server, and creates `$CODEX_HOME/agent-to-discord/.env` with private file permissions. If `CODEX_HOME` is not set, it uses `~/.codex/agent-to-discord/.env`. It does not overwrite an existing file. Do not send the token in chat or include it in your command history. To find Discord IDs, enable Developer Mode and use Copy ID.

```sh
node src/cli.js doctor
node src/cli.js start
```

`doctor` checks your Codex login, Discord connection, and channel permissions. It does not send messages. To verify that text messages are actually received, send a message to the channel as the authorized user. To make the command available globally from a cloned repository, run `npm install -g .`, then `agent-to-discord start --env-file /path/.env`.

Configuration in `.env.example`:

| Variable | Description |
| --- | --- |
| `DISCORD_TOKEN` | Secret bot token |
| `DISCORD_GUILD_ID` | Authorized Discord server |
| `DISCORD_CHANNEL_ID` | Parent text channel |
| `DISCORD_USER_ID` | The only user allowed to control the agent |
| `AGENT_WORKSPACE` | Workspace directory; defaults to the current directory |
| `AGENT_STATE_DIR` | Persistent bridge state; defaults to `$CODEX_HOME/agent-to-discord` |
| `CODEX_BIN` | Optional CLI path; defaults to `codex` |
| `CODEX_MODEL` | Optional model; otherwise uses the Codex configuration |

## Usage

Send a message such as “Create a simple HTML page” in the authorized channel. The bot answers there and retains context for subsequent messages. Create a Discord thread for a separate topic. A newly created thread owned by the authorized user and rooted at a tracked message forks that conversation through the associated completed turn, excluding later turns. If the creation event was missed, this happens on the first authorized message. A plain thread starts fresh. If the source was archived by `/new`, only the starter message text is quoted; its archived history is not reopened. Wait for the source turn to finish before branching. A Codex turn may contain multiple agent messages, so the branch boundary is the entire completed turn, not an individual sentence.

Discord **Reply** quotes the selected message. In ordinary chats it stays in the current conversation; a reply to an automation’s mapped output routes to that automation instead. References cannot route to another Discord destination. Replies to old messages after `/new` quote text without resuming archived history. Messages predating this version have no stored turn mapping and are quoted as text. Conversation histories are separate; workspace files are shared.

The main chat **warns instead of automatically archiving** when the latest reported model input reaches 100,000 tokens, or the next message arrives after 24 idle hours. You can continue normally. Token warnings normally appear at most once per day per conversation. **Remind me later (+10,000)** postpones the next warning until the latest input grows by another 10,000 tokens from the value at the click (at least 110,000). Reaching that threshold triggers a reminder even on the same day; elapsed time alone does not end the postponement. If context shrinks, the saved threshold remains unchanged. This setting survives restarts, and `/status` reopens the button. No archive happens automatically; inactivity notices are also limited to once per day. `/status` shows the latest input, approximate context-window percentage (when reported), and cumulative usage separately. Input includes instructions, history and tool results; cumulative usage is not the current context size. The report describes the last model call, not the next call. Monitoring does not make extra model calls. Threads and automation conversations show usage but do not get main-chat warnings. This replaces the automatic idle reset introduced in 0.3.2.

Ask naturally: “Archive this, but keep topics X and Y”, “Move topic X to a new thread”, or “Copy this topic into thread <ID>”. The agent prepares selected factual summaries and destinations using `discord_context`. It can search the current conversation's user/agent history for earlier topics. Missing or ambiguous details should be clarified, not invented. Before proposing a transfer, the agent reviews unfinished tasks, decisions, constraints, file paths and next steps for the selected topics. It explicitly lists known unfinished work left out of all summaries, or states that its review is incomplete when history is missing. A summary is a selective, potentially lossy handoff rather than a full-history fork; review decisions, paths and unresolved tasks carefully.

After the reply, the bot displays an inline overview of what stays here, goes to threads, or stays only in the archive, plus omitted unfinished work. The message includes the complete plan as a text attachment and **Confirm transfer / Cancel** buttons (in Czech). Nothing is archived, copied or created until you click confirmation. To revise a plan, explain the changes to the agent; a replacement invalidates old buttons. Expired buttons can be reopened with `/status`. Confirmation and `/new` are blocked while the source destination has active, uncertain, retiring or queued work, including automation runs. Retry explicitly once the work is resolved; a rejected request does not execute later by itself. Both operations preserve any pending automation context before archiving. Selected topics can be kept for the next conversation here, copied to new threads, or added as context for the next message in existing threads under the configured main channel. Existing target history is preserved. Bot messages alone never start a task in a target thread. An ordinary new Discord thread created from a message still uses the original full-history fork behavior; use the handoff plan for selected topics only.

Selected summaries are persisted before source archiving and injected as reference data into the destination's next ordinary user turn. Only the selected summaries carry forward, not the whole source history. Confirmation can either archive the source for 90 days or leave it open and only copy topics. Project files and schedules are preserved. `/new` remains an explicit request to archive and start completely clean, discarding any unconsumed summary and unconfirmed plan at that destination. Discord messages themselves remain.

The new tool is included in fresh conversations; existing conversations with `discord_automation` can use a compatibility operation described in the bridge's instructions, without `/new`. Scheduled invocations cannot prepare transfers. Transfer operations are journaled before external changes; after a crash or ambiguous Discord/Codex response, the bot does not blindly create duplicate threads or resend summaries. `/status` reports the partial transfer for operator inspection, and its source archive is excluded from automatic retention until resolved.

Type `/` and select a command from this bot. Commands are registered automatically for the configured Discord server at startup. Their results are visible only to you, including files requested through `/file`. The original `!` commands still work and reply publicly in the channel. Submit tasks as ordinary messages. Commands enforce the same user, server, and channel restrictions as messages.

| Slash command | Original syntax | Behavior |
| --- | --- | --- |
| `/new` | `!new` | Archive this channel/thread’s current ordinary chat for 90 days; the next message starts fresh |
| `/archive` | Slash only | Private paginated archive list, history download, restore to a new thread, confirmed permanent deletion |
| `/automations` | Slash only | List schedules belonging to this destination, inspect state, pause or enable |
| `/help` | `!help` | Help with tasks, threads, files, and commands |
| `/status` | `!status` | Retrieve the latest task's actual status and, when available, its latest response |
| `/stop` | `!stop` | Interrupt the running task and pause the message queue |
| `/queue` | `!queue` | Inspect queued messages, push one into the current task, remove it, or resume the queue |
| `/file cesta:web/index.html` | `!file web/index.html` | Send a specific file from the workspace |
| `/answer odpoved:yes` | `!answer yes` | Answer one pending question with plain text; for multiple questions, use JSON matching the provided template |

When multiple conversations share a destination (ordinary chat and automation conversations), `/status`, `/stop` and `/answer` offer a private selection menu. `/new` affects only the ordinary chat; it refuses active, uncertain or queued work until you finish/check the task and process or remove its queued messages. Other threads, schedules, Discord messages and workspace files remain.

### Messages while the agent is working

Send additional messages normally: each destination has a persistent FIFO queue. After the current task completes successfully, queued messages start separate turns in the same conversation, one at a time. Other channels/threads progress independently. Each acknowledgement offers **Zahrnout hned** (Push now), which uses Codex `turn/steer` to add that specific message to the current turn without stopping it, and **Odebrat z fronty** (Remove from queue). Steering can overtake earlier queued entries because you explicitly chose that message. The agent incorporates it at its next processing opportunity; it cannot undo actions already taken.

Use `/queue` for a private paginated list and fresh action buttons after the original ten-minute buttons expire or the bot restarts. You can inspect message text, remove pending items, and resume a paused queue. Removal preserves the original Discord message and downloaded files. `/stop`, a failed task, or an interrupted task pauses the queue; resume it explicitly through `/queue`. Deleting a Discord thread discards its pending queue. `/new` requires an empty queue, so pending messages cannot silently move into a new conversation. Queued user work takes precedence over scheduled runs in the same destination.

Queue entries store text, quoted context and saved attachment paths in the private bridge state. Attachments download when queued, so expired Discord URLs do not break later delivery; the files remain editable in the shared workspace. Editing/deleting the original Discord message does not edit/cancel its saved queue entry—use `/queue`. Routing is captured when queued: replies to an automation's output keep that automation context. Push now never redirects a normal chat message into an unrelated running automation. Explicit agent questions and approval requests still use `/answer` or their approval buttons.

Undelivered ready entries survive restart. A turn that was active during a restart requires `/status` before dependent queued work continues. If preparation or delivery cannot be confirmed, the entry needs inspection in `/queue` and is not automatically replayed. This prevents blind duplicate execution; it is not an exactly-once guarantee. Check `/status` before removing such an entry and submitting a replacement. An explicit `turn/steer` rejection leaves the message queued for a later turn. See [Codex active-turn steering](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn).

Ask “Send the report as an attachment”, or include “attach the generated report” in an automation task. From version 0.5.0 the agent can call `discord_file` with an existing workspace file path and an optional caption. Relative paths and absolute paths inside the workspace are accepted. One call sends one file; multiple files use separate calls. It supports Markdown reports and other regular files without an extension allowlist. The attachment appears in the current chat/thread, or the automation's configured destination, and is visible to people with access there. Replying to a scheduled report continues that automation's conversation. `/file` still returns a private attachment; `!file` replies publicly.

Fresh conversations receive the native tool. Existing conversations and automation contexts with `discord_automation` use a compatibility operation. A short capability notice is included with each turn, including scheduled runs, because resuming older Codex histories does not reliably refresh developer instructions. This works without `/new` or schedule recreation. The tool cannot choose another destination and retains the workspace, hidden-file and authentication-file export checks. Discord's Attach Files permission and upload limits still apply. A local Markdown link alone does not upload anything. Existing schedule prompts are not rewritten by an upgrade; ask the agent to update a task if it does not already request an attached report.

Uploads are journaled before sending. Repeated calls for the same file name and contents within one turn do not send it again, including retries with a different tool call ID. After an unconfirmed Discord response or crash, the bridge does not automatically repeat the upload; the agent asks you to check Discord before explicitly requesting it again. This is duplicate prevention, not an exactly-once guarantee. Separate scheduled runs can send the same report again. Outgoing files are read into memory, so available container memory also bounds practical sizes.

Starting with version 0.1.4, the former bridge limits of 5 attachments and 8 MiB per file are removed, including the size cap on `/file` and `!file` exports. Incoming attachments are streamed to disk. Actual transfers remain subject to Discord limits, available server resources, and network timeouts. File path and access checks are unchanged.

The slash option names `cesta` (path) and `odpoved` (answer) match the bot's registered commands; enter them as shown.

The typing indicator refreshes every 8 seconds. It pauses while waiting for approval or an answer and resumes after your response. Once work finishes, it stops refreshing and the agent's response remains. Discord has no separate command to turn the indicator off, so it may linger briefly, for approximately 10 seconds after the last signal at most. Errors and interrupted tasks are still reported as messages.

If commands do not appear in the menu, reopen Discord and check the **Use Application Commands** permission for your account in that channel. The bot must be installed with the `applications.commands` scope, which Discord normally includes automatically with the `bot` scope.

After a restart, an unfinished task **is not started again**. Use `!status` to check its state and decide whether to submit more work. Messages sent while the bot is completely offline are not retrieved later. If Discord fails to deliver a response, `!status` retrieves it from Codex history. Exactly-once delivery of network operations cannot be guaranteed; the bot never automatically retries a task when its outcome is uncertain.

### Scheduled tasks

Ask naturally, for example: “Every weekday at 9:00 Prague time, check the project and report the result here.” Codex calls the bridge's `discord_automation` tool to save the schedule. The saved prompt must include the task's details. Creation is reported only after persistence succeeds. The job receives an independent fork of the originating conversation after the scheduling turn finishes.

Supported schedules are one-time ISO dates with an explicit offset, intervals in whole minutes, and five-field cron expressions with an IANA time zone (default `Europe/Prague`). The scheduler runs inside the bridge every 15 seconds; the bot/container must be running. A job submitted in the main channel delivers there; one submitted in a thread delivers in that thread. On your explicit request, an existing job can change its destination within the configured main channel and its threads. Results and clarification/approval requests use the same destination.

`/automations` lists the destination's schedules, shows their current/pending destination, and lets you pause, enable or move them to the main chat. You can also ask the agent to list, update, pause or resume a schedule. `/stop` interrupts an invocation; it does not disable future scheduled runs. A failed or uncertain invocation pauses automatic execution for review (`attention`); check `/status`, then enable the schedule when ready. Scheduled invocations cannot create or modify schedules themselves. Existing approvals and sandbox restrictions still apply to scheduled work.

To redirect an existing job, ask in its **current destination**, for example: “From now on, send this automation’s results to the main chat.” For the opposite direction, provide the target thread’s ID or mention. Specify which job if there are several. Its Codex conversation, saved prompt, schedule and next occurrence stay intact; past Discord messages stay where they were. Replies to new results continue the same automation context. Other channels/servers, locked/archived threads and destinations the bot cannot read/write are rejected.

A running task finishes at its original destination. A pending move waits for context preparation and the original destination’s queue to clear, then applies on a scheduler tick (every 15 seconds), including for paused jobs. Check `/automations` before deleting the old thread: **deleting it before the move completes still stops the job**. After the move, deleting the old thread does not affect the automation; deleting its new destination stops it. An inaccessible pending target holds further scheduled runs and displays an error; request the target again after fixing access, or ask to keep delivery “here” to cancel the pending move. Uncertain runs require `/status` first. Existing conversations with the scheduling tool support destination changes without `/new` through a compatibility operation supplied in the bridge instructions.

After downtime, multiple missed occurrences are coalesced into at most one catch-up execution per job. The next occurrence is advanced and saved before execution. A crash or unknown response is never automatically replayed; exactly-once external side effects are not guaranteed. A job waits while its destination has active or uncertain work. `/new` does not stop schedules. Deleting their destination stops them permanently; restoring history does not restart schedules.

The bridge uses experimental app-server dynamic tools. Conversations created before 0.2 remain usable but may not have the scheduling tool; use `/new` to start a conversation with it. Pending forks/restores with an unknown network outcome are preserved for inspection rather than blindly repeated. If `/automations` or `/archive` reports such a pending operation, inspect the saved state and Codex/Discord before repairing it; do not delete state or create duplicate jobs as a workaround.

### Archive browser

`/archive` is a private paginated list of histories tracked by this bridge. Each entry shows its title, origin, archive date, and planned deletion date. **Show history** downloads user and agent messages as text without resuming the conversation. **Restore** unarchives it into a new public Discord thread under the configured channel and cancels retention; the main chat is unaffected. **Permanently delete** requires a separate confirmation. Menus expire after ten minutes or a bot restart.

A deleted history cannot be restored. Restoration does not restart deleted schedules. Archive creation/deletion/restoration and retention are serialized for each conversation. Incomplete restores are protected from automatic history deletion until resolved.

### Deleting a thread

When a Discord thread is deleted, the bot disables all its schedules, blocks further requests and approvals, asks Codex to stop its active task, and archives every conversation mapped to that destination once the stop is confirmed. It removes the Discord mapping only after successful archival. Generated files are preserved, and changes already made are not rolled back.

Threads deleted while the bot was offline are checked at startup and on reconnection. This check also runs every 5 minutes. Archiving or automatically closing a Discord thread does not count as deletion and preserves the conversation. Network failures and revoked permissions are not treated as deletion. If cleanup fails, it remains saved as pending, and the bot retries every 10 seconds, including after a restart.

### Automatic history cleanup after 90 days

Conversation history archived by **`/new` or deletion of a Discord thread is permanently deleted after 90 days**. For `/new`, the clock starts at archival; for deleted threads, it starts when the bot detects deletion. If the bot was offline, the period starts only after it starts up and confirms the deletion. Merely closing or archiving a Discord thread does not start this period.

The timestamp is stored in the bridge's persistent state and survives restarts. Cleanup runs at startup and every hour. It uses the Codex `thread/delete` API rather than manually deleting internal files. It deletes only tracked conversations that are still archived and not running; failures are retried at the next check. If the bridge detects that a conversation has been restored in Codex, it cancels automatic deletion for that conversation.

**Permanent history deletion cannot be undone.** This cleanup does not delete projects, attachments saved in the workspace, login credentials, configuration, or other conversations. It does not impose a total disk usage limit or delete backups or all operational logs. The terminal command `agent-to-discord status` shows the number of archives awaiting deletion.

Archives created before version 0.1.3 are not automatically adopted: the bridge no longer has a reliable mapping to the deleted Discord thread or its deletion timestamp. Retain `state.json` for this cleanup to work; if it is lost, the bot does not guess which archives to delete based on age.

## Docker and persistent data

In an existing container, you can install the package into a volume as the `node` user:

```sh
npm install --global --prefix /home/node/.codex git+https://github.com/mezerap/agent-to-discord.git#v0.5.1
/home/node/.codex/bin/agent-to-discord setup
/home/node/.codex/bin/agent-to-discord doctor
/home/node/.codex/bin/agent-to-discord start
```

The installation and configuration will survive container recreation as long as you retain the `/home/node/.codex` volume. To start this installation automatically, replace `sleep infinity` in your Compose configuration with:

```yaml
command: ["/home/node/.codex/bin/agent-to-discord", "start"]
```

Make this change only after installation and a successful `doctor` check. Stop any manually started bot before applying the Compose configuration. `restart: unless-stopped` restarts the container after a crash or restart; running the bot through `docker exec` alone does not provide this behavior. Reinstall the package when changing the Node.js major version or architecture.

To check the running bridge instead of only the installed Codex binary, add:

```yaml
healthcheck:
  test: ["CMD", "/home/node/.codex/bin/agent-to-discord", "healthcheck"]
  interval: 60s
  timeout: 10s
  retries: 3
  start_period: 60s
```

`healthcheck` contacts a private Unix socket in `AGENT_STATE_DIR`. It checks the running bot's Discord gateway readiness and asks its existing Codex app-server to report the login state, with a five-second RPC timeout. It starts no extra agent, sends no Discord message, opens no TCP port, and does not run a model task. It fails if the bot is stopped, unresponsive, disconnected, or missing its Codex login. This is a connection check, not an end-to-end model/API or channel-permission test; use `doctor` after changing permissions. Docker marks repeated failures as `unhealthy`; `restart: unless-stopped` alone does not restart a container just because it is unhealthy.

Personal workspace instructions can be stored in `/workspace/AGENTS.md` on the persistent workspace volume. Keep credentials and deployment-specific secrets out of that file and out of the public repository.

The bot runs in the same container as Codex under the regular `node` user. It starts its own `codex app-server --stdio`, using the same `CODEX_HOME` and login. It does not modify or update the separate CLI daemon. The main channel, each Discord thread, and each scheduled task have their own Codex conversations; it does not share your currently open interactive session.

As an alternative to installing into a volume, you can build the package into the image: add the source repository, run `npm ci --omit=dev --ignore-scripts`, and set the container's main command, for example:

```yaml
command:
  - node
  - /opt/agent-to-discord/src/cli.js
  - start
  - --env-file
  - /home/node/.codex/agent-to-discord/.env
```

Keep your existing named volumes for `/workspace` and `/home/node/.codex`. Store the bot's configuration and state in the second volume, and build the source code into the image outside the workspace. The recommended settings remain `user: node`, `init: true`, and `restart: unless-stopped`, without a Docker socket or privileged mode. Installing this project does not change capabilities, AppArmor, or seccomp; the host must support the Codex sandbox.

If the bridge crashes, its process exits and the container stops; Docker restarts it according to the restart policy. Back up both volumes. A volume protects against container recreation, not disk failure or data deletion.

Standalone Discord threads start a fresh Codex conversation when you send their first message. Discord system notices (including the parent channel's thread-created notice) never count as user tasks. Threads created from ordinary tracked messages still fork the original conversation at that message's completed turn.

## Permissions and privacy

By default (`AGENT_EXECUTION_MODE=sandboxed`), Codex uses `workspace-write` and `on-request` approvals, with the user as the approver. The bot does not automatically enable full access or approval without prompting. A one-time command approval may allow an action outside the inner sandbox; user permissions and Docker restrictions still apply. Each button is tied to a specific account, Discord thread, and active task.

For a container with independent isolation, set `AGENT_EXECUTION_MODE=container` in the private bot `.env` and restart the bot after current tasks finish. This explicitly selects `danger-full-access` with `never` approvals for new, resumed, restored, forked and scheduled conversations. It disables Codex's inner filesystem/network sandbox and command/file approval prompts; it does not grant root or change Docker permissions. The default for all other installations stays sandboxed. Do not enable this mode on a host without an independent sandbox.

Container isolation must be enforced outside the agent: no Docker socket, host directory mounts or privileged mode; restrict access to the host and other containers with network rules and retain resource limits. This setting does not detect whether an arbitrary command could affect the VPS or automatically request host approval. Keep such access blocked and handle host changes separately with the operator. Agent instructions are guidance, not a security boundary. The agent can modify everything accessible to its Unix user, including its own configuration and credentials; shared disk exhaustion is not prevented by memory/CPU limits.

Interactive Codex CLI is configured separately in `$CODEX_HOME/config.toml` (top-level keys, before any `[table]`):

```toml
approval_policy = "never"
sandbox_mode = "danger-full-access"
```

These CLI settings are suitable only for the same independently isolated environment. Start a new CLI session to apply them; the bot uses the explicit mode above. See [Codex sandbox documentation](https://learn.chatgpt.com/docs/sandboxing).

The token is not passed to the Codex child process's environment. However, this does not fully isolate secrets: depending on the system, processes running under the same Unix user may be able to read each other's files or environment. The workspace, configuration, and agent are not separate security containers. Do not store the token in the workspace. The bot does not write task content to operational logs; history is stored in Codex and Discord; schedule prompts and message-to-conversation metadata are also stored in the private bridge state, subject to thread deletion and the retention policy described above.

Conversation text and explicitly requested files are sent to Discord. Hidden files, common authentication files, and paths outside the workspace cannot be exported through `!file`; this check does not identify every possible secret. Request a file only when you intend to share it.

## Development

```sh
npm ci --ignore-scripts
npm test
npm audit
```

Tests cover authorization, duplicate messages, restarts, files, approvals, task errors, RPC disconnections, persistent message queues, active-turn steering, slash commands, typing, main-chat continuity, point-in-history forks, quoted replies, reset races, archive actions, retention/restore races, schedule routing, daylight saving, and uncertain execution recovery. Integration testing requires a signed-in Codex instance and your own Discord bot. CI tests do not use production tokens.

MIT license. An unofficial project; not a product of OpenAI or Discord.
