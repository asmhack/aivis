# Configuration

Every setting is an environment variable. There is no configuration file. For where these
values show up in the interface, see the [guide](guide.md).

| Variable | Default | Purpose |
| --- | --- | --- |
| `AIVIS_PORT` | `4319` | Server port |
| `AIVIS_HOST` | `127.0.0.1` | Bind address. There is no authentication, so a non-loopback bind hands your filesystem, your transcripts and the `claude` CLI to anyone who can reach the port. aivis says so loudly at startup when you do it |
| `AIVIS_ALLOWED_HOSTS` | unset | Extra hostnames aivis will answer to, comma separated. Requests are refused unless their `Host` and `Origin` are loopback, `AIVIS_HOST`, or listed here — see [Security and trust](../README.md#security-and-trust). Set it when you reach aivis under a name that is neither, such as a Tailscale host |
| `AIVIS_SERVE_STATIC` | unset | Set to `1` to serve the built front end from `dist` instead of relying on the Vite dev server. `npm start` and `npm run serve` set it for you; running `tsx server/index.ts` by hand does not, which is why the page 404s if you forget |
| `AIVIS_PROJECTS_DIR` | `~/.claude/projects` | Transcript store to index |
| `AIVIS_FULL_PARSE_MAX_MB` | `4` | Transcripts above this size are sampled, not parsed whole |
| `AIVIS_STALE_AFTER_SECONDS` | `120` | Silence after which a live session counts as stalled |
| `AIVIS_WAITING_WINDOW_HOURS` | `4` | How recently a session must have stopped to be queued as waiting on you |
| `AIVIS_TASK_WINDOW_HOURS` | `6` | How long a background task with no completion notice is still believed to be running |
| `AIVIS_REFRESH_SECONDS` | `3` | How often the fleet is recomputed |
| `AIVIS_CLAUDE_BIN` | `claude` | Executable used to drive sessions |
| `AIVIS_PERMISSION_MODE` | `auto` | Permission mode for sessions aivis drives |
| `AIVIS_ANSWER_ASKS` | `1` | Route questions and permission prompts to the browser. `0` goes back to Claude Code denying them |
| `AIVIS_SOCKET_SESSION_GUARD` | `1` | Drop a socket message addressed to a session other than the one aivis matched |
| `AIVIS_PARK_TTL_DAYS` | `14` | Days a session stays parked without being seen alive |
| `AIVIS_BLOCK_HOURS` | `5` | Length of a rate-limit block |
| `AIVIS_BLOCK_TOKEN_LIMIT` | unset | Real token ceiling, if you know it |
| `AIVIS_TRUST_NEW_PROJECTS` | `1` | Mark a folder trusted when starting a session in it |
| `AIVIS_BASH` | `auto` | Whether a `!` line may run a command on this machine. `auto` allows it on a loopback bind and refuses it on any other; `1` allows it everywhere, `0` nowhere |
| `AIVIS_BASH_TIMEOUT_SECONDS` | `300` | How long a `!` command may run before its process group is killed |
| `AIVIS_BASH_MAX_OUTPUT_KB` | `256` | How much of each of a `!` command's two streams is kept. The rest is read and dropped |

Two variables aivis reads but does not own, both belonging to Claude Code:

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_MODEL` | Read to work out which model a new session would default to, so the new-session sheet can show it. A `model` key in a settings file wins over it |
| `CLAUDE_CODE_MESSAGING_TOKEN` | If set in aivis's own environment, forwarded as an auth frame when delivering a message into a terminal session. Current Claude Code builds ignore it; it is sent so that a build which starts checking one is more likely to accept a valid token than none |

