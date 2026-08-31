# Internals

How aivis reads the files Claude Code writes, what that costs it in accuracy, and which
undocumented interfaces it leans on. Read this before you trust a number on the page, and
after a Claude Code update breaks something.

## How it reads sessions

Claude Code appends one JSON record per event to
`~/.claude/projects/<project-slug>/<session-id>.jsonl`. aivis tails those files by byte
offset, so a change event parses only what was appended rather than re-reading the file.

Transcripts grow large. On the machine aivis was written on, a single session reached
108 MB and roughly a third of the store was over the default limit; your own store will
differ, but the shape does not. So any file above `AIVIS_FULL_PARSE_MAX_MB` is read at both
ends instead of in full: its first and last 512 KB.

The head supplies the opening prompt and start time. The tail supplies current activity and
status. The middle is skipped, and the read offset is left at the end of the file, so
everything appended from that moment on is parsed exactly.

The consequence is narrow. Status, current activity, and last-activity time are exact,
because they come from the tail. Model, branch, diff size, agents, and workflows are
unaffected, because none of them come from counting records. Only the prompt and tool
counts are lower bounds, and those are shown with a `≥` and a pill giving the file size.

Raise `AIVIS_FULL_PARSE_MAX_MB` to read more files in full, at the cost of a slower first
scan.

## Known limits

A transcript records its working directory but not the process id writing it, and several
sessions often share a directory. aivis matches live processes to the most recently active
transcripts in each directory, one each. That is right whenever the running sessions are
also the recently active ones, and wrong when you leave an old session parked in a
directory where you have since started new ones.

Untracked files are not counted in the diff size, because listing them costs more and a
file the agent has not staged is rarely what you are reviewing.

A question asked in the skipped middle of a sampled transcript is not seen. The tail is
where status and current activity come from and it is read exactly, so a question that is
still open is in it — the gap only matters for a transcript that grew past
`AIVIS_FULL_PARSE_MAX_MB` between the question and now, which takes half a megabyte of
writing while a turn is stopped waiting.

`--permission-prompt-tool stdio` is what carries a question to the browser, and it is an
undocumented sentinel rather than a published interface. If a Claude Code update stops
accepting it, sessions aivis drives will fail to start rather than quietly losing their
questions, and `AIVIS_ANSWER_ASKS=0` is the way back. `scripts/ask-probe.mjs` proves the
whole exchange against a throwaway session, which is how to tell whether it is still true;
[Compatibility](#compatibility) lists the other interfaces aivis leans on the same way.

## Compatibility

aivis is a third-party client for files and sockets that Claude Code writes for its own
use. None of them is a published interface, and Claude Code ships often, so this is the part
of the project most likely to break through no fault of its own.

It was built against **Claude Code 2.x**. What it depends on, in rough order of how much
would break if it changed:

| What | Used for | If it changes |
| --- | --- | --- |
| The transcript store at `~/.claude/projects/<slug>/<id>.jsonl` | Everything. The fleet, statuses, transcripts, diffs, agents | aivis shows an empty fleet |
| The record shapes inside those files | Titles, tool calls, token counts, questions | Fields go blank; aivis renders what it recognises and omits what it does not, rather than guessing |
| The message socket at `/tmp/cc-socks/<pid>.sock` | Sending a message into a session running in a terminal | The composer falls back to resuming the session as a second process |
| `--permission-prompt-tool stdio` | Routing a driven session's questions to the browser | Sessions aivis starts fail to start. `AIVIS_ANSWER_ASKS=0` is the way back |
| `~/.claude.json` | Marking a folder trusted so a handed-off session does not stop at the trust prompt | The terminal asks you to trust the folder, as it would have anyway |
| The CLI bundle's embedded command list | The `/` command picker | The picker offers built-in commands it found nowhere and falls back to what is on disk |

Where a dependency is undocumented, aivis prefers to fail visibly over failing quietly:
a driven session that cannot get its prompt tool refuses to start rather than silently
dropping every question it would have asked. `scripts/ask-probe.mjs` exercises that whole
exchange against a throwaway session, which is how to find out whether it still holds after
an update — see `scripts/README.md`.

If an update breaks something here, please open an issue with your `claude --version`.

