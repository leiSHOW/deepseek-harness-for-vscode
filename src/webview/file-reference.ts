export interface FileReference {
  readonly path: string
  readonly line?: number
  readonly column?: number
}

export interface LocatedFileReference extends FileReference {
  readonly start: number
  readonly end: number
}

const FILE_REFERENCE_PATTERN = /(?:(?:(?:[a-z]:)?[\\/]|\.{1,2}[\\/]|[\w@+-]+[\\/])(?:[\w@+.-]+[\\/])*[\w@+.-]+|[\w@+-]+\.[a-z][a-z0-9._-]{0,15})(?::\d+(?::\d+|-\d+)?|#L\d+(?:C\d+)?(?:-L\d+(?:C\d+)?)?)?/giu

/** Parses model-produced workspace references such as src/app.ts:12:4. */
export function parseFileReference(raw: string): FileReference | undefined {
  const decoded = decodeReference(raw.trim())
  if (decoded === undefined || decoded === '' || hasExternalScheme(decoded) || looksLikeWebUrl(decoded)) return undefined
  const unwrapped = unwrap(decoded.replace(/^@/u, ''))
  const hash = /^(.*)#L(\d+)(?:C(\d+))?(?:-L\d+(?:C\d+)?)?$/iu.exec(unwrapped)
  if (hash !== null) return result(hash[1], hash[2], hash[3], true)
  const lineAndColumn = /^(.*):(\d+):(\d+)$/u.exec(unwrapped)
  if (lineAndColumn !== null) return result(lineAndColumn[1], lineAndColumn[2], lineAndColumn[3], true)
  const lineRange = /^(.*):(\d+)-\d+$/u.exec(unwrapped)
  if (lineRange !== null) return result(lineRange[1], lineRange[2], undefined, true)
  const lineOnly = /^(.*):(\d+)$/u.exec(unwrapped)
  if (lineOnly !== null) return result(lineOnly[1], lineOnly[2], undefined, true)
  return looksLikeFile(unwrapped) ? { path: unwrapped } : undefined
}

/** Finds plain-text file references without interpreting surrounding prose. */
export function findFileReferences(source: string): readonly LocatedFileReference[] {
  return [...source.matchAll(FILE_REFERENCE_PATTERN)].flatMap((match): LocatedFileReference[] => {
    const raw = match[0].replace(/[.,;!?]+$/u, '')
    const reference = parseFileReference(raw)
    if (reference === undefined || match.index === undefined) return []
    return [{ ...reference, start: match.index, end: match.index + raw.length }]
  })
}

/** Lowercase extension of a referenced path, used to pick a file-type icon. */
export function fileExtension(path: string): string | undefined {
  const basename = path.split(/[\\/]/u).pop() ?? ''
  const dot = basename.lastIndexOf('.')
  if (dot <= 0) return undefined
  const extension = basename.slice(dot + 1).toLowerCase()
  return /^[a-z0-9]{1,10}$/u.test(extension) ? extension : undefined
}

function result(path: string | undefined, line: string | undefined, column: string | undefined, positional = false): FileReference | undefined {
  if (path === undefined || !looksLikeFile(path, positional)) return undefined
  const parsedLine = positiveInteger(line)
  const parsedColumn = positiveInteger(column)
  return {
    path,
    ...(parsedLine === undefined ? {} : { line: parsedLine }),
    ...(parsedColumn === undefined ? {} : { column: parsedColumn }),
  }
}

/**
 * Whether a value plausibly names a real workspace file. Bare references must
 * carry a file-shaped basename — an extension, a dotfile, or a known
 * extensionless name — so prose like `dir/file`, `feature/foo`, or
 * `release/0.5.5` is never auto-linked to a file that does not exist. A
 * positional reference (with a line/column anchor) is treated as intentional
 * even when the basename has no extension.
 */
function looksLikeFile(value: string, positional = false): boolean {
  if (value === '' || /[\n\r\t]/u.test(value) || value.endsWith('/')) return false
  // A root-level single segment (e.g. `/guide`) is a URL fragment left over
  // from prose, not a workspace file reference.
  if (value.startsWith('/') && !value.slice(1).includes('/') && !/\.\w+$/u.test(value)) return false
  const basename = value.split(/[\\/]/u).pop() ?? ''
  if (positional) {
    return value.includes('/') || value.includes('\\') || looksLikeFileBasename(basename)
  }
  return looksLikeFileBasename(basename)
}

function looksLikeFileBasename(basename: string): boolean {
  return /^\.?[\w@+-]+\.[a-z][a-z0-9._-]{0,15}$/iu.test(basename)
    || /^\.\w[\w.-]*$/u.test(basename)
    || /^(?:Dockerfile|Makefile|Procfile|README|LICENSE)$/iu.test(basename)
}

/** Bare-name suffixes that make a value a local file rather than a web host. */
const NON_WEB_FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'css', 'scss', 'sass', 'less', 'html', 'htm',
  'md', 'markdown', 'mdown', 'py', 'pyw', 'rs', 'go', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp',
  'hpp', 'cs', 'fs', 'rb', 'php', 'vue', 'svelte', 'astro', 'yml', 'yaml', 'toml', 'ini', 'cfg',
  'conf', 'xml', 'svg', 'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'txt', 'log', 'sql',
  'graphql', 'gql', 'proto', 'lock', 'sum', 'map', 'env', 'editorconfig', 'gitignore', 'npmrc',
  'gz', 'zip', 'tar', 'rar', '7z', 'bz2', 'xz', 'tgz', 'deb', 'rpm', 'dmg', 'exe', 'msi',
])

/**
 * Detects web-URL-shaped values (https://…, www.example.com, docs.example.com/guide)
 * so they are never misread as workspace file references. A dotted first
 * segment whose final label is letters is treated as a host, except for bare
 * `name.ext` values with a known source/archive extension (`package.json`,
 * `app.ts`, `file.tar.gz`) which stay file references.
 */
export function looksLikeWebUrl(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (normalized === '' || normalized.includes('\\')) return false
  if (normalized.includes('://') || normalized.startsWith('//') || normalized.startsWith('www.')) return true
  const first = normalized.split('/')[0] ?? ''
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u.test(first)) return false
  const tld = first.split('.').pop() ?? ''
  if (!/^[a-z]{2,24}$/u.test(tld)) return false
  if (!normalized.includes('/')) {
    const lastDot = normalized.lastIndexOf('.')
    if (lastDot > 0 && NON_WEB_FILE_EXTENSIONS.has(normalized.slice(lastDot + 1))) return false
  }
  return true
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/** Stable identity for one reference, shared between DOM markers and the host round-trip. */
export function fileReferenceKey(reference: FileReference): string {
  return JSON.stringify([reference.path, reference.line ?? null, reference.column ?? null])
}

/** Rebuilds the exact reference a key encodes; used when promoting a verified marker. */
export function referenceFromKey(key: string): FileReference | undefined {
  try {
    const parsed: unknown = JSON.parse(key)
    if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== 'string' || parsed[0] === '') {
      return undefined
    }
    const path = parsed[0]
    const line = typeof parsed[1] === 'number' && Number.isSafeInteger(parsed[1]) && parsed[1] > 0 ? parsed[1] : undefined
    const column = typeof parsed[2] === 'number' && Number.isSafeInteger(parsed[2]) && parsed[2] > 0 ? parsed[2] : undefined
    return {
      path,
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
    }
  } catch {
    return undefined
  }
}

/**
 * Webview-side existence ledger: only references the Host confirmed as real
 * workspace files may become clickable. Unknown candidates render as plain
 * text until the host answers; confirmed-missing references stay plain text.
 * The pending set prevents re-sending the same candidate on every streaming
 * frame before the host has answered.
 */
const verifiedReferences = new Set<string>()
const rejectedReferences = new Set<string>()
const pendingReferences = new Set<string>()

export function markResolvedFileReferences(keys: readonly string[]): void {
  for (const key of keys) {
    if (!verifiedReferences.has(key)) verifiedReferences.add(key)
    rejectedReferences.delete(key)
    pendingReferences.delete(key)
  }
}

export function markRejectedFileReferences(keys: readonly string[]): void {
  for (const key of keys) {
    verifiedReferences.delete(key)
    if (!rejectedReferences.has(key)) rejectedReferences.add(key)
    pendingReferences.delete(key)
  }
}

/** Marks candidates as already sent to the host, awaiting an answer. */
export function markPendingFileReferences(keys: readonly string[]): void {
  for (const key of keys) pendingReferences.add(key)
}

/** Whether a reference is safe to render as a clickable file link right now. */
export function isVerifiedFileReference(key: string): boolean {
  return verifiedReferences.has(key)
}

/** Whether the host already answered "not a workspace file" for this key. */
export function isRejectedFileReference(key: string): boolean {
  return rejectedReferences.has(key)
}

/** Whether a validation request for this key is already in flight. */
export function isPendingFileReference(key: string): boolean {
  return pendingReferences.has(key)
}

/** Drops every resolution record; session switches change which files exist. */
export function clearFileReferenceLedger(): void {
  verifiedReferences.clear()
  rejectedReferences.clear()
  pendingReferences.clear()
}

function unwrap(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value.at(-1)
  return (first === '"' && last === '"') || (first === "'" && last === "'") || (first === '<' && last === '>')
    ? value.slice(1, -1)
    : value
}

function decodeReference(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

function hasExternalScheme(value: string): boolean {
  // A Windows drive prefix is a path, not a URI scheme.
  return /^[a-z][a-z0-9+.-]*:/iu.test(value) && !/^[a-z]:[\\/]/iu.test(value)
}
