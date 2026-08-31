import { useEffect, useMemo, useRef, useState } from 'react'
import type { DefaultModel } from '../../shared/types.ts'
import { homePath } from '../format.ts'
import { isImageFile, readImageFile, sizeLabel, type Attachment } from '../images.ts'
import { MentionMenus, useMentions } from '../mentions.tsx'

/** A project aivis already knows, offered in the picker. */
interface KnownProject {
  cwd: string
  name: string
  live: number
  lastActivityAt: string
}

interface BrowseEntry {
  name: string
  path: string
  isRepo: boolean
}

interface BranchState {
  isRepo: boolean
  current: string | null
  branches: string[]
  clean: boolean
}

/**
 * Models this Claude Code build accepts, every one checked against the CLI.
 *
 * Full ids are used rather than the `opus` / `sonnet` aliases, so a session keeps the
 * model it was started on when the aliases move to a newer release. The `[1m]` suffix
 * selects the 1M-context variant; Fable 5 is already 1M, so it has no suffixed form.
 *
 * A model the CLI does not recognise fails quietly — the session starts and then reports
 * that the model may not exist — which is why nothing goes in this list unverified.
 */
const MODEL_GROUPS: { label: string; options: { value: string; label: string }[] }[] = [
  {
    label: 'Opus',
    options: [
      { value: 'claude-opus-5', label: 'Opus 5' },
      { value: 'claude-opus-5[1m]', label: 'Opus 5 · 1M' },
      { value: 'claude-opus-4-8', label: 'Opus 4.8' },
      { value: 'claude-opus-4-7', label: 'Opus 4.7' },
      { value: 'claude-opus-4-6', label: 'Opus 4.6' },
    ],
  },
  {
    label: 'Fable',
    options: [{ value: 'claude-fable-5', label: 'Fable 5 · 1M' }],
  },
  {
    label: 'Sonnet',
    options: [
      { value: 'claude-sonnet-5', label: 'Sonnet 5' },
      { value: 'claude-sonnet-5[1m]', label: 'Sonnet 5 · 1M' },
      { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    ],
  },
  {
    label: 'Haiku',
    options: [{ value: 'claude-haiku-4-5', label: 'Haiku 4.5' }],
  },
]

/**
 * Read a raw model setting back as a name.
 *
 * The value in your settings is whatever you typed there — a full id, or an alias such as
 * `opus[1m]` that the CLI resolves at launch. A list lookup answers the first case; the
 * second is prettified rather than resolved, because guessing which release an alias
 * currently points at would be inventing an answer aivis does not have.
 */
function modelLabel(value: string): string {
  for (const group of MODEL_GROUPS) {
    const known = group.options.find((option) => option.value === value)
    if (known) return known.label
  }
  const long = value.endsWith('[1m]')
  const bare = (long ? value.slice(0, -4) : value).replace(/^claude-/, '')
  const [family, ...version] = bare.split('-')
  const name = family ? family.charAt(0).toUpperCase() + family.slice(1) : bare
  const number = version.length > 0 ? ` ${version.join('.')}` : ''
  return `${name}${number}${long ? ' · 1M' : ''}`
}

const PERMISSIONS = [
  { value: '', label: 'default' },
  { value: 'auto', label: 'auto' },
  { value: 'acceptEdits', label: 'acceptEdits' },
  { value: 'bypassPermissions', label: 'bypass' },
  { value: 'plan', label: 'plan' },
]

/**
 * How deeply the session thinks, and how much it spends doing so.
 *
 * Left on default the session takes Claude Code's own, which is what the terminal would
 * give it. The levels are the CLI's, in its order; `/effort` changes it later either way.
 * `ultracode` sits last because it is not a sixth level but `xhigh` plus permission to run
 * dynamic multi-agent workflows, which can spend a great deal more than the level alone.
 */
const EFFORTS = [
  { value: '', label: 'default' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
  { value: 'ultracode', label: 'ultracode' },
]

/** True when the text looks like a path the user typed rather than a name to search for. */
function looksLikePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('~') || value.startsWith('./')
}

function baseName(dir: string): string {
  return dir.replace(/\/+$/, '').split('/').pop() || dir
}

/**
 * Start a session, in a project aivis already knows or in a folder it has never seen.
 *
 * There is no separate "create project" step: a project is only ever a directory, so
 * picking or typing a folder that does not exist yet creates it and starts there.
 */
export function NewSessionSheet({
  preselected,
  onClose,
  onStarted,
}: {
  /** Working directory to start with, when opened from a project header. */
  preselected: string | null
  onClose: () => void
  onStarted: (sessionId: string) => void
}): React.JSX.Element {
  const [projects, setProjects] = useState<KnownProject[]>([])
  const [cwd, setCwd] = useState<string | null>(preselected)
  const [picking, setPicking] = useState(preselected === null)
  const [search, setSearch] = useState('')
  const [browsePath, setBrowsePath] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState<{ path: string; parent: string | null; entries: BrowseEntry[] } | null>(null)

  const [branches, setBranches] = useState<BranchState | null>(null)
  const [branch, setBranch] = useState('')
  const [model, setModel] = useState('')
  const [permissionMode, setPermissionMode] = useState('')
  const [effort, setEffort] = useState('')
  const [prompt, setPrompt] = useState('')

  const [images, setImages] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const [inherited, setInherited] = useState<DefaultModel | null>(null)

  const [starting, setStarting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  /*
   * The same `@` and `/` pickers the composer has, pointed at the folder rather than at a
   * session, because there is no session yet — this is the prompt that will start one.
   * They stay shut until a project is chosen, since until then there is no directory whose
   * files and skills could be listed.
   */
  const mentions = useMentions({
    target: cwd ? { cwd } : null,
    text: prompt,
    setText: setPrompt,
    inputRef: promptRef,
  })

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/projects')
        if (!response.ok) return
        const body = (await response.json()) as { projects: KnownProject[] }
        setProjects(body.projects)
      } catch {
        setProjects([])
      }
    })()
  }, [])

  // Branches belong to the chosen directory, so they are re-read whenever it changes.
  useEffect(() => {
    setBranches(null)
    setBranch('')
    if (!cwd) return
    void (async () => {
      try {
        const response = await fetch(`/api/projects/branches?cwd=${encodeURIComponent(cwd)}`)
        if (!response.ok) return
        const body = (await response.json()) as BranchState
        setBranches(body)
        setBranch(body.current ?? '')
      } catch {
        setBranches(null)
      }
    })()
  }, [cwd])

  // The inherited model depends on the directory too, since a project can override it.
  useEffect(() => {
    void (async () => {
      try {
        const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
        const response = await fetch(`/api/defaults${query}`)
        if (!response.ok) return
        const body = (await response.json()) as { model: DefaultModel }
        setInherited(body.model)
      } catch {
        setInherited(null)
      }
    })()
  }, [cwd])

  useEffect(() => {
    if (browsePath === null) {
      setBrowsing(null)
      return
    }
    void (async () => {
      try {
        const response = await fetch(`/api/browse?path=${encodeURIComponent(browsePath)}`)
        if (!response.ok) return
        setBrowsing((await response.json()) as typeof browsing)
      } catch {
        setBrowsing(null)
      }
    })()
  }, [browsePath])

  useEffect(() => {
    if (!picking) promptRef.current?.focus()
  }, [picking])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // An open picker takes the first Escape. Losing the whole sheet — and the prompt
      // written into it — because a file menu happened to be open is never what that key
      // was reaching for.
      if (event.key === 'Escape' && !mentions.open) onClose()
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void start()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return projects.slice(0, 8)
    return projects
      .filter((p) => p.name.toLowerCase().includes(needle) || p.cwd.toLowerCase().includes(needle))
      .slice(0, 8)
  }, [projects, search])

  const typedPath = looksLikePath(search.trim()) ? search.trim() : null
  // A screenshot on its own is a real first prompt — "what is wrong with this?" is implied
  // by the image — so an attachment counts the same as typed text.
  const ready = cwd !== null && (prompt.trim().length > 0 || images.length > 0) && !starting

  /** Stage image files from a paste or a drop, the same way the composer does. */
  const attach = async (files: File[]): Promise<void> => {
    const usable = files.filter(isImageFile)
    if (usable.length === 0) {
      if (files.length > 0) setFailure('Only PNG, JPEG, GIF, and WebP images can be attached.')
      return
    }
    setFailure(null)
    for (const file of usable) {
      try {
        const attachment = await readImageFile(file)
        setImages((current) => [...current, attachment])
      } catch (err) {
        setFailure(String(err))
      }
    }
  }

  const choose = (dir: string): void => {
    setCwd(dir)
    setPicking(false)
    setBrowsePath(null)
    setSearch('')
  }

  const start = async (): Promise<void> => {
    if (!cwd || (!prompt.trim() && images.length === 0) || starting) return
    setStarting(true)
    setFailure(null)
    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd,
          prompt: prompt.trim(),
          model: model || undefined,
          permissionMode: permissionMode || undefined,
          effort: effort || undefined,
          branch: branch && branch !== branches?.current ? branch : undefined,
          images: images.map((image) => ({
            mediaType: image.mediaType,
            data: image.data,
            name: image.name,
          })),
        }),
      })
      const body = (await response.json()) as { sessionId?: string; error?: string }
      if (!response.ok || !body.sessionId) {
        setFailure(body.error ?? `server returned ${response.status}`)
        return
      }
      onStarted(body.sessionId)
    } catch (err) {
      setFailure(String(err))
    } finally {
      setStarting(false)
    }
  }

  const known = cwd ? projects.find((p) => p.cwd === cwd) : undefined
  const dirty = branches?.isRepo === true && !branches.clean

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className={`sheet ${dragging ? 'sheet--drag' : ''}`}
        onClick={(event) => event.stopPropagation()}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(event) => {
          // Leaving for a child element still counts as being inside the sheet.
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          setDragging(false)
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          setDragging(false)
          void attach([...event.dataTransfer.files])
        }}
      >
        <header className="sheet__head">
          <span className="sheet__title">New session</span>
          <span className="sheet__esc">esc</span>
        </header>

        <div className="sheet__body">
          <div className="pfield pfield--proj">
            <span className="pfield__label">Project</span>
            <button className={`pick ${cwd ? '' : 'pick--empty'}`} onClick={() => setPicking(!picking)}>
              <span className="pick__name">{cwd ? (known?.name ?? baseName(cwd)) : 'Choose a project'}</span>
              <span className="pick__path">{cwd ? <i>{homePath(cwd)}</i> : null}</span>
              <span className="pick__chev">{picking ? '▴' : '▾'}</span>
            </button>

            {picking ? (
              <div className="picker">
                <input
                  className="picker__search"
                  placeholder="Search projects, or paste a folder path"
                  value={search}
                  autoFocus
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && typedPath) {
                      event.preventDefault()
                      choose(typedPath)
                    }
                  }}
                />

                {browsing ? (
                  <>
                    <p className="picker__group">{homePath(browsing.path)}</p>
                    <div className="picker__list">
                      {browsing.parent ? (
                        <button className="pitem" onClick={() => setBrowsePath(browsing.parent)}>
                          <span className="pitem__name">../</span>
                          <span className="pitem__path" />
                          <span className="pitem__n">up</span>
                        </button>
                      ) : null}
                      {browsing.entries.map((entry) => (
                        <button
                          key={entry.path}
                          className="pitem"
                          onClick={() => setBrowsePath(entry.path)}
                          onDoubleClick={() => choose(entry.path)}
                        >
                          <span className="pitem__name">{entry.name}</span>
                          <span className="pitem__path" />
                          <span className="pitem__n">{entry.isRepo ? 'repo' : ''}</span>
                        </button>
                      ))}
                    </div>
                    <div className="picker__foot">
                      <button className="picker__browse" onClick={() => choose(browsing.path)}>
                        Use {homePath(browsing.path)}
                      </button>
                      <p className="picker__note">
                        Open a folder to go into it. Use this one to start here.
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    {typedPath ? (
                      <>
                        <p className="picker__group">Folder</p>
                        <div className="picker__list">
                          <button className="pitem pitem--on" onClick={() => choose(typedPath)}>
                            <span className="pitem__name">{baseName(typedPath)}</span>
                            <span className="pitem__path">
                              <i>{typedPath}</i>
                            </span>
                            <span className="pitem__n">use</span>
                          </button>
                        </div>
                      </>
                    ) : null}
                    <p className="picker__group">Recent</p>
                    <div className="picker__list">
                      {matches.map((project) => (
                        <button key={project.cwd} className="pitem" onClick={() => choose(project.cwd)}>
                          <span className="pitem__name">{project.name}</span>
                          <span className="pitem__path">
                            <i>{homePath(project.cwd)}</i>
                          </span>
                          <span className="pitem__n">{project.live > 0 ? `${project.live} live` : ''}</span>
                        </button>
                      ))}
                    </div>
                    <div className="picker__foot">
                      <button className="picker__browse" onClick={() => setBrowsePath('~')}>
                        Choose a folder…
                      </button>
                      <p className="picker__note">
                        Any folder works. One aivis has not seen before starts a new project, and is
                        created if it does not exist.
                      </p>
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </div>

          <div className="opts">
            <label className="opt">
              <span className="opt__label">Branch</span>
              <select
                className="opt__val"
                value={branch}
                disabled={!branches?.isRepo || dirty}
                title={
                  !branches?.isRepo
                    ? 'not a git repository'
                    : dirty
                      ? 'the working tree has uncommitted changes, so the branch cannot be switched'
                      : 'every session in this folder shares one working tree'
                }
                onChange={(event) => setBranch(event.target.value)}
              >
                {branches?.isRepo ? (
                  branches.branches.map((name) => <option key={name}>{name}</option>)
                ) : (
                  <option value="">—</option>
                )}
              </select>
            </label>
            <label className="opt">
              <span className="opt__label">Model</span>
              <select
                className="opt__val"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                title={
                  inherited?.value
                    ? `default is ${modelLabel(inherited.value)} (${inherited.value}), inherited from ${inherited.source}`
                    : 'Leave on default to inherit the model from your Claude Code settings'
                }
              >
                <option value="">
                  {inherited?.value ? `default · ${modelLabel(inherited.value)}` : 'default'}
                </option>
                {MODEL_GROUPS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="opt">
              <span className="opt__label">Effort</span>
              <select
                className="opt__val"
                value={effort}
                onChange={(event) => setEffort(event.target.value)}
                title="How deeply the session thinks and how much it spends getting there. Leave on default to take Claude Code's own; /effort changes it later either way."
              >
                {EFFORTS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="opt">
              <span className="opt__label">Permissions</span>
              <select
                className="opt__val"
                value={permissionMode}
                onChange={(event) => setPermissionMode(event.target.value)}
              >
                {PERMISSIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="pfield">
            <span className="pfield__label">First prompt</span>
            {images.length > 0 ? (
              <div className="attachments">
                {images.map((image) => (
                  <div
                    key={image.id}
                    className="attachment"
                    title={`${image.name} · ${sizeLabel(image.bytes)}`}
                  >
                    <img className="attachment__thumb" src={image.previewUrl} alt={image.name} />
                    <span className="attachment__size">{sizeLabel(image.bytes)}</span>
                    <button
                      className="attachment__remove"
                      onClick={() => setImages((current) => current.filter((i) => i.id !== image.id))}
                      aria-label={`Remove ${image.name}`}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="pfield__box">
              <MentionMenus mentions={mentions} flush />
              <textarea
                ref={promptRef}
                className="prompt"
                placeholder="What should this session do?  / for a command, @ for a file — or drop a screenshot in."
                value={prompt}
                onChange={(event) => {
                  setPrompt(event.target.value)
                  mentions.detect(event.target.value, event.target.selectionStart ?? 0)
                }}
                onClick={(event) => mentions.detect(prompt, event.currentTarget.selectionStart ?? 0)}
                onBlur={() => setTimeout(mentions.close, 120)}
                onKeyDown={(event) => {
                  mentions.keyDown(event)
                }}
                onPaste={(event) => {
                  const files = [...event.clipboardData.files]
                  if (files.length === 0) return
                  event.preventDefault()
                  void attach(files)
                }}
              />
            </div>
          </div>
        </div>

        {dragging ? <div className="sheet__drop">drop to attach</div> : null}

        <footer className="sheet__foot">
          <span className={`sheet__hint ${failure ? 'sheet__hint--bad' : ''}`}>
            {failure ??
              (starting
                ? 'starting…'
                : dirty
                  ? 'branch locked: uncommitted changes in this folder'
                  : 'starts detached — closing the window leaves it running')}
          </span>
          <button className="sheet__cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`sheet__start ${ready ? '' : 'sheet__start--off'}`}
            disabled={!ready}
            onClick={() => void start()}
          >
            Start session<span>⌘↵</span>
          </button>
        </footer>
      </div>
    </div>
  )
}
