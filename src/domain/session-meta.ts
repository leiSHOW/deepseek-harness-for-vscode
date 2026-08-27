/**
 * Durable, locally-owned metadata that the Harness runtime has no concept of.
 * Stored by the extension in globalState keyed by session id; it never touches
 * the official session record or the runtime.
 */
export interface SessionMeta {
  readonly pinned?: boolean
  readonly favorite?: boolean
  readonly tags?: readonly string[]
}

/** Normalizes an untrusted persisted value, dropping invalid fields. */
export function readSessionMeta(value: unknown): SessionMeta | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const meta: { pinned?: boolean; favorite?: boolean; tags?: readonly string[] } = {}
  if (record.pinned === true) meta.pinned = true
  if (record.favorite === true) meta.favorite = true
  const tags = normalizeTagList(record.tags)
  if (tags.length > 0) meta.tags = tags
  return meta.pinned === undefined && meta.favorite === undefined && meta.tags === undefined ? undefined : meta
}

export function togglePinned(meta: SessionMeta | undefined): SessionMeta {
  return { ...meta, pinned: meta?.pinned !== true }
}

export function toggleFavorite(meta: SessionMeta | undefined): SessionMeta {
  return { ...meta, favorite: meta?.favorite !== true }
}

export function setTags(meta: SessionMeta | undefined, tags: readonly string[]): SessionMeta {
  return { ...meta, tags: normalizeTagList(tags) }
}

/** Drops empty entries and de-duplicates, preserving order. */
export function normalizeTagList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

/** Sorting score: pinned first, then favorites, newest first within a group. */
export function metaSortRank(meta: SessionMeta | undefined): number {
  if (meta?.pinned === true) return 0
  if (meta?.favorite === true) return 1
  return 2
}

/** Whether a session passes the "pinned" history filter. */
export function isPinned(meta: SessionMeta | undefined): boolean {
  return meta?.pinned === true
}