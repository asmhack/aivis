# Contributing

Thanks for looking. aivis is a small project with one maintainer, so the most useful thing
you can do is open an issue before writing much code — it is easy to spend a weekend on
something that turns out to conflict with a direction already chosen.

## Requirements

| Thing | Why |
| --- | --- |
| macOS or Linux | The server shells out to `ps`, `lsof`, and Unix domain sockets under `/tmp`. Windows is not supported |
| Node `^20.19.0 \|\| >=22.12.0` | The floor Vite 7 sets. `.npmrc` sets `engine-strict`, so `npm install` will stop rather than fail later in a confusing way |
| The `claude` CLI on your `PATH` | Only needed to drive sessions. Reading an existing fleet works without it |
| `rg` or GNU `grep` | Optional. Used to scan the Claude Code bundle for the slash-command list |

## Getting set up

```bash
git clone https://github.com/asmhack/aivis.git
cd aivis
npm install
npm run demo        # http://localhost:5179, against the bundled fixtures
```

`npm run demo` regenerates `fixtures/projects` from `scripts/make-fixtures.mjs` and points
`AIVIS_PROJECTS_DIR` at it. **Start here rather than with `npm run dev`.** `npm run dev`
indexes your real `~/.claude/projects`, which means every prompt you have ever typed — for
your own work and anyone else's — is on screen and in any screenshot you take. Use the
fixtures for development, screenshots, and bug reports, and switch to the real store only
when you are testing something the fixtures cannot reproduce.

One thing they cannot reproduce is anything that depends on a live process. A session
counts as `working`, `stalled`, or `asking you` only when a `claude` process is alive to be
found by `ps`, and a running background task is suppressed by the same rule — a fixture is a
file with nothing behind it, so the whole demo fleet reads as `ended`. The fixtures are for
the session view (transcript rendering, tool calls, the rails, the composer) and the index
layout. Testing the state machine itself needs real sessions; `design/src` is where those
live states are drawn for design work.

## Checks

```bash
npm run check     # typecheck + tests, the same thing CI runs
npm run typecheck
npm test
npm run build
```

CI runs `npm run check` and `npm run build` on Node 20 and 22. There is no linter and no
formatter — with one maintainer they were not earning their keep, and adding one now would
bury the first real contribution under a whole-repo reformat. Match the style of the file
you are editing.

`tsconfig.json` has `noUnusedLocals` and `noUnusedParameters` on, so a leftover import or an
unused parameter fails the typecheck rather than accumulating.

## How the pieces fit

| Directory | What lives there |
| --- | --- |
| `server/` | Node HTTP + WebSocket server. Reads transcripts, watches the store, drives sessions |
| `web/` | React front end. `App.tsx` routes; `components/` holds the four big views |
| `shared/` | Types both sides agree on. Change these first when you change the wire |
| `design/src/` | Standalone HTML previews of each component, for design work |
| `scripts/` | Build and operational scripts, plus three probes. See `scripts/README.md` |
| `fixtures/` | The invented fleet `npm run demo` serves |
| `test/` | `node:test` suites. No test framework to install |
| `docs/` | The guide, the configuration reference, the internals, and the design-system notes |

`docs/guide.md` is unusually detailed about *behaviour* — what each state means, why the
queue is ordered the way it is, how the fleet is computed. Read the section covering the area
you are changing; most of the non-obvious decisions are explained there rather than in
comments.

## Writing code

A few conventions that are load-bearing rather than taste:

- **Comments explain why, not what.** The existing code has a lot of them and they are
  nearly all about a decision that looks wrong until you know the reason. Keep that.
- **`shared/types.ts` is the contract.** The front end refuses to render a shape it does not
  recognise rather than guessing, so widen the type first.
- **No shell strings.** Every subprocess uses `execFile` or `spawn` with an argument array.
  See [SECURITY.md](SECURITY.md).
- **`web/styles.css` is the only stylesheet.** It is split into sections by one-line comment
  headers followed by a blank line, and `npm run design:build` uses that split to inline
  exactly the sections a preview asks for. A comment with no blank line under it is prose
  inside a section, not a new one — the difference matters to the build.

## Adding a test

`npm test` runs `node --import tsx --test test/*.test.ts`, using the built-in runner, so
there is nothing to install; the `--import tsx` half is what lets the suites import the
server's TypeScript modules directly. Put a new suite straight in `test/` and name it
`something.test.ts`. The glob is flat and left for the shell to expand on purpose: Node
only learned to expand `--test` patterns itself in v21, and the floor here is 20.19, so a
suite hidden in a subdirectory would be skipped without a word. The places most worth
covering are the ones where a wrong answer is silent: transcript parsing, the diff
algorithm, and the rate-limit block arithmetic.

## Design changes

The previews in `design/src` exist so the visual design can be edited in isolation and
brought back:

```bash
npm run design:build      # regenerate design/dist from web/styles.css
npm run design:preview    # build, then serve on http://127.0.0.1:4321
```

Every preview must use invented sample data. They were originally filled with content
pasted from real sessions, which is exactly the mistake this note exists to prevent — the
fictional company in them (`acme`, with `checkout-api`, `checkout-web`, `pricing-engine`
and `docs-site`) is there so there is always something to reach for. Keep replacement copy
about the same length as what it replaces; several previews exist specifically to show how
the CSS handles text that wraps or truncates.

## Pull requests

- One topic per PR. A refactor bundled with a fix is hard to review and harder to revert.
- Say what you tested. "Ran `npm run check`" is fine; "watched a stalled session get nudged"
  is better.
- Update `docs/guide.md` when you change what a user sees, and the README when you change
  what aivis is for. They are the actual documentation, not a summary of one.
- **Never paste real transcript content, absolute paths from your machine, or a screenshot
  of your real fleet.** Reproduce against `npm run demo` instead.

## Reporting bugs

Include what you expected, what happened, your OS and Node version, and whether the session
involved was one aivis started or one running in a terminal — that distinction changes which
code path runs and is the single most useful thing in a report.

For anything security-related, see [SECURITY.md](SECURITY.md) rather than opening a public
issue.

## License

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE), the same terms as the rest of the project.
