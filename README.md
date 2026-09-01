# aivis

A local web dashboard for Claude Code, and the place you run it from instead of a terminal
tab per project. Start sessions, steer them, answer their questions, read what they changed,
and see every session on the machine at once — from one page, in a browser.

aivis binds to `127.0.0.1` and has no authentication, because it shows every transcript on
the machine to whoever reaches the port. [Security and trust](#security-and-trust) explains
what that means before you change the bind or take a screenshot.

```bash
git clone https://github.com/asmhack/aivis.git && cd aivis
npm install
npm run demo        # an invented fleet, on http://localhost:5179
npm run dev         # your real sessions, same address
```

## What it's for

Claude Code runs in a terminal, so most people start it wherever their terminal already is:
inside the IDE, one session per project. That works right up until the IDE stops being where
the work happens. Once you are describing changes rather than typing them, the editor is
mostly a window you keep open to hold the sessions running inside it — and the day it freezes
and you reload it, every one of those sessions goes with it.

A plain terminal is the obvious next step, and it is sturdier but scales no better. One tab
per project, then more tabs for the second and third thing you asked of that project, and
somewhere around fifteen you are not running sessions any more, you are administering tabs.
Every one of them is quiet, and quiet means four different things: still thinking, finished
and waiting for you, stopped mid-tool-call, or holding a question it asked forty minutes ago.
The only way to tell them apart is to visit each one.

aivis is where that work moves to. It reads the transcript store Claude Code already writes
under `~/.claude/projects`, renders the whole machine as a single page ordered by how much of
your attention each thing has earned, and gives you the controls to act on what you find —
so a session is no longer tied to a window you have to keep open, or to a tab you have to
remember. Three bands answer three questions:

- **What needs you.** Sessions that asked a question, finished a turn and are holding for a
  reply, or stopped mid-turn and went quiet, ranked longest wait first, each with the action
  that deals with it. The tab itself carries the count, so `(2) aivis` in the tab strip answers
  "is anything waiting on me" from wherever you are working; ring the bell in the band's header
  and the two urgent kinds also arrive as system notifications, so you hear about them without
  the browser on screen at all.
- **What is advancing.** A tile for each session actually doing something, carrying its
  current tool call, its model, how much of its context window is spent, and a sparkline of
  tool calls a minute over the last quarter of an hour.
- **Where everything else is.** Every project on the machine, one line each, so the sessions
  nobody is waiting on stay out of the way without disappearing.

![The aivis fleet index. A queue headed "needs you" lists a session asking a question, two
that finished their turn, and one that has gone silent mid-command, each with buttons to open,
nudge, or dismiss it. Below it a tile shows the one session currently running, then the open
sessions, then every project on the machine with a count of its sessions.](docs/images/fleet.png)

None of it is read-only. The same page starts sessions, answers their questions, nudges the
ones that went quiet, sends a message into a session running somewhere else, stops a turn,
and ends one.

### Run sessions from the browser

Starting work is the part that takes you off the terminal for good. Press `Cmd+N`, pick one
of your projects or any other folder, choose the branch, model, effort, and permission mode,
type the first prompt, and aivis runs `claude` for you in that directory. When you already
know where the work goes, `+ session` on a project header skips the picker.

A session started this way belongs to aivis rather than to the window you happen to be
looking through. Close the tab, close the browser, come back to the page an hour later: the
session is still running, and still yours to answer. Questions and permission prompts it
raises arrive on the page instead of stopping in a terminal nobody is watching, which is what
makes the browser sufficient rather than merely convenient.

Nothing survives everything — the sessions aivis drives are its children, so stopping the
server stops them, and shutting the laptop down ends every Claude Code session on the machine
in any case. What aivis keeps is the conversation. Every session it has seen alive is written
to a small registry, so after a reboot it comes back listed as **parked** rather than lost
among the transcripts you finished months ago, and one message resumes it where it stopped.

![The new-session sheet, with a project chosen, fields for branch, model, effort, and
permissions, and a first prompt typed into a text box above a Start session
button.](docs/images/new-session.png)

### Open one session

Clicking a session opens the whole conversation at a URL you can bookmark: your prompts,
Claude's replies rendered as markdown, thinking folded behind a toggle, and every tool call as
a row you can expand for its input and its output. Because a transcript records an edit as
both sides of the change, `Write`, `Edit`, `MultiEdit`, and `NotebookEdit` are drawn as diffs
rather than as raw tool input, and the collapsed row carries the `+N −M` counts so you can see
the size of a change without opening it.

![A session page showing the prompt, Claude's replies, and an expanded Edit tool call rendered
as a red and green diff of a React state change, followed by the test command it ran and its
closing summary.](docs/images/session.png)

## Security and trust

aivis is a local program that reads local files and serves them to your own browser. It sends
nothing anywhere. There is no telemetry, no analytics, no crash reporting, no update check,
and no account. Every request the page makes is a relative `/api/…` path back to the process
that served it, live updates arrive over a WebSocket to that same origin, and the server opens
exactly two kinds of connection: an HTTP listener bound to `127.0.0.1`, and Unix domain
sockets under `/tmp` that carry a message into a session running in a terminal. No remote host
is named anywhere in the source.

The page loads no third-party assets either — no web fonts, no CDN scripts, nothing that
phones home — and `index.html` sets a Content-Security-Policy of `img-src 'self' data: blob:`.
That last rule earns its place: a message on the page was written by a model that may be
repeating an instruction it read in a web page or a checked-in file, and a browser fetches an
`<img>` the moment it renders one. Confining image sources to this machine means a transcript
cannot become an outbound request carrying whatever the address encodes.

The dependency surface is small and pinned. aivis has six runtime dependencies, each at an
exact version rather than a range, which comes to 108 packages once transitive dependencies
are counted — most of them the markdown parser:

| Dependency | Version | Used for |
| --- | --- | --- |
| `chokidar` | 4.0.3 | Watching the transcript store for changes |
| `react`, `react-dom` | 19.2.8 | The page |
| `react-markdown`, `remark-gfm` | 10.1.0, 4.0.1 | Rendering replies as markdown |
| `ws` | 8.21.3 | The socket that pushes fleet updates to the browser |

`.npmrc` sets `save-exact`, so installing a package can never widen one of those into a caret
range, and `engine-strict`, so an unsupported Node version stops the install rather than
surfacing later as an unrelated build error. CI typechecks, tests, and builds on Node 20.19
and 22 with `permissions: contents: read` and no secrets.

No subprocess aivis runs for itself goes through a shell. `git`, `ps`, `lsof`, `rg`, and
`claude` are invoked with an argument array, so a session id or a path typed into the browser
can never become a command. Every request and every WebSocket handshake is checked for a local
`Origin` and a `Host` aivis recognises, which is what stops a page on another site — or a
hostname an attacker controls that resolves to your loopback address — from reaching the port
your browser can reach.

aivis never handles credentials. It reads transcript files, and any session it launches
inherits the Claude Code CLI's own login from the system keychain. `ANTHROPIC_API_KEY` and
`ANTHROPIC_AUTH_TOKEN` are stripped from a launched session's environment, so a key set for
something else cannot silently move your usage onto API billing.

What aivis does not do is authenticate you. It has no login and no token, and it indexes
**every** transcript under `~/.claude/projects`: every prompt you have ever typed, the
contents of the files those sessions read, and the diffs of the files they changed. Anyone who
can reach the port can read all of it, browse the filesystem, and start `claude` in any
directory as you. That is the reason for the loopback bind, and the reason aivis complains
loudly when you change it. It is also why a session's title is its opening prompt: a prompt
that contained a credential puts that credential on the card. Two things follow from this that
are worth doing rather than knowing:

- Before you screenshot aivis or attach a repro to an issue, run `npm run demo` and reproduce
  against the invented fleet. The screenshots on this page come from that fixture store, with
  placeholder processes standing in for live sessions.
- If you use Claude Code for a client or an employer, their code and their internal names are
  in that store too, and therefore in anything aivis renders.

[SECURITY.md](SECURITY.md) has the full trust model, what is deliberately not defended, and
how to report a vulnerability.

## How it works

Claude Code appends one JSON record per event to
`~/.claude/projects/<project-slug>/<session-id>.jsonl`. aivis tails those files by byte
offset, so a change parses only what was appended instead of re-reading the file, which is
what keeps a store of hundreds of megabytes cheap to follow. Everything on the page comes from
those records: the status from the shape of the tail, the current activity from the most recent
tool call, the prompt and tool counts accumulated as they arrive.

A transcript records its working directory but not the process id writing it, so liveness
comes from a second source. aivis lists running `claude` processes with `ps`, asks `lsof` for
each one's working directory, and matches them to the most recently active transcript in that
directory. That match is what separates a session that is working from a terminal you left
open, and it is the one inference in the system that can be wrong;
[Internals](docs/internals.md) says exactly when.

Sessions aivis starts are not the same as sessions it finds. It holds a started session's
standard input and output, so that session's questions and permission prompts route to the
browser and can be answered there. A session running in your own terminal is reached over the
message socket Claude Code exposes, which delivers a message but cannot answer a question —
that dialogue belongs to the terminal that owns it, and aivis reports such a session as
stalled rather than dressing it up as a prompt it could accept for you.

### Where to look first

Start at the index, and read it from the top. **Needs you** is the only band that carries
actions, so if it is empty, nothing is blocked on you. **Running** is what to watch while you
wait. **Rest of the fleet** is where a session goes once nobody is waiting on it, and `resume`
on any row there copies `cd <cwd> && claude --resume <id>` for the terminal. The `?` beside
the counts in the header opens a legend that defines each one against the thresholds currently
in force, rather than against a number written into prose. From there, the
[guide](docs/guide.md) covers the session page and everything you can do from it.

## Install and run

| Requirement | Why |
| --- | --- |
| macOS or Linux | The server shells out to `ps` and `lsof` to find live sessions, and reaches terminal sessions over Unix domain sockets under `/tmp`. Windows is not supported |
| Node `^20.19.0 \|\| >=22.12.0` | The floor Vite 7 sets. `.npmrc` turns on `engine-strict`, so `npm install` stops on an older Node rather than failing later with something unrelated |
| The `claude` CLI on your `PATH` | Only to start and drive sessions. Watching an existing fleet works without it |
| `rg`, or GNU `grep` as `ggrep` | Optional. Used to read the slash-command list out of the Claude Code bundle |

There is no database, no configuration file, and no account.

```bash
npm install
npm run demo       # an invented fleet, safe to screenshot
npm run dev        # your real sessions. Server on :4319, Vite dev server on :5179
```

`npm run demo` writes a fictional transcript store into `fixtures/projects` and points
`AIVIS_PROJECTS_DIR` at it, so you can see the layout without putting your own history on
screen. Nothing in it reports as `working`, because that needs a live `claude` process and
these are files with nothing behind them; the demo is for the session view and the index
layout, not the live states.

Open http://localhost:5179. For a single-process setup, build once and serve the result:

```bash
npm run build
npm start          # everything on http://localhost:4319
npm restart        # pick up code changes: stops the old server, rebuilds, starts again
npm stop           # free the port, whatever is holding it
```

`npm start` builds the front end before it serves, so a server left running from an earlier
build ends up serving a page newer than itself. The two have to agree on the shape of a
session, and when they do not the page says so rather than rendering something wrong. That is
what `restart` is for, and why `stop` frees the port rather than trusting a process name.

Every setting is an environment variable, and [Configuration](docs/configuration.md) lists all
of them.

## Documentation

| Document | What is in it |
| --- | --- |
| [Guide](docs/guide.md) | The whole interface: the fleet index, the session page, and every action either one offers |
| [Configuration](docs/configuration.md) | Every environment variable, with its default and what it changes |
| [Internals](docs/internals.md) | How transcripts are read and sampled, what that costs in accuracy, the known limits, and which Claude Code interfaces aivis depends on |
| [Design system](docs/design-system.md) | The standalone previews in `design/` and the round trip through a design tool |
| [Security](SECURITY.md) | The trust model, what is deliberately not defended, and how to report a vulnerability |
| [Contributing](CONTRIBUTING.md) | Setting up, the checks, and how to open a pull request |

aivis is a third-party client for files and sockets that Claude Code writes for its own use,
none of which is a published interface. It was built against Claude Code 2.x. If an update
breaks something, open an issue with your `claude --version`; the compatibility table in
[Internals](docs/internals.md) lists what would break first.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: open an issue first, run
`npm run check`, and develop against `npm run demo` rather than your real transcript store —
a screenshot of your own fleet is a screenshot of your prompts.

For anything security-related, see [SECURITY.md](SECURITY.md) rather than opening a public
issue.

## License

[MIT](LICENSE). Copyright (c) 2026 Serhiy Zaporozhets.

aivis is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude", "Claude
Code", and "Anthropic" are trademarks of Anthropic, used here only to say what this program
reads.
