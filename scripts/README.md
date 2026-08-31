# scripts

Two of these are wired into `package.json` and run as part of normal work. The other three
are probes: standalone diagnostics for the parts of Claude Code that aivis depends on but
that Claude Code does not document.

## Run by `npm`

| Script | Invoked as | What it does |
| --- | --- | --- |
| `design-bundle.mjs` | `npm run design:build`, `npm run design:preview` | Builds `design/dist` by inlining the sections of `web/styles.css` that each preview asks for. `--serve` also serves the result on `http://127.0.0.1:4321` |
| `make-fixtures.mjs` | `npm run fixtures`, `npm run demo` | Writes the invented transcript store into `fixtures/projects`. Generated rather than committed, because status and ordering are computed from timestamps |
| `stop.mjs` | `npm stop`, `npm run restart` | Frees the port, whatever is holding it. The port is the identity — aivis is whatever answers on it, however it was started |

## Probes

These exist because aivis reads and writes interfaces that are not published. When a Claude
Code update changes one, the probe is how you find out whether it is still true, without
guessing from aivis's own behaviour. Each runs standalone and prints the raw exchange.

| Probe | Proves | Costs tokens |
| --- | --- | --- |
| `ask-probe.mjs` | That `--permission-prompt-tool stdio` still carries questions and permission prompts as `can_use_tool` control requests, and still accepts answers back. This is the whole basis of answering a question from the browser | **Yes** — starts a real session |
| `interrupt-probe.mjs` | That an `interrupt` control request on a `--input-format stream-json` session stops a turn without ending the session. This is the stop button | **Yes** — starts a real session |
| `socket-probe.mjs` | That a session's message socket at `/tmp/cc-socks/<pid>.sock` still accepts the `auth` and `user` frames aivis sends. This is how a message reaches a session running in a terminal | No — talks to a session you already have |

```bash
node scripts/ask-probe.mjs
node scripts/interrupt-probe.mjs [delay-ms] [model]
node scripts/socket-probe.mjs <pid> "<message>"
```

`ask-probe.mjs` and `interrupt-probe.mjs` start a real `claude` process against a throwaway
session, so they spend tokens and count against your rate-limit block. `socket-probe.mjs`
delivers into a session that is already running, so it only costs whatever that session does
with the message.

Each probe reads its own header comment for what a working run looks like. If one starts
failing after a Claude Code update, that is the signal to open an issue rather than to
debug aivis.
