import type { BackgroundTask } from '../../shared/types.ts'
import { age } from '../format.ts'

/**
 * Work a session handed off to run outside its own turn.
 *
 * This exists because such a session reads as doing nothing. The turn that launched a
 * workflow ends the moment the work is accepted, so the session's own status goes to
 * `idle` — a terminal holding for your reply — while eight agents spend tokens behind it.
 * The card said `idle` next to the busiest thing on the machine, which is exactly backwards
 * and is the one case the fleet view was blind to.
 *
 * The tool is named rather than the count of agents inside it, because the count is only
 * knowable by reading the run's own files, and the whole point of this signal is that it
 * costs nothing: it is two records of a transcript aivis has already parsed. What each task
 * is doing is on hover, where a line per task can be as long as it needs to be.
 */
export function RunningTasks({
  tasks,
  step = null,
  onOpen,
}: {
  tasks: BackgroundTask[]
  /**
   * How far along the work has got, for a caller that has read it.
   *
   * The transcript says a workflow is running and nothing more, which is all the index can
   * afford to know. A page that has already read the run itself knows how many of its
   * agents have come back, and that is the difference between "something is happening" and
   * knowing whether to wait for it.
   */
  step?: string | null
  /** Where the work can be watched, on a page with somewhere to send you. */
  onOpen?: () => void
}): React.JSX.Element | null {
  const first = tasks[0]
  if (!first) return null

  // One task names its tool; several name how many, since a row has no space for a list and
  // the tools are usually the same one anyway.
  const label = tasks.length === 1 ? first.tool.toLowerCase() : `${tasks.length} tasks`
  const detail = tasks
    .map((task) => `${task.tool}${task.detail ? ` · ${task.detail}` : ''} — started ${age(task.at)} ago`)
    .join('\n')
  const title = `Still running outside this session's own turn:\n\n${detail}`

  const body = (
    <>
      <span className="working__bars" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {label}
      {step ? <span className="running__step">{step}</span> : null}
      {/* The oldest task's age, which is how long the session has had something outstanding. */}
      <span className="running__since">{age(first.at)}</span>
    </>
  )

  // On the index this sits inside the button that opens the session, so it stays a plain
  // span there: the row already goes somewhere, and a button inside a button is not markup.
  if (!onOpen) {
    return (
      <span className="running" title={title}>
        {body}
      </span>
    )
  }
  return (
    <button
      className="running running--go"
      title={`${title}\n\nOpen the run and watch it.`}
      onClick={onOpen}
    >
      {body}
    </button>
  )
}
