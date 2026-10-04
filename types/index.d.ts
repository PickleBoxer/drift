// How a file differs from HEAD: staged, unstaged, both, untracked or conflicted
export type FileState = 'staged' | 'unstaged' | 'both' | 'untracked' | 'conflict'

export type FileChange = {
  path: string
  // The previous path of a rename or copy
  from: string | null
  // One status letter: M, A, D, R, C, T, U or ?
  letter: string
  state: FileState
  // Null for binary files
  added: number | null
  deleted: number | null
}

export type Repo = {
  root: string
  name: string
  // The owner on the origin remote's host, such as a GitHub user or organization
  owner: string | null
  // Null when HEAD is detached
  branch: string | null
  // Short commit id, null before the first commit
  commit: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: FileChange[]
  added: number
  deleted: number
  // When the last fetch finished, from FETCH_HEAD
  fetchedAt: number | null
}

export type Branch = {
  name: string
  upstream: string | null
  ahead: number
  behind: number
  // The upstream branch was deleted on the remote
  isGone: boolean
  isCurrent: boolean
  // When its last commit was made, as git words it ("3 days ago")
  updated: string
}

export type Tab = 'changes' | 'branches'

declare module 'claude-code' {
  interface PluginState {
    drift: {
      repo: Repo | null
      branches: Branch[]
      tab: Tab
      // The file whose diff the Changes tab shows
      selected: string | null
      diff: string | null
      // The branch waiting for the person to confirm the switch
      confirm: string | null
      // A refusal or error shown in the pane
      notice: string | null
    }
  }
}
