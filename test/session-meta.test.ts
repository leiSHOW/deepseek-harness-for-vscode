import { describe, expect, it } from 'vitest'
import {
  isPinned,
  metaSortRank,
  normalizeTagList,
  readSessionMeta,
  setTags,
  togglePinned,
} from '../src/domain/session-meta.js'

describe('readSessionMeta', () => {
  it('extracts valid fields and drops invalid ones', () => {
    expect(readSessionMeta({ pinned: true, favorite: true, tags: ['x', ' x ', '', 3] }))
      .toEqual({ pinned: true, tags: ['x'] })
  })

  it('returns undefined for empty or invalid input', () => {
    expect(readSessionMeta({})).toBeUndefined()
    expect(readSessionMeta(null)).toBeUndefined()
    expect(readSessionMeta('nope')).toBeUndefined()
  })
})

describe('toggles', () => {
  it('flips pinned state', () => {
    expect(togglePinned(undefined)).toEqual({ pinned: true })
    expect(togglePinned({ pinned: true })).toEqual({ pinned: false })
  })

  it('sets and normalizes tags', () => {
    expect(setTags(undefined, ['a', ' b ', 'a', ''])).toEqual({ tags: ['a', 'b'] })
  })
})

describe('ordering and filters', () => {
  it('ranks pinned before the rest', () => {
    expect(metaSortRank({ pinned: true })).toBe(0)
    expect(metaSortRank(undefined)).toBe(1)
  })

  it('detects a pinned session', () => {
    expect(isPinned({ pinned: true })).toBe(true)
    expect(isPinned(undefined)).toBe(false)
  })

  it('normalizes a tag list with duplicates, blanks and non-strings', () => {
    expect(normalizeTagList(['b', 'b', '', 'a', 7, ' a '])).toEqual(['b', 'a'])
  })
})
