import type { Branch, FileChange, FileState } from '../types'

export type Status = {
  branch: string | null
  commit: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: FileChange[]
}

export type Counts = Record<string, { added: number | null; deleted: number | null }>

// Fixed fields before the path in each `git status --porcelain=v2` entry
const FIELDS: Record<string, number> = { '1': 8, '2': 9, u: 10 }

function rest(entry: string, fields: number): string {
  return entry.split(' ').slice(fields).join(' ')
}

function stateOf(xy: string): FileState {
  const [index = '.', worktree = '.'] = xy

  if (index !== '.' && worktree !== '.') {
    return 'both'
  }

  return index !== '.' ? 'staged' : 'unstaged'
}

function letterOf(xy: string): string {
  const [index = '.', worktree = '.'] = xy

  return index !== '.' ? index : worktree
}

// Reads `git status --porcelain=v2 --branch -z`
export function parseStatus(output: string): Status {
  const status: Status = { branch: null, commit: null, upstream: null, ahead: 0, behind: 0, files: [] }
  const entries = output.split('\0')

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? ''
    const kind = entry[0]

    if (entry.startsWith('# branch.oid ')) {
      const oid = entry.slice(13)
      status.commit = oid === '(initial)' ? null : oid.slice(0, 7)
    } else if (entry.startsWith('# branch.head ')) {
      const head = entry.slice(14)
      status.branch = head === '(detached)' ? null : head
    } else if (entry.startsWith('# branch.upstream ')) {
      status.upstream = entry.slice(18)
    } else if (entry.startsWith('# branch.ab ')) {
      const [ahead = '+0', behind = '-0'] = entry.slice(12).split(' ')
      status.ahead = Math.abs(Number(ahead))
      status.behind = Math.abs(Number(behind))
    } else if (kind === '?') {
      status.files.push({ path: entry.slice(2), from: null, letter: '?', state: 'untracked', added: null, deleted: null })
    } else if (kind === '1' || kind === '2' || kind === 'u') {
      const xy = entry.slice(2, 4)
      const path = rest(entry, FIELDS[kind] ?? 8)
      // A rename's previous path is the next NUL-separated entry
      const from = kind === '2' ? (entries[++i] ?? null) : null
      const isConflict = kind === 'u'

      status.files.push({
        path,
        from,
        letter: isConflict ? 'U' : letterOf(xy),
        state: isConflict ? 'conflict' : stateOf(xy),
        added: null,
        deleted: null,
      })
    }
  }

  return status
}

// Reads `git diff --numstat -z`, keyed by the file's current path
export function parseNumstat(output: string): Counts {
  const counts: Counts = {}
  const parts = output.split('\0')

  for (let i = 0; i < parts.length; i++) {
    const [added, deleted, path] = (parts[i] ?? '').split('\t')

    if (added === undefined || deleted === undefined || path === undefined) {
      continue
    }

    // A rename has an empty path, followed by the old and the new path
    const key = path === '' ? ((i += 2), parts[i] ?? '') : path
    const isBinary = added === '-'

    counts[key] = { added: isBinary ? null : Number(added), deleted: isBinary ? null : Number(deleted) }
  }

  return counts
}

// Lines in a new file, or null when it looks binary
export function countLines(text: string): number | null {
  if (text.includes('\0')) {
    return null
  }

  if (text === '') {
    return 0
  }

  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

export function withCounts(files: FileChange[], counts: Counts): FileChange[] {
  return files.map(file => {
    const count = counts[file.path]

    return count ? { ...file, ...count } : file
  })
}

export function totals(files: FileChange[]): { added: number; deleted: number } {
  return files.reduce(
    (sum, file) => ({ added: sum.added + (file.added ?? 0), deleted: sum.deleted + (file.deleted ?? 0) }),
    { added: 0, deleted: 0 },
  )
}

export const BRANCH_FORMAT = '%(HEAD)%09%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)%09%(committerdate:relative)'

// Reads `git for-each-ref refs/heads --format=BRANCH_FORMAT`
export function parseBranches(output: string): Branch[] {
  return output
    .split('\n')
    .filter(line => line.includes('\t'))
    .map(line => {
      const [head = '', name = '', upstream = '', track = '', updated = ''] = line.split('\t')

      return {
        name,
        upstream: upstream || null,
        ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
        behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
        isGone: track === 'gone',
        isCurrent: head === '*',
        updated,
      }
    })
}

export function since(then: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - then) / 60000))

  if (minutes < 1) {
    return 'just now'
  }

  if (minutes < 60) {
    return `${minutes} min ago`
  }

  const hours = Math.round(minutes / 60)

  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

// The owner and repository of a remote URL: scp-like SSH, ssh:// or https://
export function parseRemote(url: string): { owner: string; name: string } | null {
  const path = url
    .trim()
    .replace(/^[a-z+]+:\/\/[^/]+\//i, '')
    .replace(/^[^@/:]+@[^:]+:/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  const parts = path.split('/').filter(Boolean)
  const name = parts.pop()
  const owner = parts.pop()

  return owner && name && !url.startsWith('/') ? { owner, name } : null
}

export function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? path
}
