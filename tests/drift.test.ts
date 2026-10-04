import type { On, RenderElement } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { countLines, parseBranches, parseNumstat, parseStatus, since } from '../hooks/git'

const NOW = new Date(2026, 9, 4, 12, 0).getTime()
const ROOT = '/Users/me/dev/project'
const SCROLL = { offset: 0, bodyRows: 10 }
const BAND = { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 140, scroll: SCROLL, view: {} }
const PANE = { title: 'drift', isFocused: true, bodyColumns: 100, placement: 'dock' as const, scroll: SCROLL, view: {} }

const STATUS = [
  '# branch.oid 0f4595fc69cb0564f52b243dad020188fe852d1c',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -1',
  '1 .M N... 100644 100644 100644 aaa bbb README.md',
  '1 A. N... 000000 100644 100644 000 ccc bin/new tool',
  '2 R. N... 100644 100644 100644 ddd eee R100 hooks/next.ts',
  'hooks/old.ts',
  '? notes.txt',
  '',
].join('\0')

const NUMSTAT = ['29\t1\tREADME.md', '51\t0\tbin/new tool', '0\t0\t', 'hooks/old.ts', 'hooks/next.ts', ''].join('\0')

const BRANCHES = [
  '*\tmain\torigin/main\tahead 2, behind 1\t2 hours ago',
  ' \tfeature\torigin/feature\tgone\t3 days ago',
  ' \tspike\t\t\t5 weeks ago',
].join('\n')

type Answers = { status?: string; isRepo?: boolean }

// Stands in for git, the file system and the session beneath the mod
function seed(on: On, answers: Answers = {}): string[][] {
  const calls: string[][] = []
  const isRepo = answers.isRepo ?? true

  mock.clock(on, { now: NOW })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: { command: 'drift' } }))
  on('session.cwd', async () => ({ value: ROOT }))
  on('fs.stat', async (_$, e) => ({
    value: { kind: 'file' as const, size: 12, mtimeMs: e.path.endsWith('FETCH_HEAD') ? NOW - 5 * 60000 : NOW, isLink: false },
  }))
  on('fs.read', async () => ({ value: 'one\ntwo\nthree\n' }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('process.run', async (_$, e) => {
    const argv = e.argv.filter(arg => arg !== '--no-optional-locks')
    calls.push(argv)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const [, command, flag] = argv

    if (!isRepo) {
      return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    }

    if (command === 'rev-parse') {
      return ok(flag === '--show-toplevel' ? `${ROOT}\n` : `${ROOT}/.git\n`)
    }

    if (command === 'status') {
      return ok(answers.status ?? STATUS)
    }

    if (command === 'diff') {
      const path = argv[argv.length - 1]

      return ok(argv.includes('--numstat') ? NUMSTAT : `diff --git a/${path} b/${path}\n+added ${path}\n-removed line\n`)
    }

    if (command === 'for-each-ref') {
      return ok(BRANCHES)
    }

    return ok('')
  })

  return calls
}

// Stands in for what the engine draws when the mod passes
function engineDraws(on: On): void {
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)

    return h(Text, {}, 'engine') as RenderElement
  })
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
}

describe('git', () => {
  test('reads branch, tracking and every kind of change from status', async () => {
    const status = parseStatus(STATUS)

    expect(status).toMatchObject({ branch: 'main', commit: '0f4595f', upstream: 'origin/main', ahead: 2, behind: 1 })
    expect(status.files.map(file => [file.letter, file.state, file.path])).toEqual([
      ['M', 'unstaged', 'README.md'],
      ['A', 'staged', 'bin/new tool'],
      ['R', 'staged', 'hooks/next.ts'],
      ['?', 'untracked', 'notes.txt'],
    ])
    expect(status.files[2]?.from).toBe('hooks/old.ts')
  })

  test('reads a detached HEAD and a repository without commits', async () => {
    expect(parseStatus('# branch.oid abcdef1234\0# branch.head (detached)\0')).toMatchObject({ branch: null, commit: 'abcdef1' })
    expect(parseStatus('# branch.oid (initial)\0# branch.head main\0')).toMatchObject({ branch: 'main', commit: null })
  })

  test('reads line counts, renames and binary files from numstat', async () => {
    expect(parseNumstat(NUMSTAT)).toEqual({
      'README.md': { added: 29, deleted: 1 },
      'bin/new tool': { added: 51, deleted: 0 },
      'hooks/next.ts': { added: 0, deleted: 0 },
    })
    expect(parseNumstat('-\t-\timage.png\0')).toEqual({ 'image.png': { added: null, deleted: null } })
  })

  test('counts lines of new files and skips binary ones', async () => {
    expect(countLines('a\nb\n')).toBe(2)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('')).toBe(0)
    expect(countLines('a\0b')).toBe(null)
  })

  test('reads branches with tracking', async () => {
    expect(parseBranches(BRANCHES)).toEqual([
      { name: 'main', upstream: 'origin/main', ahead: 2, behind: 1, isGone: false, isCurrent: true, updated: '2 hours ago' },
      { name: 'feature', upstream: 'origin/feature', ahead: 0, behind: 0, isGone: true, isCurrent: false, updated: '3 days ago' },
      { name: 'spike', upstream: null, ahead: 0, behind: 0, isGone: false, isCurrent: false, updated: '5 weeks ago' },
    ])
  })

  test('words how long ago a fetch was', async () => {
    expect(since(NOW - 20000, NOW)).toBe('just now')
    expect(since(NOW - 5 * 60000, NOW)).toBe('5 min ago')
    expect(since(NOW - 3 * 3600000, NOW)).toBe('3 h ago')
    expect(since(NOW - 72 * 3600000, NOW)).toBe('3 days ago')
  })
})

describe('band', () => {
  test('shows folder, branch, tracking and changes in the terminal', async ($, on) => {
    seed(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'drift', surface: 'terminal', component: 'AbovePrompt', props: BAND })

    expect(await ui.find({ key: 'folder', type: 'Button' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'project' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'main' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '↑2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '↓1' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: '4 files' })).toBeDefined()
    // 29 + 51 tracked lines, 3 lines in the untracked file
    expect(await ui.find({ type: 'Text', text: '+83' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '-1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '❐' })).toBeDefined()
  })

  test('draws Nerd Font icons when asked', { options: { terminalIcons: 'nerd' } }, async ($, on) => {
    seed(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'drift', surface: 'terminal', component: 'AbovePrompt', props: BAND })

    expect(await ui.find({ type: 'Text', text: '' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '⎇' })).toBeUndefined()
  })

  test('hides the changes when the tree is clean', async ($, on) => {
    seed(on, { status: '# branch.oid abc1234\0# branch.head main\0' })
    await start($)
    const ui = await $.ui.mount({ plugin: 'drift', surface: 'terminal', component: 'AbovePrompt', props: BAND })

    expect(await ui.find({ type: 'Button', text: 'main' })).toBeDefined()
    expect(await ui.find({ key: 'diff' })).toBeUndefined()
  })

  test('draws nothing outside a repository', async ($, on) => {
    seed(on, { isRepo: false })
    engineDraws(on)
    await start($)
    const terminal = await $.ui.mount({ plugin: 'drift', surface: 'terminal', component: 'AbovePrompt', props: BAND })

    expect(await terminal.find({ key: 'folder' })).toBeUndefined()
    expect(await terminal.find({ type: 'Text', text: 'engine' })).toBeDefined()
  })

  test('the desktop app keeps its own header', async ($, on) => {
    seed(on)
    engineDraws(on)
    await start($)
    const desktop = await $.ui.mount({ plugin: 'drift', surface: 'desktop', component: 'AbovePrompt', props: BAND })

    expect(await desktop.find({ key: 'folder' })).toBeUndefined()
    expect(await desktop.find({ type: 'Text', text: 'engine' })).toBeDefined()
  })

  test('the folder opens in Finder', async ($, on) => {
    const calls = seed(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'drift', surface: 'terminal', component: 'AbovePrompt', props: BAND })

    await ui.press({ key: 'folder' })

    expect(calls).toContainEqual(['open', ROOT])
  })
})

describe('pane', () => {
  test('lists changes and shows a file diff', async ($, on) => {
    seed(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'drift', surface: 'terminal', component: 'Pane', requestId: 'drift', props: PANE })

    expect(await ui.find({ type: 'Button', text: 'hooks/old.ts → hooks/next.ts' })).toBeDefined()
    await ui.press({ key: 'file:README.md' })

    expect(await ui.find({ type: 'Text', text: '+added README.md' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+added notes.txt' })).toBeUndefined()
    await ui.press({ key: 'all-files' })

    expect(await ui.find({ type: 'Text', text: '+added notes.txt' })).toBeDefined()
  })

  test('opens on every diff stacked when several files changed', async ($, on) => {
    seed(on)
    await start($)
    await $.command.run({ command: 'drift', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    const ui = await $.ui.mount({ plugin: 'drift', surface: 'terminal', component: 'Pane', requestId: 'drift', props: PANE })

    for (const path of ['README.md', 'bin/new tool', 'hooks/next.ts', 'notes.txt']) {
      expect(await ui.find({ type: 'Text', text: `+added ${path}` })).toBeDefined()
    }

    expect(await ui.find({ key: 'all-files' })).toBeUndefined()
  })

  test('opens on the diff of a single changed file', async ($, on) => {
    seed(on, { status: '# branch.oid abc1234\0# branch.head main\0? notes.txt\0' })
    await start($)
    await $.command.run({ command: 'drift', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    const ui = await $.ui.mount({ plugin: 'drift', surface: 'terminal', component: 'Pane', requestId: 'drift', props: PANE })

    expect(await ui.find({ type: 'Text', text: '+added notes.txt' })).toBeDefined()
    expect(await ui.find({ key: 'all-files' })).toBeUndefined()
  })

  test('refuses to switch branches with uncommitted changes', async ($, on) => {
    const calls = seed(on)
    await start($)
    await $.command.run({ command: 'drift', args: 'branches', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    const ui = await $.ui.mount({ plugin: 'drift', surface: 'terminal', component: 'Pane', requestId: 'drift', props: PANE })

    await ui.press({ key: 'branch:spike' })

    expect(await ui.find({ key: 'confirm-switch' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Commit or stash your 3 changed files before switching to spike.' })).toBeDefined()
    expect(calls.some(argv => argv[1] === 'switch')).toBe(false)
  })

  test('switches branches after confirming on a clean tree', async ($, on) => {
    const calls = seed(on, { status: '# branch.oid abc1234\0# branch.head main\0? scratch.txt\0' })
    await start($)
    await $.command.run({ command: 'drift', args: 'branches', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    const ui = await $.ui.mount({ plugin: 'drift', surface: 'terminal', component: 'Pane', requestId: 'drift', props: PANE })

    expect(await ui.find({ type: 'Text', text: 'Last fetched 5 min ago. drift never fetches by itself.' })).toBeDefined()
    await ui.press({ key: 'branch:feature' })
    expect(calls.some(argv => argv[1] === 'switch')).toBe(false)
    await ui.press({ key: 'confirm-switch' })

    expect(calls).toContainEqual(['git', 'switch', 'feature'])
  })
})
