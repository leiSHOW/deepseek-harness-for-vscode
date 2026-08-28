import { describe, expect, it } from 'vitest'

import { normalizeWorkspacePath, sameWorkspacePath } from '../src/domain/workspace-scope.js'

describe('workspace-scope', () => {
  describe('normalizeWorkspacePath', () => {
    it('strips trailing path separators', () => {
      expect(normalizeWorkspacePath('/Users/me/project/')).toBe('/Users/me/project')
      expect(normalizeWorkspacePath('C:\\Users\\me\\project\\')).toBe('C:\\Users\\me\\project')
    })

    it('leaves a bare root separator in place', () => {
      expect(normalizeWorkspacePath('/')).toBe('')
    })
  })

  describe('sameWorkspacePath', () => {
    it('matches the same folder', () => {
      expect(sameWorkspacePath('/Users/me/project', '/Users/me/project')).toBe(true)
    })

    it('tolerates a trailing separator on either side', () => {
      expect(sameWorkspacePath('/Users/me/project/', '/Users/me/project')).toBe(true)
      expect(sameWorkspacePath('/Users/me/project', '/Users/me/project/')).toBe(true)
    })

    it('rejects a different folder', () => {
      expect(sameWorkspacePath('/Users/me/project-a', '/Users/me/project-b')).toBe(false)
      expect(sameWorkspacePath('/Users/me/project', '/Users/me/project-sub')).toBe(false)
    })

    it('hides every session when no workspace folder is open', () => {
      expect(sameWorkspacePath('/Users/me/project', undefined)).toBe(false)
      expect(sameWorkspacePath(undefined, undefined)).toBe(false)
    })

    it('hides a session with no recorded cwd', () => {
      expect(sameWorkspacePath(undefined, '/Users/me/project')).toBe(false)
    })
  })
})
