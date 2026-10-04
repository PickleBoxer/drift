import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FileChange, Repo, Tab } from '../types'
import { BRANCH_FORMAT, basename, countLines, parseBranches, parseNumstat, parseRemote, parseStatus, since, totals, withCounts } from './git'

const PANE = 'drift'
const TICK_MS = 5000
// Untracked files counted line by line, and the largest one read
const MAX_UNTRACKED = 200
const MAX_UNTRACKED_BYTES = 1024 * 1024
const MAX_DIFF_LINES = 1000
// Tools that can change the working tree or move HEAD
const WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])

const repoAtom = atom({ plugin: 'drift', key: 'repo' } as const, null)
const branchesAtom = atom({ plugin: 'drift', key: 'branches' } as const, [])
const tabAtom = atom({ plugin: 'drift', key: 'tab' } as const, 'changes')
const selectedAtom = atom({ plugin: 'drift', key: 'selected' } as const, null)
const diffAtom = atom({ plugin: 'drift', key: 'diff' } as const, null)
const confirmAtom = atom({ plugin: 'drift', key: 'confirm' } as const, null)
const noticeAtom = atom({ plugin: 'drift', key: 'notice' } as const, null)

// Plain symbols for any font, and Nerd Font icons: fa-folder, powerline branch, oct-diff
const ICONS = {
  plain: { folder: '❐', branch: '⎇', diff: '±' },
  nerd: { folder: '', branch: '', diff: '' },
}

const LETTER_COLOR: Record<string, string> = { A: 'green', '?': 'green', D: 'red', U: 'red', R: 'cyan', C: 'cyan' }

type Git = { ok: boolean; stdout: string; stderr: string }

async function git($: EngineInterface, cwd: string, args: string[]): Promise<Git> {
  try {
    // Optional locks off, so polling never fights a git command the person runs
    const { exitCode, stdout, stderr } = await $.process.run(['git', '--no-optional-locks', ...args], { cwd, timeoutMs: 10000 })

    return { ok: exitCode === 0, stdout, stderr }
  } catch {
    return { ok: false, stdout: '', stderr: 'git could not run' }
  }
}

async function untrackedLines($: EngineInterface, root: string, path: string): Promise<number | null> {
  try {
    const stat = await $.fs.stat(`${root}/${path}`)

    if (stat.kind !== 'file' || stat.size > MAX_UNTRACKED_BYTES) {
      return null
    }

    return countLines(await $.fs.read(`${root}/${path}`))
  } catch {
    return null
  }
}

async function fetchedAt($: EngineInterface, cwd: string): Promise<number | null> {
  const gitDir = await git($, cwd, ['rev-parse', '--absolute-git-dir'])

  try {
    return gitDir.ok ? (await $.fs.stat(`${gitDir.stdout.trim()}/FETCH_HEAD`)).mtimeMs : null
  } catch {
    return null
  }
}

async function loadRepo($: EngineInterface): Promise<Repo | null> {
  const cwd = await $.session.cwd()
  const top = await git($, cwd, ['rev-parse', '--show-toplevel'])

  if (!top.ok) {
    return null
  }

  const root = top.stdout.trim()
  const status = parseStatus((await git($, root, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'])).stdout)
  // Before the first commit there is no HEAD, so count what is staged
  const numstat = await git($, root, status.commit ? ['diff', '--numstat', '-z', 'HEAD'] : ['diff', '--numstat', '-z', '--cached'])
  const counts = parseNumstat(numstat.stdout)
  let untracked = 0

  for (const file of status.files) {
    if (file.state === 'untracked' && untracked++ < MAX_UNTRACKED) {
      const lines = await untrackedLines($, root, file.path)
      counts[file.path] = { added: lines, deleted: lines === null ? null : 0 }
    }
  }

  const files = withCounts(status.files, counts)
  const origin = await git($, root, ['remote', 'get-url', 'origin'])
  const remote = origin.ok ? parseRemote(origin.stdout) : null

  return {
    root,
    name: remote?.name ?? basename(root),
    owner: remote?.owner ?? null,
    branch: status.branch,
    commit: status.commit,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    files,
    ...totals(files),
    fetchedAt: await fetchedAt($, root),
  }
}

let isRefreshing = false

async function refresh($: EngineInterface): Promise<void> {
  if (isRefreshing) {
    return
  }

  isRefreshing = true

  try {
    const before = await read($, repoAtom)
    const repo = await loadRepo($)
    await update($, repoAtom, () => repo)

    // Keep a diff on screen current, without rereading it when nothing changed
    if ((await read($, diffAtom)) !== null && JSON.stringify(before?.files) !== JSON.stringify(repo?.files)) {
      const selected = await read($, selectedAtom)
      const isGone = selected !== null && !repo?.files.some(file => file.path === selected)
      await (selected === null || isGone ? loadAllDiffs($) : loadDiff($, selected))
    }
  } finally {
    isRefreshing = false
  }
}

async function loadBranches($: EngineInterface): Promise<void> {
  const repo = await read($, repoAtom)
  const output = repo ? await git($, repo.root, ['for-each-ref', 'refs/heads', `--format=${BRANCH_FORMAT}`]) : null

  await update($, branchesAtom, () => (output?.ok ? parseBranches(output.stdout) : []))
}

function diffColor(line: string): string | undefined {
  if (line.startsWith('+++') || line.startsWith('---')) {
    return undefined
  }

  return line.startsWith('+') ? 'green' : line.startsWith('-') ? 'red' : line.startsWith('@@') ? 'cyan' : undefined
}

async function fileDiff($: EngineInterface, repo: Repo, file: FileChange): Promise<string> {
  const base = repo.commit ? ['HEAD'] : ['--cached']
  const args =
    file.state === 'untracked'
      ? ['diff', '--no-color', '--no-index', '--', '/dev/null', file.path]
      : ['diff', '--no-color', ...base, '--', ...(file.from ? [file.from] : []), file.path]
  // --no-index exits 1 when the files differ, so read the output either way
  const { stdout, stderr } = await git($, repo.root, args)

  return stdout || stderr
}

// One file's diff, or with no path every file's, stacked in the order of the list
async function loadDiff($: EngineInterface, path: string | null): Promise<void> {
  const repo = await read($, repoAtom)

  if (!repo) {
    return
  }

  const files = path === null ? repo.files.slice(0, MAX_UNTRACKED) : repo.files.filter(file => file.path === path)
  const parts: string[] = []

  for (const file of files) {
    parts.push(await fileDiff($, repo, file))
  }

  await update($, selectedAtom, () => path)
  await update($, diffAtom, () => parts.join('').trimEnd() || 'No textual changes.')
}

// What the Changes tab opens on: the single changed file, or all of them
async function loadAllDiffs($: EngineInterface): Promise<void> {
  const repo = await read($, repoAtom)
  const only = repo?.files.length === 1 ? (repo.files[0]?.path ?? null) : null

  await loadDiff($, only)
}

async function openPane($: EngineInterface, tab: Tab): Promise<void> {
  await update($, tabAtom, () => tab)
  await update($, noticeAtom, () => null)

  if (tab === 'branches') {
    await loadBranches($)
  } else {
    await loadAllDiffs($)
  }

  await $.ui.open({ id: PANE, title: 'drift', closeOnEscape: true, focus: true })
}

async function openFolder($: EngineInterface): Promise<void> {
  const repo = await read($, repoAtom)

  if (repo) {
    await $.process.run(['open', repo.root])
  }
}

async function askSwitch($: EngineInterface, branch: string): Promise<void> {
  const repo = await read($, repoAtom)
  const changed = repo?.files.filter(file => file.state !== 'untracked').length ?? 0

  if (changed > 0) {
    await update($, confirmAtom, () => null)
    await update($, noticeAtom, () => `Commit or stash your ${changed} changed file${changed === 1 ? '' : 's'} before switching to ${branch}.`)

    return
  }

  await update($, noticeAtom, () => null)
  await update($, confirmAtom, () => branch)
}

async function switchBranch($: EngineInterface): Promise<void> {
  const branch = await read($, confirmAtom)
  const repo = await read($, repoAtom)

  if (!branch || !repo) {
    return
  }

  const result = await git($, repo.root, ['switch', branch])

  await update($, confirmAtom, () => null)
  await update($, noticeAtom, () => (result.ok ? null : result.stderr.trim() || `Could not switch to ${branch}.`))
  await refresh($)
  await loadBranches($)

  if (result.ok) {
    $.ui.toast(`Switched to ${branch}`)
  }
}

async function summary($: EngineInterface): Promise<string> {
  const repo = await read($, repoAtom)

  if (!repo) {
    return 'Not a git repository.'
  }

  const head = repo.branch ?? `detached at ${repo.commit ?? 'nothing'}`
  const track = repo.upstream ? `, ${repo.ahead} ahead and ${repo.behind} behind ${repo.upstream}` : ', no upstream'
  const changes = repo.files.length
    ? `${repo.files.length} changed file${repo.files.length === 1 ? '' : 's'}, +${repo.added} -${repo.deleted}`
    : 'working tree clean'

  return `${repo.owner ? `${repo.owner}/` : ''}${repo.name} on ${head}${track}. ${changes}.`
}

export const register: Register = (on, options) => {
  const icons = ICONS[options.terminalIcons === 'nerd' ? 'nerd' : 'plain']
  const showOwner = options.showOwner !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'drift',
      description: 'Show uncommitted changes and branches of this repository',
      argumentHint: '[changes|branches]',
    })
    await refresh($)
    $.clock.every(TICK_MS, () => void refresh($))

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)

    if (WRITERS.has(e.tool)) {
      void refresh($)
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    void refresh($)

    return next(e)
  })

  on('command.run', { command: 'drift' }, async ($, e) => {
    await refresh($)
    await openPane($, e.args.trim() === 'branches' ? 'branches' : 'changes')

    // Shown where nothing draws, such as the VS Code panel or claude -p
    return { text: await summary($) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const repo = await read($, repoAtom)
    const tab = await read($, tabAtom)
    const notice = await read($, noticeAtom)

    if (!repo) {
      return <Text dimColor>Not a git repository.</Text>
    }

    const header = (
      <Box key="tabs" flexDirection="row" gap={1}>
        <Button
          key="tab-changes"
          label={`Changes (${repo.files.length})`}
          hotkey="c"
          variant={tab === 'changes' ? 'primary' : undefined}
          onPress={() => void openPane($, 'changes')}
        />
        <Button
          key="tab-branches"
          label="Branches"
          hotkey="b"
          variant={tab === 'branches' ? 'primary' : undefined}
          onPress={() => void openPane($, 'branches')}
        />
        <Button key="finder" label="Open in Finder" hotkey="o" onPress={() => void openFolder($)} />
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void refresh($).then(() => loadBranches($))} />
      </Box>
    )

    if (tab === 'branches') {
      const branches = await read($, branchesAtom)
      const confirm = await read($, confirmAtom)
      const now = await $.clock.now()

      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Box key="branches" flexDirection="column">
            {branches.map(branch => (
              <Box key={`row-${branch.name}`} flexDirection="row" gap={1}>
                <Text color={branch.isCurrent ? 'green' : undefined}>{branch.isCurrent ? '●' : ' '}</Text>
                {branch.isCurrent ? (
                  <Text bold>{branch.name}</Text>
                ) : (
                  <Button key={`branch:${branch.name}`} plain label={branch.name} onPress={() => void askSwitch($, branch.name)} />
                )}
                {branch.ahead > 0 && <Text color="green">↑{branch.ahead}</Text>}
                {branch.behind > 0 && <Text color="yellow">↓{branch.behind}</Text>}
                <Text dimColor wrap="truncate">
                  {branch.isGone ? `${branch.upstream} gone` : (branch.upstream ?? 'no upstream')} · {branch.updated}
                </Text>
              </Box>
            ))}
          </Box>
          {confirm && (
            <Box key="confirm" flexDirection="row" gap={1}>
              <Text>Switch to</Text>
              <Text bold>{confirm}</Text>
              <Text>?</Text>
              <Button key="confirm-switch" label="Switch" hotkey="y" variant="primary" autoFocus onPress={() => void switchBranch($)} />
              <Button key="confirm-cancel" label="Cancel" hotkey="n" onPress={() => void update($, confirmAtom, () => null)} />
            </Box>
          )}
          {notice && <Text color="yellow">{notice}</Text>}
          <Text dimColor>
            {repo.fetchedAt ? `Last fetched ${since(repo.fetchedAt, now)}` : 'Never fetched'}. drift never fetches by itself.
          </Text>
        </Box>
      )
    }

    const selected = await read($, selectedAtom)
    const diff = await read($, diffAtom)
    const all = (diff ?? '').split('\n')
    const lines = all.slice(0, MAX_DIFF_LINES)

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {repo.files.length === 0 && <Text dimColor>Working tree clean.</Text>}
        <Box key="files" flexDirection="column">
          {repo.files.map(file => (
            <Box key={`row-${file.path}`} flexDirection="row" gap={1}>
              <Text color={LETTER_COLOR[file.letter] ?? 'yellow'}>{file.letter}</Text>
              <Button
                key={`file:${file.path}`}
                plain
                label={file.from ? `${file.from} → ${file.path}` : file.path}
                dimColor={selected !== null && selected !== file.path}
                onPress={() => void loadDiff($, file.path)}
              />
              {file.added === null ? (
                <Text dimColor>binary</Text>
              ) : (
                <Text>
                  <Text color="green">+{file.added}</Text> <Text color="red">-{file.deleted}</Text>
                </Text>
              )}
              <Text dimColor>{file.state}</Text>
            </Box>
          ))}
        </Box>
        {selected !== null && repo.files.length > 1 && (
          <Button key="all-files" label="All files" hotkey="a" onPress={() => void loadDiff($, null)} />
        )}
        {diff && repo.files.length > 0 && (
          <Box key="diff" flexDirection="column">
            {lines.map((line, index) => (
              <Text
                key={`line-${index}`}
                wrap="truncate"
                color={diffColor(line)}
                bold={line.startsWith('diff ')}
                dimColor={/^(index |new file|deleted file|similarity|rename |--- |\+\+\+ )/.test(line)}
              >
                {line || ' '}
              </Text>
            ))}
            {all.length > MAX_DIFF_LINES && <Text dimColor>{all.length - MAX_DIFF_LINES} more lines. Press a file to see only its diff.</Text>}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const repo = await read($, repoAtom)

    // The desktop app draws its own header with the same details
    if (e.surface !== 'terminal' || e.props.hasSurvey || !repo) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const isCompact = e.props.bodyColumns < 80
    const head = repo.branch ?? repo.commit ?? 'no commits'
    const count = repo.files.length

    return (
      <Box flexDirection="row" gap={2} paddingLeft={1}>
        <Box key="folder" flexDirection="row" gap={1}>
          <Text color="cyan">{icons.folder}</Text>
          <Box flexDirection="row">
            {showOwner && repo.owner && !isCompact && <Text dimColor>{repo.owner}/</Text>}
            <Button key="folder" plain label={repo.name} onPress={() => void openFolder($)} />
          </Box>
        </Box>
        <Box key="branch" flexDirection="row" gap={1}>
          <Text color="magenta">{icons.branch}</Text>
          <Button key="branch" plain label={head} onPress={() => void openPane($, 'branches')} />
          {repo.ahead > 0 && <Text color="green">↑{repo.ahead}</Text>}
          {repo.behind > 0 && <Text color="yellow">↓{repo.behind}</Text>}
        </Box>
        {count > 0 && (
          <Box key="diff" flexDirection="row" gap={1}>
            <Text color="yellow">{icons.diff}</Text>
            <Button key="diff" plain label={isCompact ? `${count}` : `${count} file${count === 1 ? '' : 's'}`} onPress={() => void openPane($, 'changes')} />
            <Text color="green">+{repo.added}</Text>
            <Text color="red">-{repo.deleted}</Text>
          </Box>
        )}
      </Box>
    )
  })
}
