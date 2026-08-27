/**
 * Per-project session history scoping.
 *
 * Sessions record the workspace folder they were created in (`cwd`); the
 * history panel shows only the sessions that belong to the project currently
 * open in the window. Nothing is deleted — switching projects just filters the
 * view, and switching back restores the other project's sessions.
 */

/** Strips trailing separators; Windows paths compare case-insensitively. */
export function normalizeWorkspacePath(value: string): string {
  const trimmed = value.replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/**
 * Whether a session's recorded cwd belongs to the workspace currently open in
 * this window. Both sides must exist and match exactly: with no project open
 * nothing is listed (there is no project to scope by), and sessions created
 * with no project open fall back to the Host working directory, so they never
 * equal a real project folder and stay hidden everywhere.
 */
export function sameWorkspacePath(sessionCwd: string | undefined, workspaceCwd: string | undefined): boolean {
  return sessionCwd !== undefined && workspaceCwd !== undefined
    && normalizeWorkspacePath(sessionCwd) === normalizeWorkspacePath(workspaceCwd)
}
