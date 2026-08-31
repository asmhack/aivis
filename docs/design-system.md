# Design system

aivis's visual design is kept as a set of standalone previews in `design/`, so it can be
edited in a Claude Design design-system project and brought back.

```bash
npm run design:build      # regenerate design/dist from web/styles.css
npm run design:preview    # build, then serve them on http://127.0.0.1:4321
```

`web/styles.css` stays the single source of truth. Each template in `design/src` names the
stylesheet sections it needs:

```html
<!-- @dsCard group="Fleet" name="Session card" -->
<!-- @styles: Status dots, Groups, Card, Card interaction -->
```

The generator splits `web/styles.css` on its own comment headers and inlines only the
requested sections, so a preview is self-contained and carries one component's rules. That
split is what makes the round trip work: a change made to a preview in Claude Design maps
back to exactly one section of the stylesheet, rather than to an ambiguous copy of the
whole file.

A section header is a one-line comment **followed by a blank line**; a one-line comment
sitting directly above the rules it explains is prose and stays inside its section. The gap
is the only thing that separates them, so write `/* Docked detail */` with a blank line
under it when you mean a new section, and no blank line when you are explaining the rule
below. The build also warns when a preview uses a class its requested sections never
define, which is how you find out that a preview is rendering unstyled rather than by
squinting at it.

| Preview | Group | Covers |
| --- | --- | --- |
| `colors.html` | Foundations | Every colour token, grouped by role |
| `type.html` | Foundations | The type scale, sans and mono |
| `status.html` | Foundations | Status dots, vitals counts, project tallies, pills |
| `mission-control.html` | Fleet | The whole index: queue, tiles, fleet list |
| `fleet-header.html` | Fleet | The vitals bar |
| `session-header.html` | Session | Title block and the meta bar |
| `transcript.html` | Session | Prompts, replies, rendered markdown, tables |
| `tool-calls.html` | Session | Tool entries collapsed and expanded, rail rows |
| `rail.html` | Session | The workflows tab: run, phase, and the docked agent detail |
| `subagents.html` | Session | The agents tab: the flat list and the docked agent detail |
| `changes.html` | Session | The files tab: the file list and the docked diff |
| `composer.html` | Session | Composer idle, working, and in conflict |
| `ask.html` | Session | The answer card: a question, a multi-select, and a permission prompt |

Previews are fragments rather than whole documents, but each declares
`<meta charset="utf-8" />` on its second line, after the `@dsCard` marker that has to stay
first. Without it a host that serves them without a charset renders `·` as `Â·`.

