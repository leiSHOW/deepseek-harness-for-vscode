import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import type { ExecFileOptions } from 'node:child_process'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type * as vscode from 'vscode'

const execFileAsync = promisify(execFile)

export type ExecResult = { stdout: string; stderr: string }

/** One worktree owned by one session: the session's sandbox root (cwd). */
export interface WorktreeRecord {
  readonly sessionId: string
  /** The repository the worktree was created from (`.git` lives here). */
  readonly repoRoot: string
  /** Branch the worktree was split from (typically `main`/`master`). */
  readonly baseBranch: string
  /** The isolated branch, always `dsh/<sessionId>`. */
  readonly branch: string
  /** Absolute path of the worktree working tree. */
  readonly worktreePath: string
  readonly createdAt: number
}

/** Result of preparing a session working directory (A2 isolation). */
export interface WorktreePreparation {
  /** The cwd to hand the new session: the worktree when isolated, else the shared base. */
  readonly cwd: string
  readonly isolated: boolean
  readonly record?: WorktreeRecord
  /** Human-readable reason when isolation could not be established. */
  readonly reason?: string
}

export interface MergeOutcome {
  readonly ok: boolean
  readonly message: string
}

export interface DiscardOutcome {
  readonly ok: boolean
  readonly message: string
}

/** Injectable git runner so tests never touch a real repository. */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<ExecResult>

const REGISTRY_KEY = 'dsh.worktrees.v1'

/**
 * Per-session git worktree isolation (plan A2).
 *
 * Every new session gets its own worktree checked out on a dedicated branch
 * `dsh/<sessionId>`, and that worktree path becomes the session cwd. Because
 * the DSH workspace-write sandbox fences writes under the session cwd, each
 * session's sandbox boundary is automatically its own worktree — the agent can
 * touch nothing outside it, and no session can clobber another's edits in the
 * shared repo. Non-git workspaces fall back to the shared cwd.
 */
export class WorktreeService implements vscode.Disposable {
  private readonly records = new Map<string, WorktreeRecord>()

  constructor(
    private readonly storage: vscode.Memento,
    private readonly run: GitRunner = runGit,
  ) {
    this.load()
  }

  /** The record for one session, if it is isolated in a worktree. */
  recordFor(sessionId: string): WorktreeRecord | undefined {
    return this.records.get(sessionId)
  }

  /** The repository root a session's worktree lives under, when isolated. */
  repoRootFor(sessionId: string): string | undefined {
    return this.records.get(sessionId)?.repoRoot
  }

  /** The cwd a session's history row should display (repo root, not the worktree leaf). */
  displayCwd(sessionId: string, fallback: string | undefined): string | undefined {
    return this.records.get(sessionId)?.repoRoot ?? fallback
  }

  /**
   * Creates the worktree for a new session and returns the cwd to hand it.
   * Falls back to the shared base cwd (non-git workspace, git missing, or
   * worktree creation failure) with a reason.
   */
  async prepare(sessionId: string, baseCwd: string): Promise<WorktreePreparation> {
    const repoRoot = await gitRoot(this.run, baseCwd)
    if (repoRoot === undefined) return { cwd: baseCwd, isolated: false, reason: 'no-git-repo' }
    const baseBranch = await currentBranch(this.run, repoRoot)
    if (baseBranch === undefined) return { cwd: baseCwd, isolated: false, reason: 'detached-head' }
    const branch = `dsh/${sessionId}`
    const worktreePath = path.join(repoRoot, '.dsh-worktrees', sessionId)
    try {
      await this.run(repoRoot, ['worktree', 'add', worktreePath, '-b', branch])
      await ignoreDshWorktrees(repoRoot)
    } catch {
      return { cwd: baseCwd, isolated: false, reason: 'worktree-add-failed' }
    }
    const record: WorktreeRecord = {
      sessionId,
      repoRoot,
      baseBranch,
      branch,
      worktreePath,
      createdAt: Date.now(),
    }
    this.records.set(sessionId, record)
    this.save()
    return { cwd: worktreePath, isolated: true, record }
  }

  /** Unified diff between the session branch and its base branch. */
  async diffText(sessionId: string): Promise<string | undefined> {
    const record = this.records.get(sessionId)
    if (record === undefined) return undefined
    try {
      const { stdout } = await this.run(record.repoRoot, ['diff', `${record.baseBranch}...${record.branch}`])
      return stdout
    } catch {
      return undefined
    }
  }

  /**
   * Merges the session branch back into its base branch using a temporary
   * detached worktree, so the user's main checkout is never touched by the
   * merge machinery. The base branch ref is then updated with `git update-ref`
   * (the same primitive `git fetch` uses to update a checked-out branch), and
   * — when the main worktree is clean — its working tree is synced to the
   * merge commit so the change appears there immediately.
   */
  async mergeBack(sessionId: string): Promise<MergeOutcome> {
    const record = this.records.get(sessionId)
    if (record === undefined) return { ok: false, message: 'no-worktree' }
    const tmp = path.join(record.repoRoot, '.dsh-worktrees', `.merge-${sessionId}`)
    // Captured before the ref moves: after `update-ref` the main worktree is
    // necessarily "dirty" relative to the new HEAD, so post-merge checks are
    // meaningless. A clean start means we can safely sync the working tree.
    const wasClean = !(await worktreeDirty(this.run, record.repoRoot))
    try {
      await this.run(record.repoRoot, ['worktree', 'add', '--detach', tmp, record.baseBranch])
      try {
        await this.run(tmp, ['merge', '--no-ff', '-m', `Merge session ${sessionId}`, record.branch])
        const { stdout: head } = await this.run(tmp, ['rev-parse', 'HEAD'])
        await this.run(record.repoRoot, ['update-ref', `refs/heads/${record.baseBranch}`, head.trim()])
        await this.run(record.repoRoot, ['worktree', 'remove', '--force', tmp])
        if (wasClean) {
          // The main worktree was clean, so syncing it to the merge commit
          // loses nothing and shows the merged result in the user's checkout.
          await this.run(record.repoRoot, ['reset', '--hard', 'HEAD']).catch(() => undefined)
          return { ok: true, message: 'merged' }
        }
        // The ref moved but the user's working tree had uncommitted changes;
        // they are untouched and the tree now trails the branch.
        return { ok: true, message: 'merged-dirty' }
      } catch {
        await this.run(record.repoRoot, ['worktree', 'remove', '--force', tmp]).catch(() => undefined)
        return { ok: false, message: 'merge-conflict' }
      }
    } catch {
      return { ok: false, message: 'merge-worktree-failed' }
    }
  }

  /** Removes the session's worktree and its dedicated branch. */
  async discard(sessionId: string): Promise<DiscardOutcome> {
    const record = this.records.get(sessionId)
    if (record === undefined) return { ok: true, message: 'no-worktree' }
    try {
      await this.run(record.repoRoot, ['worktree', 'remove', '--force', record.worktreePath])
    } catch {
      return { ok: false, message: 'worktree-remove-failed' }
    }
    await this.run(record.repoRoot, ['branch', '-D', record.branch]).catch(() => undefined)
    this.records.delete(sessionId)
    this.save()
    return { ok: true, message: 'discarded' }
  }

  /**
   * Removes worktrees whose session no longer exists (deleted sessions, or a
   * crash between worktree add and session create). Also prunes stale git
   * worktree metadata. Returns the removed session ids.
   */
  async cleanupOrphans(liveSessionIds: ReadonlySet<string>): Promise<string[]> {
    const removed: string[] = []
    for (const [sessionId, record] of this.records) {
      if (liveSessionIds.has(sessionId)) continue
      await this.run(record.repoRoot, ['worktree', 'remove', '--force', record.worktreePath]).catch(() => undefined)
      await this.run(record.repoRoot, ['branch', '-D', record.branch]).catch(() => undefined)
      this.records.delete(sessionId)
      removed.push(sessionId)
    }
    this.save()
    return removed
  }

  dispose(): void {
    this.records.clear()
  }

  private load(): void {
    const value = this.storage.get<WorktreeRecord[]>(REGISTRY_KEY)
    if (!Array.isArray(value)) return
    for (const entry of value) {
      if (typeof entry?.sessionId === 'string' && typeof entry.worktreePath === 'string') {
        this.records.set(entry.sessionId, entry)
      }
    }
  }

  private save(): void {
    void this.storage.update(REGISTRY_KEY, [...this.records.values()])
  }
}

async function gitRoot(run: GitRunner, cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(cwd, ['rev-parse', '--show-toplevel'])
    const root = stdout.trim()
    return root === '' ? undefined : root
  } catch {
    return undefined
  }
}

async function currentBranch(run: GitRunner, repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = stdout.trim()
    return branch === 'HEAD' ? undefined : branch
  } catch {
    return undefined
  }
}

/** Whether the main worktree has uncommitted changes (porcelain status non-empty). */
async function worktreeDirty(run: GitRunner, repoRoot: string): Promise<boolean> {
  try {
    const { stdout } = await run(repoRoot, ['status', '--porcelain'])
    return stdout.trim() !== ''
  } catch {
    // If status is unreadable, err on the side of not touching the worktree.
    return true
  }
}

function runGit(cwd: string, args: readonly string[]): Promise<ExecResult> {
  const options: ExecFileOptions = { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  return execFileAsync('git', [...args], options) as Promise<ExecResult>
}

const EXCLUDE_ENTRY = '.dsh-worktrees/\n'

/**
 * Ensures `.dsh-worktrees/` is ignored by the repository (via the local, never
 * committed `.git/info/exclude`) so the isolation directory and its worktrees
 * do not pollute `git status` of the main checkout. Best-effort: a failure
 * here never fails session creation.
 */
async function ignoreDshWorktrees(repoRoot: string): Promise<void> {
  try {
    const gitDir = path.join(repoRoot, '.git', 'info', 'exclude')
    let content = ''
    try {
      content = await readFile(gitDir, 'utf8')
    } catch {
      await mkdir(path.dirname(gitDir), { recursive: true })
    }
    if (content.split('\n').includes('.dsh-worktrees/')) return
    await appendFile(gitDir, content.endsWith('\n') ? EXCLUDE_ENTRY : `\n${EXCLUDE_ENTRY}`)
  } catch {
    // Never fail session creation over an exclude-entry nicety.
  }
}
