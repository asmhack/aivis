# What aivis shows

This guide is the full tour of the interface: the fleet index, the session page, and every
action you can take from either. For what aivis is and how to start it, see the
[README](../README.md). For the environment variables named here, see
[Configuration](configuration.md).

## The fleet index

The index is mission control: it is ordered by how much of your attention a thing has
earned, not by how recently it moved. Most of a fleet is not doing anything, and almost
none of it needs you.

A header states the whole fleet in seven counts. Three of them are states a session is in —
**working**, **idle**, **parked** — three are queues drawn from those same sessions:
**asking you**, **waiting on you**, **stalled** — and one, **background**, is a reading
across all of them. The last four overlap the states rather than competing with them: idle
includes the sessions counted as waiting on you, working includes the ones counted as
asking you, since a session that stopped mid-turn to ask you something has not finished its
turn, and background is usually idle, because handing work off is exactly what ends a turn.
So those counts are not a partition and are not meant to be added to the state counts,
which is the reason each carries the definition behind it on hover.

**background** is the count for a session that is spending everything and reports nothing:
it launched a workflow or a subagent, finished the turn that launched it, and is now idle
in front of fourteen agents. Nothing is waiting on you there — Claude Code picks the
conversation back up itself when the work reports in — so those sessions are shown as
advancing and are deliberately kept out of the queue below.

Idle earns a count of its own because it is the state most of a busy machine is in. A
terminal you left open costs nothing and is running no tokens, but it is still a live
session holding a full context, and a header that omitted those read as an empty machine
to anyone with a dozen of them open.

The `?` beside the counts opens a legend that spells all of this out, quoting the current
value of every threshold it depends on rather than a number written into the prose. It
remembers whether you left it open. Beside the counts sit the tokens spent today and the
rate-limit block meter.

The badge beside the name reports the page's own connection rather than anything about your
sessions. **live** means the fleet is arriving over a socket as it changes, which is the
normal state; **offline** means that socket dropped and every number on the page is frozen
at whatever last arrived, which is the one time the badge matters. It reconnects on its own,
so **connecting** is what you see in between.

**Needs you** is a queue of everything holding for you, and it is the only band that
carries actions. Three things land in it:

| Kind | What it means | What you can do |
| --- | --- | --- |
| asking you | A live session put a question to you and stopped mid-turn for the answer | Answer, Dismiss |
| waiting on you | A live session finished its turn and is holding for a reply | Open, Dismiss |
| stalled | A live session stopped mid-turn and has not said why — usually a long command | Nudge, Open, Dismiss |

The order is longest wait first, except that questions come first as a group. Everything
else in this queue is a session that stopped and left aivis to work out why; a question is
one that said what it wants, and it is holding a turn open until it gets it. Sorting it
purely by age would file a question asked a minute ago below a terminal somebody left open
this morning, which is the wrong way round for the only item that is truly blocked.

**Answer** opens the session, where the question and its options sit above the composer.
**Nudge** sends the session the word `continue` over its message socket, the same channel
the composer uses. **Dismiss** hides that particular wait rather than the session: the id it is keyed to
carries the state, so a session that moves on and stops again comes back on its own. A
question's id is the tool call that asked it, so dismissing one question does not hide the
next. The bell in the band's header hands the same two urgent kinds to your operating
system, so you hear about them from another window — see
[Get told when a session needs you](#get-told-when-a-session-needs-you).

aivis cannot answer a permission prompt for a session running in a terminal — that terminal
owns the dialogue — so a stalled session is reported as stalled rather than dressed up as a
prompt it could accept for you. A session aivis drives is a different matter, and
[Answer a question](#answer-a-question) is about exactly that difference.

A session that finished its turn hours ago is a terminal you left open rather than a
session holding for a reply, so it drops out of the queue after `AIVIS_WAITING_WINDOW_HOURS`
and sits with its project instead, where its age says plainly how long it has been there.
A question outlasts a plain wait but not indefinitely. A session killed mid-dialogue writes
no answer and nothing else, so the question stays in its transcript for good, and aivis
attributes processes to transcripts by directory and recency rather than by identity — so a
new session started in that directory would otherwise revive a days-old question nobody can
answer and pin it to the top of the queue. A question therefore ages out on the same
`AIVIS_WAITING_WINDOW_HOURS`, which is long enough that a dialogue you actually mean to
answer is still there when you come back to it.

**Running** gives a tile to each session actually advancing: its current tool call, the
model, how much of its context window is spent, and a sparkline of tool calls a minute over
the last quarter of an hour, so a session that has gone quiet reads as quiet before its
status has caught up.

Advancing means the work, not the thread. A session that handed a workflow off is tiled
here too, with the running row saying what it launched and how long ago — its own dot still
reads **idle**, because its transcript really has stopped, and the row beside it is what is
moving. Reading the band as "sessions whose own transcript is advancing" put fourteen
agents under the terminals you left open and told you nothing was advancing at all.

**Open** lists the live sessions whose turn has finished and left nothing running — the
terminals you have open — naming the project each belongs to. They are listed rather than
tiled because none of them is doing anything worth watching: what you want from this band
is to find one, not to monitor it. Eight are shown before the rest fold away.

**Rest of the fleet** is every project, one line each, carrying only the sessions the page
has not already accounted for. Opening one lists them with the tool each last called;
ended sessions stay behind a count, and each project offers a new session in its own
directory. `resume` on a row copies `cd <cwd> && claude --resume <id>`.

Everything the page shows comes from the same sources:

| Column | Source |
| --- | --- |
| Status dot | Transcript shape plus whether a `claude` process is alive in that directory |
| Doing | The most recent tool call, summarized per tool |
| Asking you | An `AskUserQuestion` call in the transcript with no result yet, which is why it works for a session in a terminal too |
| The answer card | The pending control request the driver is holding, which is the only source that carries what an answer has to be addressed to |
| Prompts, tools, context | Accumulated from the transcript's assistant records |
| Sparkline | Tool calls counted into the minute they were made in |
| Model, age | The most recent assistant turn |

## Get told when a session needs you

The queue only works while you are reading it, and most of the time you are not — you are in
an editor, or a terminal, or another tab. Two things carry it to you instead, and they are
deliberately not the same kind of thing.

**The count on the tab** needs no permission and cannot be switched off from outside the page.
Whenever something is asking you or holding for your reply, the tab title reads `(2) aivis`
and its icon carries the same number, so a glance at the tab strip answers "is anything
waiting on me" from any other tab you have open. This is the floor the feature stands on. It
is always on and there is nothing to configure.

**A system notification** is the escalation: a banner from your operating system, which
reaches you when the browser is not even on screen. Switch it on with the bell in the header
of the **Needs you** band: struck through and warm while it is off, plain and blue once it is
on. The first click asks the browser for permission — a prompt only a click can open — and
raises one notification straight away so you can see what one looks like.

Both are fed by the same queue, and the server pushes it over the socket the page already
holds rather than the page asking for it on a timer. That matters for the case the feature
exists for: a browser throttles a hidden tab's timers to roughly once a minute and may stop
running them altogether, so anything polled is slowest exactly when the tab is in the
background and being told is the whole point.

### What raises a banner

| Kind | What the banner says |
| --- | --- |
| asking you | **project is asking you**, with the question itself underneath — or **project needs a decision** for a permission prompt, since allow-or-deny is not the same errand as writing an answer |
| waiting on you | **project finished its turn**, with the prompt the session opened with underneath, which is what tells two sessions in the same project apart |

**stalled** is deliberately not announced, and is not counted on the tab either. It means only
that a live session has gone quiet without saying why, which is as often a long command as a
problem, and a notification that cries wolf is worse than none. The queue on the page still
shows it, because being looked at is a lower bar than following you into another window.

Every banner is its own banner. An earlier version grouped them by session so a newer one
replaced the last, which is worth knowing about because of how it failed: replacing a
notification is defined to happen *quietly*, so the second and every later banner for a
session arrived with no alert at all, and nothing anywhere reported that it had been
swallowed. Clicking a banner brings the window forward with that session already open.

Nothing is announced for a session whose own page you are looking at. If session A's page is
open and the window has focus when A finishes its turn, you have just watched it happen. The
fleet page is deliberately not treated that way, even though the whole queue is on it: a row
arriving in a list is not the same as having read the list, and the index is exactly where
aivis gets left open while the work happens somewhere else.

Nothing is announced for the queue as it stood when you switched notifications on, either —
that is the state of the world rather than news. What has already been announced is remembered
across page loads for an hour, so reloading the page does not announce the same waits twice,
and, more to the point, does not quietly reset that memory and swallow the next one. The page
going away is not the same as you going away, which matters more than it sounds: a browser
will discard a background tab under memory pressure and reload it when you next click it.

### When no banner appears

aivis cannot tell whether your operating system drew a banner it raised. The browser reports
that it showed one even where there is no screen to show it on, so there is no answer to be had
by asking. Two things stand in for the answer instead: the tab count, which never depended on
the operating system in the first place, and the banner raised the moment you switch the
feature on — if that one does not appear, none of the later ones will either, and the switch's
tooltip says how many have been raised since the page loaded, so a count that climbs against an
empty screen says where the problem is not.

When the browser accepted a banner and nothing appeared, the cause is downstream of both the
page and the browser. On macOS, in the order worth checking:

1. **System Settings › Notifications › your browser** — *Allow notifications* on, and the alert
   style set to *Banners* or *Alerts* rather than *None*. A browser that is not allowed to
   present notifications still accepts every one it is given, so this fails completely
   silently, and it fails for every website at once rather than for aivis in particular.
2. **A Focus mode**, which suppresses banners per application.
3. **Screen sharing or mirroring**, which macOS treats as its own reason to go quiet — see
   *Show notifications when mirroring or sharing the display* in the same settings pane.

Two limits are worth knowing about the banners regardless. They come from the page rather than
from a server pushing to your device, so the aivis tab has to stay open — a closed tab is a
silent one, though the tab count is right there when you come back. And browsers withhold the
API from pages that are neither `https` nor `localhost`, so if you reach aivis on a LAN address
the switch is there but inert, and says why. `127.0.0.1` counts as localhost and is fine.

## The session page

Click a card to open that session at `/session/<session-id>`, a full page you can
bookmark, reload, or open in its own tab. It shows the whole conversation: your prompts,
Claude's replies, thinking collapsed behind a toggle, and every tool call as a collapsible
row with its input and its output.

Claude's replies render as markdown, including GitHub-flavored tables, so headings, lists,
code spans, and fenced blocks read the way they were written. A wide table scrolls inside
its own message rather than widening the page. Your own prompts stay as plain text, shown
exactly as you typed them, since a prompt is often literal and markdown would reformat it. The back arrow and the browser's own back button both
return to the fleet, and Escape does the same.

While a session is live the page follows new output, unless you have scrolled back, in
which case it leaves your position alone until you scroll to the end again. Scrolling up is
the only thing that stops it following — a scroll it made itself, and output arriving while
you watch, both leave you where you are — so it cannot be left stuck part-way up a session
that is still writing. The page draws the most recent 5,000 conversation
entries; `load earlier messages` quadruples that, and the server refuses a request for more
than 50,000. The whole file is streamed either way, so this is a budget on what is rendered
rather than a window on what is read.

## See what an edit changed

A transcript records an edit as its two sides — the text before and the text after — so
`Write`, `Edit`, `MultiEdit`, and `NotebookEdit` are shown as diffs rather than as the raw
tool input they used to print. Removals sit above additions in the usual colours, the
collapsed row carries the `+N −M` counts so you can see the size of a change without opening
it, and a `MultiEdit` becomes one labelled hunk per edit. Any other tool keeps its raw
input, which is the only faithful thing to show for a shape aivis does not know.

Two things go further than the terminal does:

**Changed words are marked.** Within a line that was modified, the words that actually moved
are highlighted, so a one-word change reads as a one-word change instead of two nearly
identical lines to compare by eye. The marks are dropped when they would cover more than
half the line — a rewritten sentence comes back almost entirely highlighted, which is noise,
and the `+` and `−` already say the whole line changed.

**Unchanged context folds.** Three lines are kept either side of each change and the rest
collapses to a count you can click to open, so a one-line change inside a long hunk is one
line to read rather than thirty to scroll. Nothing is hidden silently: the marker always
says how many lines it stands for.

Line numbers appear where they are actually knowable. A whole-file write is numbered from
one, which is exactly right. An edit's position in the file is not recorded in the
transcript, so those lines carry no number rather than a guessed one.

The diff is computed in the browser from data the page already has, so it costs no extra
request and nothing is stored.

## See everything the session changed

The `N files` count in the meta bar opens a fourth rail beside tools, agents and
workflows. It is the same shell — half the window, drag-resizable, one level at a time —
and it answers the question a per-edit diff cannot: what does this session add up to on
disk?

The first level lists every changed file, grouped by directory with the busiest group
first, each row carrying its status letter, its `+N −M`, and a five-cell sparkline scaled
logarithmically against the largest change in the list, so a 400-line rewrite beside a
3-line tweak reads as what it is. Filter chips narrow it to added, modified, deleted or
renamed, and a path box narrows it further. Selecting a file opens its hunks, with the
line numbers on both sides and the words that moved marked exactly as they are in a
transcript diff — the same rule, applied to lines git produced.

Opening a file does not replace the list. The rail widens to three quarters of the window
and the diff docks beside a narrow copy of the file list, so walking a review file by file
costs one click each instead of a trip back through the list. Closing the file puts the
rail back to the width it had.

Above those hunks stand the tool calls that wrote the file, one row each, carrying what the
call did, its own `+N −M`, and how long ago it ran. A row is the header of its own diff, and
selecting it does both things at once: the diff opens underneath, and the conversation moves
to the call that wrote it and opens that too. A file touched once opens with its diff
already showing, since there is nothing there to choose between.

**"Changed" needs a base, so the base is explicit and switchable.** The three answers are
genuinely different, and picking the wrong one is how a change list lies:

| Base | What it compares | Why you would pick it |
| --- | --- | --- |
| vs session start | The working tree against the last commit made before the session's first record, minus the files that were already changed when it began | What this session amounts to. It keeps working after the session commits, which `HEAD` stops doing the moment it does |
| uncommitted | The working tree against `HEAD` | What is still unstaged and unsaved, whoever wrote it |
| this session's edits | Every `Write`, `Edit`, `MultiEdit`, and `NotebookEdit` in the loaded conversation, grouped by file | What this session itself typed, attributable to the tool call that did it — and the only base that needs no repository |

The first two come from git, which is the only thing that knows what the tree looks like
now: a file removed with `rm`, or edited in a terminal beside the agent, leaves no tool
call behind. The third comes from the transcript, which knows something git cannot — which
call wrote which line. A directory outside git is offered only the third, and says so.

Everything is scoped with `--relative`, so a session running in a subdirectory of a large
repository reports its own corner of it rather than the whole tree.

Five limits worth stating, because each one is a place the list could otherwise mislead:

- Files git is not tracking yet are listed as added and counted by reading them, since
  `git diff` never mentions them. That read is capped at 400 files, and the summary says
  when the cap was hit.
- A file that was already edited, or already sitting there untracked, when the session
  began is left out of **vs session start**. The base commit alone cannot tell that work
  apart from the session's own — both differ from it — and git records no time for a
  working-tree edit, so the file's own mtime is the second anchor: anything last written
  before the session's first record was not written by it. The summary line says how many
  files that left out, and **uncommitted** still shows every one of them. A deleted file
  has no mtime left to read and stays in the list, because dropping a deletion the session
  made is the worse mistake.
- The session's own base can only report `added` and `modified`. The file-editing tools
  never delete or rename, so a status it cannot know is one it does not claim; a file
  created is told apart from one overwritten by what the `Write` tool answered.
- It also covers only the part of the conversation that is loaded, the same window the
  tools rail uses, so `load more history` widens it.
- A very large diff is cut off rather than sent whole, and says so where it stops. A file
  in an unresolved merge comes back as a combined diff, which is not read here and is
  reported rather than shown as empty.

## Send a message

The composer at the bottom of a session page sends the session another message. aivis
resumes the session as a child process with `--resume`, keeping its id and its history,
and holds standard input open so the conversation continues across messages. Replies
arrive in the page the same way any other output does, because the resumed session writes
to the same transcript file the dashboard already watches.

The input grows as you write, from one line up to two fifths of the window — comfortably
more than fifteen lines at a usual size — and scrolls past that. A long message is worth
being able to reread before sending it, which a fixed two-line slot made impossible.

A message sent while the session is working joins the turn already in progress rather than
queueing behind it: Claude Code absorbs it, and the answer comes back inside that same turn.
So the count beside the working indicator is the messages this turn took in, and it clears
when the turn reports — an absorbed message never reports a result of its own, and a count
waiting for one would never come back down.

## Reference a file

Type `@` in the composer to open a file picker for the session's working directory.
Matching works the way it does in the CLI: `@tier` finds `app/pricing/tier_resolver.py`
wherever it lives, and `@tres` finds it too, because the query is also tried as a
subsequence. Arrow keys move, Enter or Tab inserts the path, Escape dismisses.

Files come from `git ls-files` when the directory is a repository, so `.gitignore` already
keeps build output and dependencies out of the picker. Anything else falls back to `find`
with the usual heavy directories pruned. The listing is cached for 20 seconds per
directory.

Ranking prefers a filename match over a directory match, since `@tier` means the file
called that rather than everything under a folder whose name contains it, and shorter
paths win ties.

## Run a command or skill

Type `/` to open a picker of the skills and slash commands available to the session. It
gathers them from the same places the CLI does — your user commands (`~/.claude/commands`),
the project's commands (`.claude/commands`), your skills (`~/.claude/skills`) and the
project's, and the commands and skills of any enabled plugins. Sub-directories namespace a
command the way the CLI shows it, so `gsd/plan-phase.md` appears as `/gsd:plan-phase`.
Arrow keys move, Enter or Tab inserts, Escape dismisses.

The picker opens anywhere in the message, not only at its start, because naming a skill
inside a sentence — "use /graphify on this" — is a normal thing to want and the picker is
how you find the exact name. It follows the same rule as the `@` picker: the token has to
begin at a word boundary, so a URL or a path never opens it.

A name **mentioned mid-sentence** is delivered as the text you wrote, which is what makes it
a reference rather than an invocation: the session reads the name and decides. The picker
says which of the two you are doing while it is open.

What happens to a command at the start of a message depends on how aivis reaches the
session, because the two paths are not equally capable.

**A session aivis drives runs every command, built-ins included.** Its messages arrive on
standard input, which is where Claude Code parses slash commands itself — the same handling
a terminal gets. It even names the ones it takes in its init event, 88 of them on this
machine, `/effort` and `/model` and `/compact` among them. So the text goes as written and
the CLI does the work: `/effort max` sets the effort, and `/graphify ./notes` loads the skill
properly rather than through a paraphrase of it. Both the command and whatever it printed
appear in the conversation, because a command that left no trace would be indistinguishable
from one that never arrived.

**A session running in a terminal cannot.** The socket queues what arrives with slash command
parsing switched off, so a command delivered whole would land as literal text and quietly do
nothing. aivis expands it first instead — a prompt command's body inlined with its
`$ARGUMENTS` (and `$1`, `$2`, …) filled in, a skill turned into a request to invoke it, which
loads its `SKILL.md` in the live session. That covers skills and commands but not the
built-ins, which have no text to stand for: they instruct the client rather than prompt the
model. Those are dimmed in the picker and refused on send, for that session only, with a note
saying so. To run one, use the session's own terminal.

That built-in list is read out of your installed Claude Code binary, not hardcoded, so it
stays accurate as the CLI adds commands across releases. The binary is one enormous line, on
which BSD `grep` is pathologically slow, so aivis scans with the one tightly-anchored pattern
that stays fast and prefers `ripgrep` or GNU `grep` when they are present; the result is
cached and the whole set is unioned with a curated list so nothing important is ever missed.
If the binary cannot be located, that curated list stands in on its own.

## Run a shell command with `!`

Start a message with `!` and the rest of the line runs as a shell command on this machine, in
the session's own directory, exactly as `!` does in the terminal. The output does not become a
message. It is held, and it travels in front of the next thing you send:

```
!git status --short
!npm test
what broke?
```

The session receives one message — the two runs and their output, then your question — and
answers the question with the runs already in front of it.

That the output waits is the whole design rather than a shortcut. In the terminal a `!` line
never calls the model at all; the CLI runs it, writes the result into the transcript, and it
becomes context for whatever you ask next. aivis has to reproduce that over a protocol where
every message it sends to a driven session starts a turn, so sending each run immediately
would have the model reply to a `!ls` you asked it nothing about. Holding it reproduces the
terminal's behaviour exactly, and buys something the terminal does not have: because a `!`
line never touches the session, **it works while the session is mid-turn.** You can check what
a running turn has done to the working tree without interrupting it.

Runs appear in the conversation as they happen, with a dashed edge while they are still held
and a note saying where they are going. A long one — `npm test`, or the `gcloud auth login`
that waits for you to finish in a browser — shows its output when it finishes; the page
watches it rather than making you refresh. What is recorded is the same
`<bash-input>`/`<bash-stdout>`/`<bash-stderr>` shape the CLI writes, so a session handed back
to a terminal reads its history exactly as if the terminal had run the line itself.

A run that is not going to end on its own has a **stop it** under it, next to whatever it has
printed so far. A session runs one `!` command at a time, so the `gcloud auth login` whose
browser tab you closed holds that session's only slot until the timeout comes round; stopping
kills the command's whole process group and gives the slot back at once. If you discover that
by typing the next line and being told one is already running, the refusal offers to do both
at once: **stop it and run this**. Either way the stopped run is kept rather than discarded —
it travels with your next message like any other, carrying an `[aivis]` line that says it was
cut short, because a `!npm test` you stopped halfway is not a `!npm test` that passed.

A few things are worth knowing:

- **stdin is closed.** A command that stops to ask something reads EOF and fails in a second
  rather than hanging invisibly until the timeout. Commands that hand off to a browser, which
  is what `gcloud auth login` does, work fine.
- **Output is capped and the command is not.** Everything past `AIVIS_BASH_MAX_OUTPUT_KB` is
  read and dropped rather than left unread, so a `!cat` of something huge returns a truncated
  first slice instead of blocking on a full pipe. A command that outlives
  `AIVIS_BASH_TIMEOUT_SECONDS` has its whole process group killed, so a pipeline dies with the
  shell in front of it.
- **The exit status is recorded.** The CLI's format has nowhere to put one — the terminal
  showed it to you — so aivis adds a line marked `[aivis]` to the stderr block when a command
  failed, timed out, was stopped, or was truncated. Nothing else is added.
- **It runs as you, with your environment**, minus the same variables a driven session has
  stripped: `ANTHROPIC_API_KEY` and the `CLAUDE_*` session variables, so a `!claude ...` does
  not inherit this session's identity or get flipped onto API billing.
- **`-c` does not read your shell profile.** The command sees the `PATH` the daemon was
  started with, so start aivis from a shell that has the one you want.

On the default loopback bind this is offered as a matter of course. On any other bind it is
refused unless you ask for it with `AIVIS_BASH=1`, and the composer says so on the `!` you are
still typing. See the [trust model](../SECURITY.md#the-trust-model) for what that does
and does not close.

## Finish a session

**end session** on a session's page stops the `claude` process behind it, closing the CLI
and leaving the session `ended`. The transcript is untouched, so the conversation can still
be read and resumed later; only the running process goes. A session aivis drives is stopped
through its driver, and one you deliberately finish is removed from the parked registry — an
ending is not an interruption, so it does not come back ready.

The stop is a SIGTERM first, which lets Claude Code close its transcript and release its
socket the way `/exit` would; a process that ignores it is killed after three seconds. Every
pid is re-read immediately before it is signalled, so one that has already exited — and had
its number reused by the operating system — is never signalled by mistake.

There is a real limit worth stating, because it decides how this behaves. A transcript
records its working directory but never the process id that writes it, and a `claude`
process exposes neither its session id in its arguments nor its transcript in its open
files. So aivis attributes processes to sessions by matching the live processes in a
directory against the most recently active transcripts there — which is a guess, and a
visibly unstable one: end one of two sessions in a directory and the surviving pid can be
reattributed to the other transcript.

Where that guess could cost you the wrong conversation, aivis refuses rather than gambles.
Ending a session in a directory that holds more than one live session comes back as a
refusal naming every process it found, and the page asks whether to stop the one it has
attributed to this session. With a single session in the directory the attribution is
unambiguous and it just works.

## Keep sessions across a reboot

A session is alive only as long as its process, so shutting the laptop down ends every one
of them. Without a record of what was running, a conversation you were in the middle of
comes back on the next boot indistinguishable from the hundreds of transcripts you finished
months ago.

So aivis keeps one. Every session it sees alive is written to
`~/.claude/aivis-parked.json`, and a session in that file with no process is reported as
**parked** rather than ended: it keeps its place among the live sessions in the project
tables, with its own status colour and filter chip, instead of being filed away. Sending it
a message resumes it exactly as before — parking changes how a session is *presented*, never
how it is driven.

Nothing is restarted when the machine boots. Waking a session costs a process and tokens, so
it happens when you actually write to it, not because a computer powered on. That is what
makes this cheap: the registry is a few kilobytes of bookkeeping, not a supervisor.

The file is written then renamed, so a machine losing power mid-write — the exact moment
this matters — never leaves a half-written registry. Entries expire after
`AIVIS_PARK_TTL_DAYS` (14) without being seen alive, and the oldest are dropped past 400, so
it cannot grow without bound. **forget** on a parked session's page drops it back to being an
ordinary ended one, and `DELETE /api/parked` clears the lot; neither touches the transcript.

A session you deliberately exited is parked too, since from the outside that looks the same
as a machine going down. That is the intended trade — it is one click to forget, whereas a
conversation lost in the graveyard is not easily found again.

## See what is running outside the turn

A session that starts a Workflow, a subagent, or a backgrounded command is finished with
the turn that started it long before the work is. Its own status goes to **idle** — a
terminal holding for your reply — while eight agents spend tokens behind it. That was the
one thing the fleet view could not see, and the card read as the opposite of the truth.

So a session with work still outstanding carries it beside its status: the tool that started
it, how long ago, and every task on hover. It uses the same three animated bars as the
working indicator, because it is the same fact about a different thread. The index counts
those sessions under **background**, tiles them under Running, and keeps them out of the
queue — nothing is waiting on you when the session will wake itself.

On a session's own page the row goes one further, because that page has already read the
run: it says how many of the run's agents have come back, and it opens the workflow rail on
the run itself. A row that reports something is happening and then cannot be asked what is
where this started.

Nothing is read off disk for the index's part of this. Claude Code files a `<task-notification>` when the work
ends, and that notice names the tool call that started it — so a task is running when aivis
has seen its call and not its notice. Both records are in the transcript aivis already
parses. Checked against a real store, 341 notices joined to their launching call and none
failed to.

The notice is not guaranteed, though: a session killed mid-task never writes one. Two bounds
keep that from becoming a task that runs for ever. Only a session with a live process can be
running anything, and a task with no notice is given up on after
`AIVIS_TASK_WINDOW_HOURS`. On the machine this was built on those two turned twenty-five
phantom tasks, the oldest eight days old, into none.

| Tool | When it counts as background |
| --- | --- |
| `Workflow` | Always |
| `Agent`, `Task`, `SendMessage`, `Monitor` | Unless the call passes `run_in_background: false` |
| `Bash` | Only when the call passes `run_in_background: true` |

Everything else is a foreground call and is never counted. That split is measured rather
than assumed: `Bash` is over forty thousand calls in a real store and fewer than five
hundred of them background, so defaulting it the other way would put a running mark on
almost every session on the machine.

## Watch the rate-limit block

The meter beside the session's counts, and in the fleet header, shows how far into the
current rate-limit block this account is: a bar, a percentage, and the time left in the
window.

The numbers are the real ones, taken from Claude Code itself, so the meter matches what the
CLI's status line shows — including the true reset clock and, in the tooltip, your weekly
limit.

They come from two places, whichever spoke most recently. Any session aivis drives reports
them itself: Claude Code emits a `rate_limit_event` on the stream of a session started in
stream-json mode, and since limits are account-wide, one driven session reports for the
whole fleet. That needs no setup and is the freshest source there is.

The second place covers a machine whose sessions all run in terminals, where aivis drives
nothing and so hears nothing. Claude Code receives its rate-limit state from the API and
passes it to your status line command on stdin; it is written nowhere on disk. So the status
line is the one place it can be captured. Add this just after the `input=$(cat)` line of
your status line script:

```bash
_aivis_rl="$HOME/.claude/aivis-rate-limits.json"
printf '%s' "$input" \
  | jq -c '{rate_limits, captured_at: now}' > "$_aivis_rl.$$" 2>/dev/null \
  && mv -f "$_aivis_rl.$$" "$_aivis_rl" 2>/dev/null \
  || rm -f "$_aivis_rl.$$" 2>/dev/null
true
```

It writes then renames, so aivis never reads a half-written file, and every step tolerates
failure so it cannot break your status line.

A capture ages in two different ways, and they are not the same problem. One that is merely
old still describes the window you are in, so it is shown with a note that it may have moved
on. One whose reset has already passed describes a window that is over — but not uselessly,
because the windows run back to back on a fixed grid, so its reset plus five hours is the
next reset, and stepping it forward lands on the current window exactly. The clock is
therefore still right; what is gone is the percentage, because usage began again from
nothing at the reset. The meter shows the true reset time and a hatched bar reading `—`,
rather than a number it cannot stand behind.

**With neither source** aivis falls back to deriving a figure from the transcripts: usage
folded into hourly buckets and grouped into blocks of `AIVIS_BLOCK_HOURS`, drawn against
your busiest *completed* block. That fallback is marked with a `≈` and is a genuinely weaker
number — it compares you against your own history rather than a quota, and the percentage
can move when an old busy block ages out even though you spent nothing. The block in
progress is deliberately left out of its own ceiling: including it made any block that grew
past every earlier one read as exactly 100% for as long as it kept growing, which said
nothing except that it was your busiest yet. Until one block has completed there is no scale
at all, and the meter says so instead of inventing one. Set `AIVIS_BLOCK_TOKEN_LIMIT` to pin
it to a real ceiling, or better, add the line above.

## Know how full the context window is

The bar on a running tile, and the `175.2k / 1.0M context` in a session's meta bar, measure
usage against the window that session actually has. Getting that right takes work, because
a transcript never states it: a session records its model as `claude-opus-5` whether it is
running the 200k window or the 1M one, so a session holding 175k tokens used to read as 88%
full when it was in fact 18% full — a false alarm on precisely the number you would act on.

Five answers are possible, and aivis takes the strongest available, naming which one it
used when you hover the bar:

| Source | How it knows |
| --- | --- |
| reported | Claude Code's own figure, captured from your status line. Exact |
| exceeded | The session has already held more than 200k tokens, which proves the long window |
| model | The model id names it — a `[1m]` suffix, or a family such as Fable that ships at 1M and so never carries one |
| settings | Your configured default asks for the long window and this session runs that model family |
| assumed | The standard window, believed because nothing said otherwise |

Only the first is measurement. The rest are inference, which is why the tooltip says which
it is rather than presenting every bar as fact.

To get the exact figure, publish it from your status line the same way the rate-limit block
is published, keyed by session so that many terminals cannot overwrite each other:

```bash
_aivis_ctx="$HOME/.claude/aivis-context"
_aivis_sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
[ -n "$_aivis_sid" ] && mkdir -p "$_aivis_ctx" 2>/dev/null   && printf '%s' "$input" | jq -c '{context_window, captured_at: now}'        > "$_aivis_ctx/$_aivis_sid.json.$$" 2>/dev/null   && mv -f "$_aivis_ctx/$_aivis_sid.json.$$" "$_aivis_ctx/$_aivis_sid.json" 2>/dev/null   || rm -f "$_aivis_ctx/$_aivis_sid.json.$$" 2>/dev/null
true
```

Like the rate-limit capture it writes then renames, and tolerates failure at every step so
it cannot break your status line. aivis prunes captures untouched for a fortnight, and
ignores one claiming a window smaller than the session has demonstrably used, since that
is a stale file rather than a smaller window.

## Attach images

Paste an image into the composer with `Cmd+V` (`Ctrl+V` elsewhere), or drop one anywhere
on it. Thumbnails appear above the input with their size and a remove button, and a
message can be sent with images and no text at all.

The new-session sheet takes them the same way, so a session can open on a screenshot:
paste into the first prompt, or drop anywhere on the sheet. The rules below apply
identically, because both paths run the same encoder and post to the same image reader.

Images travel inline as base64 blocks in the streaming input, so nothing is written to
disk for Claude to see a screenshot. PNG, JPEG, GIF, and WebP are accepted; anything else
is refused by name rather than dropped silently.

Anything over 1.5 MB is scaled so its long edge is at most 1568 pixels and re-encoded as
JPEG, because a vision model gains nothing beyond that size while a full-resolution retina
screenshot costs tokens and upload time. Smaller images are sent byte-for-byte, so a paste
with fine text is never resampled.

Sent images render in the conversation. They are not embedded in the page: a transcript
stores them inline as base64, and a single screenshot would otherwise dominate every page
of the conversation, so each is referenced by record and fetched from
`/api/sessions/<id>/image`. Selecting one opens it full size.

A message can be a picture and no words at all, and one sent while the session is working
is filed under an attachment rather than as a user turn — two different records, both of
which used to be read for their text and dropped when there was none. A screenshot pasted
mid-turn therefore vanished from the page that sent it and went uncounted in the prompt
tally, while the session answered it perfectly well. Both readers now keep a message that
has a picture, wherever the record put it, and the prompt list marks a wordless one
`(image)` rather than drawing an empty row.

A session already running in a terminal is written to directly, over its own socket. Every
top-level Claude Code session listens on `/tmp/cc-socks/<pid>.sock` and accepts a `user`
message frame — the transport behind Claude Code's own cross-session messaging. So a
message sent from aivis lands in the live conversation, and the terminal and aivis write to
one session rather than two. This is what lets you type in both places.

The socket is mode `0600` and owned by you, so the operating system is the only gate: just
your own processes can connect, and no token is needed. aivis needs only the session's
process id, which it already knows from the fleet scan.

A session mid-turn takes the message too. It joins the session's own queue and is read at
its next opportunity, which is usually within a second even while a tool call is running,
so a busy session is one you can type at rather than one you have to wait out. `priority`
chooses between `now`, `next`, and `later`; aivis sends `next`, which is the queue
behaviour rather than barging into the middle of the turn.

What arrives, though, is a **peer message**. Claude Code tells the receiving session that
the message came from another session rather than from you, and that it carries none of
your authority — it will not treat it as approval for a pending permission prompt, and it
is told in as many words that relaying a denied action between sessions is permission
laundering. That is a boundary worth having and aivis does not try to defeat it: there is
no frame that claims the user's authority. A message that needs the weight of your own
turn belongs in the terminal, or in a session aivis drives, where it goes in over standard
input and is your turn. The composer says which of the two you are typing into.

That boundary is why answering a question works for a session aivis drives and not for one
running in a terminal. An answer is not a message at all — it is a control response on the
process's own standard input, the channel aivis holds only for processes it started — so
there is nothing to relay over the socket and no version of this that a peer message could
launder. [Answer a question](#answer-a-question) says what travels instead.

Because the socket closes without acknowledging anything, a successful write is not a
delivery. Every message carries a `uuid`, and the receiving session records it under that
same id, so aivis waits to see it in the transcript before it stops reporting the message
as in flight. One that is never picked up says so instead of being quietly forgotten —
which is also how a session whose process aivis has misidentified now shows up.

Each message names the session it is for, and the receiver drops any frame addressed to a
different one. A transcript records a working directory but never the process id that
writes it, so aivis's pid attribution is inference; the check means a wrong inference
fails to deliver rather than dropping your message into someone else's conversation. Set
`AIVIS_SOCKET_SESSION_GUARD=0` to send without it.

Attached images are written to a temporary directory and named in the message by absolute
path, because the socket accepts only plain text and expands no attachments: a frame
carrying image blocks is discarded in full and silently. The session reads them from disk.

The protocol is undocumented, so it is treated as an optimisation, not a foundation. If the
socket is missing or a message cannot be delivered — a Claude Code update changing the
protocol, say — aivis says so and offers to resume the session as a separate process
instead, the same fallback it used before. Nothing silently forks a conversation.

## Answer a question

Claude Code has a tool for asking you a multiple-choice question — `AskUserQuestion` — and
it is the thing a session stops for most often that is not a permission prompt. In a
terminal it draws a dialogue you arrow through. In `--print` mode it used to have nowhere
to appear at all: Claude Code denied the call as *no prompt available in headless mode*
and the turn carried on having silently lost whatever it stopped to ask.

A question a session aivis drives asks now appears above the composer, as a card with the
question, its options, each option's description, and any sketch the model drew of what
the option leads to. Pick one, pick several when the question allows it, or type an answer
of your own; **Answer** sends it. The index counts the session under **asking you** and its
row carries the question rather than the session's opening prompt, because the question is
the thing the row exists to get answered.

One call may carry up to four questions, and those go behind tabs the way the terminal
draws them rather than stacked down the card. Four questions with four options each is a
column in which nothing tells the eye where one question ends and the next begins, and the
`header` Claude Code sends with each question is written to be a tab label — twelve
characters at most — so the card uses it as one. Only the question you are on is drawn, so
the card stays the height of a single question however many were asked.

Picking on a single-choice question moves you to the next one still unanswered, which is
what makes four questions a few clicks rather than a scroll; a multi-select stays put,
since you may still be adding to it. Each tab carries its number until it is answered and
a tick afterwards, the bar says how many are done, and the button names a partial answer as
**Answer 2 of 4** rather than sending a subset quietly — sending one is allowed, and Claude
Code tells the model which questions went unanswered, but it should be deliberate. Arrow
keys move between tabs when one has focus.

**What travels is the tool's own input, not a message.** aivis starts the sessions it
drives with `--permission-prompt-tool stdio`, which is not a tool name but the sentinel
that tells Claude Code to put every decision it cannot make alone onto the same standard
output as everything else and wait for an answer on standard input — the channel the
Claude Agent SDK uses for its own permission callback. The session is holding the tool call
open at the other end of that request. `AskUserQuestion` reads its answers straight back
out of its own input, keyed by each question's own text, so the answer becomes the call's
input and the call returns. The model is told its questions were answered, in the same
words the terminal produces. Nothing queues, nothing resumes, and no new user turn appears
in the conversation — which is exactly why this could not be done by sending a message: a
message would wait behind the very turn that is waiting on it.

Several picked options go back as one string joined with a comma and a space, because that
is the form Claude Code's own check for *did every part of this name a real option* accepts
— the difference between the model being told its questions were answered and being told to
read a freehand reply carefully. Free text goes in the same field as a label, so answering
in your own words is not a fallback path but the same answer given differently. **Skip**
allows the call with nothing chosen, which is Claude Code's own no-answer path: the model
is told the questions went unanswered rather than that its tool failed.

**Permission prompts arrive on the same wire, so aivis answers those too.** Opting in is
all or nothing: once a session is started that way, every decision comes to aivis and one
left unanswered would leave the session waiting forever. So a tool Claude Code will not run
unasked gets a card of its own naming the tool, what it was asked to do, and why it is
asking, with **Allow once**, **Deny**, and — when Claude Code offers a permission change
alongside — **Allow, stop asking**, which applies that change so the rest of the session
stops asking the same thing. A denial carries a reason back as the tool's error, which is
worth considerably more to the model than a bare refusal.

`AIVIS_PERMISSION_MODE` still decides how much reaches you at all; it defaults to `auto`,
which approves routine work itself and asks about the rest. `AIVIS_ANSWER_ASKS=0` turns the
whole channel off and gives back the behaviour described at the top of this section — which
is worth being plain about, because it is a loss rather than a neutral choice: with no
prompt surface a decision is not deferred, it is denied, the turn carries on without it,
and there is nothing left for a terminal to pick up afterwards.

Because a session waiting on a decision writes nothing at all, the index gets its own
answer from the driver rather than from the transcript. That is what keeps a driven session
stopped at a permission prompt from going quiet for two minutes and then reporting as
**stalled** — a word that means nobody knows why it stopped, when here aivis knows exactly
why.

**Allow, stop asking** applies only the permission changes that end with the session.
Claude Code sometimes offers one that is written to the project's
`.claude/settings.local.json` instead, which would grant the same permission to every later
run in that directory, terminals included; a button in a dashboard saying *stop asking* is
understood to mean stop asking me now, so those are dropped rather than relabelled. A
standing rule is worth writing deliberately, where such rules are kept.

**A session running in a terminal cannot be answered from here.** aivis will say it is
asking you and show which question, because it reads that out of the transcript like
everything else, but the answer has to be given where it was asked: that session's
dialogue belongs to its own terminal, and the message socket carries nothing that could
stand in for it. This is the same line the stop button draws, and for the same reason.

## Stop a turn

**Stop** appears beside **send** while a session aivis drives is working, and escape does
the same thing when nothing is typed. It cuts the turn short and leaves the session open,
which is what escape does in the terminal — the transcript records the same
`[Request interrupted by user]`.

It sits beside send rather than replacing it, because a working session is one you can
type at: a message sent now queues behind the turn. Replacing send with stop would take
that away to make room for the rarer action. The two also compose — stopping a turn does
not discard what is queued behind it, because the session reports what survived and aivis
counts from that, so a queued follow-up runs as soon as the cancelled turn lets go.

Only a session aivis drives can be stopped from here. The interrupt is a control request
on the process's standard input, which aivis holds for sessions it started; a session
running in a terminal exposes no such channel, and its message socket carries no interrupt
either — it accepts messages, renames, and idle notices, and nothing that stops a turn or
answers a prompt. So for those, escape in the terminal remains the only way, and aivis says
that rather than offering a button that cannot work.

## Start a session

Two entry points. **New session** in the top bar, or `Cmd+N`, when the project is
undecided. **+ session** on a project header when it is not — that path skips the picker.

The sheet asks for a project, a branch, a model, an effort, a permission mode, and a first
prompt. Both entry points open the same sheet, so an option added there is offered by both.
Effort is how deeply the session thinks and how much it spends getting there, `low` through
`max`; left on default it takes Claude Code's own, and `/effort` changes it later either
way. It is passed as `--effort`, which the CLI ignores with a warning on a model that has no
effort setting — Haiku, for one — so a session started that way simply runs at its usual
depth.
There is no separate "create project" step, because a project is only ever a directory:
pick one aivis knows, search for it, type or paste a path, or browse for a folder. A path
that does not exist yet is created.

The model list offers full ids rather than the `opus` and `sonnet` aliases, so a session
keeps the model it was started on when an alias later moves to a newer release. Leaving it
on **default** passes no `--model` at all and lets the CLI decide — and the option names
what that decision will be, reading `ANTHROPIC_MODEL`, then the project's
`.claude/settings.local.json` and `.claude/settings.json`, then your
`~/.claude/settings.json`, in the same order the CLI reads them. Hovering it names the file
the answer came from. A managed enterprise policy sits above all of those and is not read,
so the answer is described as inherited rather than guaranteed.

A new session needs a first prompt, or an image, or both. A fresh Claude Code process stays
silent until it has work, so it never reports the session id that aivis has to wait for,
and a session opened empty would have nothing to show. A screenshot on its own counts: the
question is implied by the picture.

The first prompt takes the same [`@`](#reference-a-file) and [`/`](#run-a-command-or-skill)
pickers the composer has, keyed on the project you chose rather than on a session, since
there is not one yet: `@` lists the files in that folder and `/` the skills and commands
available there. Both stay shut until a project is chosen, because until then there is no
directory whose files could be listed. A command typed here is parsed the way it is in
every session aivis drives, built-ins included: the first prompt travels on standard input,
which is the same path a later message takes and where Claude Code reads commands itself.

Branch switching is offered only when the working tree is clean. Every session in a
directory shares one working tree, so a checkout moves the ground under any session
already running there, and a dirty tree is refused rather than stashed. Only a name the
repository already lists as a local branch is switched to, so a request naming a tag, a
commit, a remote-tracking ref, or something git would read as an option is refused rather
than passed on.

## Folder trust

Claude Code asks whether to trust a folder the first time an interactive session opens
there, and records the answer in `~/.claude.json` as
`projects.<dir>.hasTrustDialogAccepted`.

Print mode never asks, so a session aivis starts runs regardless — but the same folder
would still stop you at the prompt the moment you took it into a terminal with
`copy resume`. aivis therefore marks a folder trusted when you start a session in it. The
flag is per directory, so every later session there is covered too.

That is a write to your Claude Code config, so: the file is copied once to
`~/.claude.json.aivis-backup` before the first change, the new file is written beside the
original and renamed over it so an interrupted write cannot truncate it, and nothing but
the one flag is touched. Set `AIVIS_TRUST_NEW_PROJECTS=0` to turn it off, at the cost of
meeting the trust prompt yourself after a handoff.

## The meta bar

The strip under a session's title carries its status, model, effort, how much of the context
window is spent, and counts. A session mid-turn says so with a moving indicator rather than a
still word — three bars and a slow sweep across the label — because a still word cannot tell
you whether the session is working now or stopped an hour ago, which is the only question
that label exists to answer. The composer above the input says the same thing the same way.

Effort is read from the most recent main-thread turn, which records the level it ran at, so
it follows a `/effort` sent mid-session rather than reporting whatever the session started
with. A subagent's turns are skipped: they are routinely dispatched at a lower effort, and
reading one back would report the session as having dropped. Nothing is shown for a session
whose model has no effort setting, or one old enough not to have recorded it.

| Count | What it counts |
| --- | --- |
| prompts | Messages you sent, whether typed into the terminal or sent from here. Claude's replies and tool results are not counted, so this is how many times you spoke, not how many exchanges happened. Neither is Claude Code's own bookkeeping: a slash command, its output, an injected reminder, a `!` bash line, and the notification a finished background task posts are all filed as user records, and none of them is something you said |
| tools | Tool calls the session made |
| agents | Subagents it launched |
| workflows | Workflow runs it recorded |
| files | Files changed against the current base, which the rail lets you switch |

A `≥` before a count means the real number is higher than shown, because the transcript
was too large to read in full. On the fleet index those counts are also tinted, so a
partial number is visible without reading the symbol. The pill beside the counts gives the file size and says
`counts partial`; hovering it explains what is exact and what is not.

Selecting `prompts`, `tools`, `agents`, `workflows`, or `files` opens that list in a rail
beside the conversation; selecting it again closes the rail. In the tool list, selecting a
call jumps the conversation to it and opens it, rather than repeating its input and output
in the rail. The prompt list works the same way and is numbered, because a long session is
navigated by what was asked rather than by what was done, and prompts are scattered thinly
enough through a thousand tool calls to be genuinely hard to find by scrolling.

Both lists cover the part of the conversation that is loaded. A session holding images
or long outputs fills the read window quickly, so `load more history` widens it. That is
why the count in the rail can start well below the count in the meta bar.

## Hide what you are not reading

At the right of the meta bar sit checkboxes for `tools`, `subagents`, and `workflows`. They
take that machinery out of the conversation, leaving the prompts and the replies — which is
often all you want when catching up on what a session decided rather than how it went about
it.

Each entry belongs to exactly one of the three, so hiding one never leaves half an excursion
behind: a tool call a subagent made belongs to that subagent rather than to the tools, and
the `Task` call that started it goes with them. A line at the end of the conversation says
how many entries are hidden, so an emptied page is never a mystery.

Only the groups a session actually has are offered, and the choice is remembered across
sessions and reloads. Hiding changes nothing but the reading: the counts in the bar and the
lists in the rail still cover everything.

## Agents and workflows

The `N agents` and `N workflows` counts in the meta bar open the rail beside the
conversation. It stays shut until you ask for it: opening a session by its link gives you
the conversation, scrolled to where it has got to, and nothing else. The running row beside
the session's status opens it too, on the run that is still going — which is the run you
came to look at, so the tab opens on it rather than on a list to pick from.

While something is running outside the turn the rail is re-read every few seconds. Nothing
else on the page needs a timer, because everything else refetches when the session's last
activity moves; a handed-off run moves nothing, so it is the one case where waiting for the
transcript means watching a page that has stopped asking.

Subagents stay a flat list — no phases and no roll-up, because a session launches a
handful of them rather than dozens. They are grouped by state, running first, and each
card leads with what the agent is doing right now.

Selecting one opens it beside the list rather than in place of it: its objective, its tool
calls, and whatever it has said so far, with the list still there on the left so moving
between two agents that are running at once is a single click. The conversation moves with
it, to the `Agent` call that launched the agent. An agent counts as running while its own
transcript is still advancing and the parent session is alive, and as failed when the
parent's `Agent` call came back an error.

Each of those tool calls opens the way a call in the conversation does — the command it
ran and the output that came back, an edit as a diff. This is the only place they can be
read: an agent writes its own transcript, and its calls never appear in the parent's, so
there is nothing in the conversation for them to link to. They are read from that
transcript when the detail is opened rather than shipped with the agent list, where sixty
agents' worth of command output would be megabytes nobody asked for.

Workflows are navigated one level at a time, because a 74-agent run is unreadable as a
single list.

| Level | Shows |
| --- | --- |
| Run | Elapsed, agents finished, tools, tokens, a progress bar split into done, running, failed, and queued, any failures pulled to the top, whatever is running right now, then the phases |
| Phase | The phase's own goal and progress, filter chips for failed and running, and its agents rolled up into tasks |
| Agent | Verdict, confidence, reasoning, and evidence read out of its result, with its prompt, raw result, and the other agents that ran the same task |

Agents roll up into tasks by dropping the instance suffix from the label, so
`verify:deadcode:0` through `:3` become one `verify:deadcode` row carrying four agents.
That is what turns a phase of 60 agents into 13 readable rows.

The agent level is the one that docks rather than replaces. The rail widens to three
quarters of the window and every agent in the phase stands in a narrow list on the left,
grouped under the task it ran and carrying its one-line verdict, so comparing what three
verifiers said about the same claim is a matter of moving down the list. Because the agent
is a selection rather than a level, the breadcrumb stops at the phase and the back arrow is
only needed to leave the phase entirely.

Selecting a failure or a running agent jumps straight to it, and the run's own name links
back to the `Workflow` call that started it, where the script is. Breadcrumbs and the back
arrow walk back up, and the rail itself is drag-resizable from its left edge, with the
width remembered per browser. Dragging while a detail is docked is taken as the width you
want and survives closing it; otherwise closing restores the width from before.

A finished run is read from the single JSON file it writes when it ends, and everything
shown about its agents comes from the previews recorded there. Those previews are opening
extracts, so a structured result usually stops mid-object and will not parse as JSON.
Fields are read out of it anyway, and a value recovered from a cut-short result ends in an
ellipsis. Two things that file does not record at all: the cost of an agent, and the list
of tool calls it made beyond the last one.

That file is written when the run ends, which used to mean the one run worth watching was
the one run aivis could not see. A run still going is read from the directory it is filling
instead — the journal it keeps for resuming, which names every agent it started and every
one that came back, and the transcript each agent writes as it works. From those it reports
how many agents are back, what each one still going is doing right now, and the run's name
and goal, read from the script the Workflow tool wrote beside it.

What it cannot report is the shape the script gave the run. The label and phase of each
agent live in the run's own state and are filed only at the end, so a live run numbers its
agents by when they started and lists no phases, and the rail says so on the run itself.
Its totals are the same figures the finished file will report — each agent's context rather
than a running sum, so they do not lurch when the run files — but they count only the
agents read, which is capped at 40, tail-first, with whatever is still running read before
whatever has finished.

A run's directory alone cannot say whether the run is still going: one killed halfway
leaves the same files as one working. The session's transcript can, and it is the same
pairing the running row is drawn from — a `Workflow` call with no completion notice is a
run that has not ended. So a run whose call is still outstanding reports as running, and
one whose notice has been filed without a JSON file beside it reports as **stopped**, with
the agents that never came back marked cancelled rather than left advancing for ever.

Subagents and workflows are separate things recorded in separate places, so all three are
read: subagent transcripts from `<session-id>/subagents/`, finished runs from
`<session-id>/workflows/`, and a run still going from
`<session-id>/subagents/workflows/<run-id>/`.

Status means:

- **working** — a live process, with the transcript advancing. The only state spending
  tokens, and the state a session holding an open question keeps: its turn has not ended,
  and it is queued as **asking you** rather than left to age into stalled.
- **stalled** — a live process, but nothing written for `AIVIS_STALE_AFTER_SECONDS` and no
  question on record to explain it. Usually a long-running command, or a session in a
  terminal holding at a prompt only that terminal can answer.
- **idle** — a live process whose last turn ended: a terminal left open, holding its whole
  context and carrying on the moment you write to it. Unless it ended that turn by handing
  the work off, which the index counts as **background** — not a state of its own, since
  the session really is idle, but the reason it is shown as advancing rather than queued.
- **parked** — no process, but aivis saw this session alive before. Sending to it resumes
  it where it stopped.
- **ended** — no live process and no record of one. Resume it to continue.

The index says the same thing in prose behind the `?` in its header, so these definitions
live in two places on purpose: here for someone reading the repository, and there for
someone looking at a number they do not recognise.

