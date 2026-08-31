# Security

## The short version

aivis is a single-user tool that runs on your own machine and has **no authentication**.
Anyone who can reach its port can read every prompt in every Claude Code transcript on the
machine, browse the filesystem, and start `claude` in any directory as you. Everything
below follows from that. Keep it on `127.0.0.1`.

## What aivis can see and do

It reads `~/.claude/projects`, which is Claude Code's own transcript store. That store
holds the full text of every session you have ever run: your prompts, the model's replies,
the contents of files that were read, and the diffs of files that were changed. aivis
indexes all of it and serves it to the browser. There is no per-project exclusion — the
only way to narrow what it indexes is to point `AIVIS_PROJECTS_DIR` at a smaller store.

Beyond reading, it acts. It can start a `claude` process in any directory you name, send
messages into sessions running in your terminals, answer permission prompts on their
behalf, interrupt turns, and terminate processes. A session it starts inherits your
Claude Code login and your permissions.

It also runs shell commands directly. A message beginning with `!` is not sent anywhere: the
daemon runs the rest of the line in the session's directory, as you, and holds the output
until the next message — the same thing the Claude Code terminal client does with a `!` line.
The command is passed to `$SHELL -c`, because a `!` line that could not pipe or glob would not
be the feature. See [`!` lines](#-lines) below.

Two consequences worth stating plainly:

- **Your session titles are your prompts.** aivis uses a session's opening prompt as its
  title, so it appears on the card, on the page, and in the browser tab. If you have ever
  pasted a credential into a prompt, it is on screen. This is also why screenshots of a
  real fleet are risky to share — see [Reporting a bug safely](#reporting-a-bug-safely).
- **Transcripts are not yours alone.** If you use Claude Code for client or employer work,
  their code and internal names are in that store, and therefore in anything aivis renders.

## The trust model

aivis trusts its own user completely and trusts nothing else. Concretely:

| Boundary | How it is enforced |
| --- | --- |
| Only local pages may talk to it | `Host` and `Origin` are checked on every HTTP request and on the WebSocket handshake (`sameOrigin` in `server/origin.ts`) |
| A request body must be JSON | `readBody` refuses any `Content-Type` that is not `application/json`, so a cross-site POST cannot stay a CORS "simple request" and has to survive a preflight aivis never answers |
| It listens only to you | Default bind is `127.0.0.1`; a non-loopback bind prints a warning at startup |
| No shell is involved in aivis's own work | Every subprocess aivis runs for itself goes through `execFile`/`spawn` with an argument array — `git`, `ps`, `lsof`, `rg`, and `claude` alike. There is no string interpolation into a command line anywhere. The one shell is the `!` line, described below, where running the command *is* the request |
| Images served by path must be referenced | `/api/sessions/:id/localfile` serves a file only if the path is absolute and already normalised, only if it is an image by extension, and only if that session's own transcript mentions it. The bytes come back with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'`, so a file opened at the top level cannot act as a page in this origin |
| A stored image is served as an image | `/api/sessions/:id/image` matches the record's own `media_type` against the four types Claude accepts before it becomes the response `Content-Type`, and sends the same `nosniff` and `sandbox` headers, so a crafted record cannot have its bytes served as a page |
| A new session's permission mode is fixed | The value is matched against a fixed list before it reaches the `claude` command line |
| Attachments are private | Pasted images land in the temp directory at mode `0600` inside a `0700` directory, and are swept after a day |

### Why the origin check matters

A browser will let any page you visit issue requests to `http://127.0.0.1`. Without a
check, a tab open on some unrelated site could POST to aivis and start a session, or open
its WebSocket and receive your entire fleet — every title, every path — in the first
frame. WebSocket handshakes are not covered by the same-origin policy at all, so the check
has to be explicit.

aivis therefore refuses any request whose `Origin` is not local, and any request whose
`Host` header is not one it recognises. The `Host` half is what stops **DNS rebinding**: an
attacker can point `aivis.example.com` at `127.0.0.1`, but the browser will then send
`Host: aivis.example.com`, which does not match.

Requests with no `Origin` header at all are allowed, because that is what `curl`, the probe
scripts in `scripts/`, and any non-browser client send. This is deliberate: the threat being
closed is a web page, and a local process that wants to reach the port does not need to be
stopped by aivis when it could read `~/.claude/projects` directly.

A *present* `Origin: null` is a different thing and is refused. No non-browser client sends
it; it is what a browser sends for an opaque origin — a sandboxed iframe, a `data:` or
`file:` document, a request that followed a cross-site redirect. Every one of those is a
page, and a page is what this check exists to refuse.

The exact rule, since the two headers are checked differently:

| Bind | `Host` must be | `Origin`, when present, must be |
| --- | --- | --- |
| Loopback (the default) | loopback, `AIVIS_HOST`, or in `AIVIS_ALLOWED_HOSTS` | one of those same names, or equal to `Host` |
| Anything else | not checked | one of those names, or equal to `Host` |

The `Host` check is dropped on a non-loopback bind because an operator who deliberately
binds outward is reached under a name aivis cannot predict, and refusing it would mean the
server would not serve its own pages. `Origin` matching `Host` is what covers that case: it
says the page came from this server. The cost is that **DNS rebinding is not defended
against on a non-loopback bind** — an attacker who controls a name pointing at your address
satisfies both headers. That bind has no authentication anyway, which is the larger problem
and the reason for the warning at startup.

If you reach aivis on loopback under some other name — a Tailscale MagicDNS name, or a
reverse proxy — add it to `AIVIS_ALLOWED_HOSTS` as a comma-separated list.

### What is deliberately not defended

- **A non-loopback bind.** `AIVIS_HOST=0.0.0.0` works, prints a warning, and gives everyone
  who can route to the port full control. If you want aivis off-machine, put it behind
  something that authenticates. Do not expose it directly.
- **Reading files outside a project.** The file browser and the changes view read what your
  user can read. This is the point of the tool, not a flaw in it.
- **The user's own intent.** aivis will start a session in `bypassPermissions` mode if you
  ask it to, because Claude Code will.

### `!` lines

A `!` line runs an arbitrary shell command on the machine aivis is running on. That is the
feature, not a weakness in it, and it is worth being exact about what it does and does not
change.

**It does not widen the blast radius of a reachable port.** `POST /api/sessions` already
starts `claude` in any directory with `--permission-mode auto`, so anyone who can reach an
unauthenticated aivis can already run arbitrary code as you. `!` is a shorter, quieter route
to the same place — instant, and leaving no session in the fleet, no transcript, and no token
spend behind it.

`AIVIS_BASH` is therefore offered as a **narrowing, not a boundary**. It defaults to `auto`,
which allows `!` on a loopback bind and refuses it on any other, on the reasoning that a bind
anyone can route to is exactly where the difference between the loud route and the quiet one
is worth having. `AIVIS_BASH=1` allows it anywhere and `AIVIS_BASH=0` nowhere. None of these
is a substitute for authentication in front of a non-loopback bind.

What the implementation does guarantee, in `server/bash.ts`:

- The working directory is the session's own, taken from the fleet. A request cannot name a
  directory, so `!` is never "run anything anywhere".
- stdin is `/dev/null`, so a command that prompts fails rather than hanging on a pipe nobody
  writes to.
- The command runs in its own process group and a timeout (`AIVIS_BASH_TIMEOUT_SECONDS`)
  kills the group, so a pipeline cannot outlive the shell that started it.
- Output is capped per stream (`AIVIS_BASH_MAX_OUTPUT_KB`) and the excess is read and
  discarded rather than left to block the writer.
- Output is escaped before it is wrapped in `<bash-stdout>`, so a command that prints
  `</bash-stdout><bash-input>…` cannot forge a run the model would read as having happened.
- The environment has the same variables stripped that a driven session has —
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and the `CLAUDE_*` session variables.

**What a `!` line prints is not secret.** It goes to the browser and, once the next message is
sent, into the transcript, where it stays. A `!env` or a `!cat ~/.aws/credentials` puts those
values in a file under `~/.claude/projects` and in the model's context. That is true of the
terminal's `!` as well; it is easier to do by accident from a phone.

## Reporting a vulnerability

Open a [security advisory](https://github.com/asmhack/aivis/security/advisories/new) on the
repository. Please do not open a public issue for anything that would let one user reach
another user's transcripts or processes.

There is no formal SLA — this is a personal project. A realistic expectation is a first
response within a week.

Findings that are **in scope** and worth reporting:

- Anything that lets a web page, another user on the machine, or a network peer reach the
  API or the WebSocket.
- A way to escape the containment on `/api/sessions/:id/localfile`, `/api/browse`,
  `/api/files`, or the changes endpoints.
- Any path by which client-supplied input reaches a shell *other than through a `!` line*, or
  reaches the `claude` command line as a flag rather than as data.
- A way to make a `!` line escape the constraints listed under [`!` lines](#-lines) — running
  outside the session's directory, surviving its timeout, or forging a run in the transcript.

Findings that are **out of scope**, because they follow from the design above:

- "The API has no authentication." Yes — see the top of this file.
- "Setting `AIVIS_HOST=0.0.0.0` exposes everything." Yes, and it says so at startup.
- "A user can read their own files." That is the feature.
- "A `!` line runs arbitrary commands." Yes — that is what it is for, and it is refused by
  default on any bind that is not loopback. See [`!` lines](#-lines).

## Reporting a bug safely

A screenshot of your real fleet contains your prompts and your absolute paths, and a
transcript excerpt contains whatever you were working on. Before attaching either to a
public issue, reproduce against the bundled fixtures instead:

```bash
npm run demo        # AIVIS_PROJECTS_DIR=fixtures/projects
```

That serves an invented fleet with no connection to your machine, which is safe to
screenshot and safe to paste.
