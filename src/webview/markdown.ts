import DOMPurify, { type Config } from 'dompurify'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import less from 'highlight.js/lib/languages/less'
import makefile from 'highlight.js/lib/languages/makefile'
import languageMarkdown from 'highlight.js/lib/languages/markdown'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import {
  clearFileReferenceLedger,
  fileExtension,
  fileReferenceKey,
  findFileReferences,
  isPendingFileReference,
  isRejectedFileReference,
  isVerifiedFileReference,
  looksLikeWebUrl,
  markPendingFileReferences,
  markRejectedFileReferences,
  markResolvedFileReferences,
  parseFileReference,
  referenceFromKey,
  type FileReference,
} from './file-reference.js'

// Curated language subset: common code languages plus config formats the
// agent actually writes. Keeping this list small keeps the webview bundle
// light (full hljs is ~200+ language files) and startup snappy.
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('csharp', csharp)
hljs.registerLanguage('css', css)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('go', go)
hljs.registerLanguage('ini', ini)
hljs.registerLanguage('java', java)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('kotlin', kotlin)
hljs.registerLanguage('less', less)
hljs.registerLanguage('makefile', makefile)
hljs.registerLanguage('markdown', languageMarkdown)
hljs.registerLanguage('powershell', powershell)
hljs.registerLanguage('ps1', powershell)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('shell', shell)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)

/** Aliases that need a different registered name. */
const HLJS_ALIASES: Readonly<Record<string, string>> = {
  sh: 'bash',
  zsh: 'bash',
  cmd: 'powershell',
  pwsh: 'powershell',
  ps: 'powershell',
  javascript: 'javascript',
  tsx: 'typescript',
  jsx: 'javascript',
  html: 'xml',
  vue: 'xml',
  svg: 'xml',
  toml: 'ini',
  dockerfile: 'bash',
  text: '',
}

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
  maxNesting: 40,
  highlight: (code, language) => {
    const name = HLJS_ALIASES[language] ?? language
    if (name !== '') {
      try {
        const result = hljs.highlight(code, { language: name, ignoreIllegals: true })
        return `<pre><code class="hljs language-${escapeAttr(language)}">${result.value}</code></pre>`
      } catch {
        // Unknown language: fall through to the plain escaper below.
      }
    }
    return `<pre><code class="language-${escapeAttr(language)}">${escapeHtml(code)}</code></pre>`
  },
})

// Remote Markdown images are intentionally disabled: arbitrary image URLs
// would add a privacy leak and are blocked by the Webview CSP anyway.
markdown.disable('image')

const SANITIZE_OPTIONS: Config = {
  ALLOWED_TAGS: [
    'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
  ],
  ALLOWED_ATTR: ['class', 'href', 'title'],
  RETURN_TRUSTED_TYPE: false,
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function escapeAttr(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '')
}

const renderedSources = new WeakMap<HTMLElement, string>()

/** Holds candidates between markdown passes so streaming patches re-check them. */
const referenceCandidates = new Map<string, FileReference>()
/** Expiration of the previous validation flush; candidates flood the host once per frame. */
let candidateFlushTimer: ReturnType<typeof setTimeout> | undefined
/** Host-bound validator, injected once by the webview entry point. */
let referenceValidator: ((keys: readonly string[]) => void) | undefined
/** Actions used to promote pending placeholders once the host confirms them. */
let lastMarkdownActions: MarkdownActions | undefined

/**
 * Pending placeholders live in the DOM as plain, unclickable elements until
 * the host answers. Every instance gets a numeric id so the verdict can
 * upgrade/unwrap them in place without re-rendering the transcript.
 */
const pendingById = new Map<string, string>()
const pendingByKey = new Map<string, Set<string>>()
let nextPendingInstanceId = 1

function registerPendingInstance(key: string, element: HTMLElement): void {
  const id = String(nextPendingInstanceId)
  nextPendingInstanceId += 1
  element.dataset.pendingFileRef = id
  pendingById.set(id, key)
  const ids = pendingByKey.get(key)
  if (ids === undefined) pendingByKey.set(key, new Set([id]))
  else ids.add(id)
}

/** Removes placeholder records owned by a block about to be rebuilt. */
function unregisterPendingIn(target: HTMLElement): void {
  if (pendingById.size === 0) return
  const placeholders = Array.from(target.querySelectorAll<HTMLElement>('[data-pending-file-ref]'))
  for (const element of placeholders) {
    const id = element.dataset.pendingFileRef
    if (id === undefined) continue
    const key = pendingById.get(id)
    pendingById.delete(id)
    if (key !== undefined) {
      const ids = pendingByKey.get(key)
      ids?.delete(id)
      if (ids !== undefined && ids.size === 0) pendingByKey.delete(key)
    }
  }
}

export interface MarkdownActions {
  readonly openExternal: (url: string) => void
  readonly openFile: (reference: FileReference) => void
  readonly copyCode: (code: string) => void
  readonly defaultCodeLanguage: string
  readonly copyLabel: string
  readonly copiedLabel: string
  readonly copyCodeLabel: (language: string) => string
  readonly expandCodeLabel: (hiddenLines: number) => string
}

/** Installs the host-bound validator; call once when the webview boots. */
export function setReferenceValidator(validate: (keys: readonly string[]) => void): void {
  referenceValidator = validate
}

/** Queues host-side validation and flushes candidates once per frame. */
function scheduleValidationFlush(): void {
  if (candidateFlushTimer !== undefined) return
  candidateFlushTimer = setTimeout(() => {
    candidateFlushTimer = undefined
    const validator = referenceValidator
    if (validator === undefined) return
    const pending = [...referenceCandidates.keys()].filter((key) =>
      !isVerifiedFileReference(key) && !isRejectedFileReference(key) && !isPendingFileReference(key))
    if (pending.length === 0) return
    markPendingFileReferences(pending)
    validator(pending)
  }, 0)
}

/**
 * Applies a host validation answer by upgrading confirmed placeholders into
 * clickable file links and unwrapping rejected ones back to plain text — no
 * transcript re-render needed.
 */
export function applyReferenceValidation(answer: { resolved: readonly string[]; rejected: readonly string[] }): void {
  markResolvedFileReferences(answer.resolved)
  markRejectedFileReferences(answer.rejected)
  for (const key of answer.resolved) {
    referenceCandidates.delete(key)
    promotePendingInstances(key)
  }
  for (const key of answer.rejected) {
    referenceCandidates.delete(key)
    demotePendingInstances(key)
  }
}

function promotePendingInstances(key: string): void {
  const ids = pendingByKey.get(key)
  pendingByKey.delete(key)
  if (ids === undefined) return
  const reference = referenceFromKey(key)
  const actions = lastMarkdownActions
  for (const id of ids) {
    pendingById.delete(id)
    const element = document.querySelector<HTMLElement>(`[data-pending-file-ref="${id}"]`)
    if (element === null) continue
    element.removeAttribute('data-pending-file-ref')
    if (reference !== undefined && actions !== undefined) decorateFileLink(element, reference, actions)
  }
}

function demotePendingInstances(key: string): void {
  const ids = pendingByKey.get(key)
  pendingByKey.delete(key)
  if (ids === undefined) return
  for (const id of ids) {
    pendingById.delete(id)
    const element = document.querySelector<HTMLElement>(`[data-pending-file-ref="${id}"]`)
    if (element === null) continue
    // The host said "not a workspace file": keep the original element shape
    // (plain span or inline code) but never make it clickable.
    element.removeAttribute('data-pending-file-ref')
  }
}

/** Drops the whole existence ledger (session switch resets the workspace view). */
export function resetReferenceValidation(): void {
  clearFileReferenceLedger()
  referenceCandidates.clear()
  pendingById.clear()
  pendingByKey.clear()
  if (candidateFlushTimer !== undefined) {
    clearTimeout(candidateFlushTimer)
    candidateFlushTimer = undefined
  }
}

/** Converts CommonMark/GFM-style source into markup before DOM sanitization. */
export function markdownMarkup(source: string): string {
  return markdown.render(source)
}

/**
 * Renders model/user Markdown into one stable message block.
 *
 * Raw HTML is disabled in the parser and the generated markup is passed
 * through DOMPurify before reaching innerHTML. The source cache avoids parsing
 * unchanged blocks when unrelated Gateway state updates arrive.
 */
export function renderMarkdown(target: HTMLElement, source: string, actions: MarkdownActions): void {
  lastMarkdownActions = actions
  if (renderedSources.get(target) === source) return
  // Streaming frames rebuild this block: drop placeholder records that will be
  // detached by the innerHTML replacement below, so pending maps never leak.
  unregisterPendingIn(target)
  const clean = DOMPurify.sanitize(markdownMarkup(source), SANITIZE_OPTIONS)
  target.innerHTML = String(clean)
  renderedSources.set(target, source)
  target.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((link) => {
    const href = link.getAttribute('href') ?? ''
    const reference = parseFileReference(href)
    if (reference !== undefined) {
      const key = fileReferenceKey(reference)
      if (isVerifiedFileReference(key)) {
        decorateFileLink(link, reference, actions)
      } else {
        // Unverified: keep plain text so the label never looks clickable, and
        // register a placeholder so the host verdict can upgrade it in place.
        const placeholder = document.createElement('span')
        placeholder.textContent = link.textContent ?? href
        link.replaceWith(placeholder)
        if (!isRejectedFileReference(key)) {
          collectCandidate(key, reference)
          registerPendingInstance(key, placeholder)
        }
      }
      return
    }
    const url = safeExternalUrl(href) ?? schemeLessWebUrl(href)
    if (url === undefined) {
      link.removeAttribute('href')
      return
    }
    link.href = url
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.addEventListener('click', (event) => {
      event.preventDefault()
      actions.openExternal(url)
    })
  })
  target.querySelectorAll<HTMLPreElement>('pre').forEach((pre) => decorateCodeBlock(pre, actions))
  target.querySelectorAll<HTMLElement>('code').forEach((code) => {
    if (code.closest('pre') !== null) return
    const reference = parseFileReference(code.textContent ?? '')
    if (reference === undefined) return
    const key = fileReferenceKey(reference)
    if (isVerifiedFileReference(key)) {
      decorateFileLink(code, reference, actions)
    } else if (!isRejectedFileReference(key)) {
      collectCandidate(key, reference)
      registerPendingInstance(key, code)
    }
  })
  decoratePlainTextReferences(target, actions)
  scheduleValidationFlush()
}

function decoratePlainTextReferences(target: HTMLElement, actions: MarkdownActions): void {
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) {
    const text = walker.currentNode
    if (text instanceof Text && text.parentElement?.closest('a, button, code, pre, .md-file-link, [data-pending-file-ref]') === null) {
      nodes.push(text)
    }
  }
  for (const textNode of nodes) {
    const source = textNode.data
    const references = findFileReferences(source)
    if (references.length === 0) continue
    const fragment = document.createDocumentFragment()
    let offset = 0
    for (const reference of references) {
      fragment.append(source.slice(offset, reference.start))
      const key = fileReferenceKey(reference)
      if (isVerifiedFileReference(key)) {
        const link = document.createElement('span')
        link.textContent = source.slice(reference.start, reference.end)
        decorateFileLink(link, reference, actions)
        fragment.append(link)
      } else {
        // Not verified: keep plain text (no affordance, no click bait) but
        // register a placeholder so the host verdict can upgrade it in place.
        const placeholder = document.createElement('span')
        placeholder.textContent = source.slice(reference.start, reference.end)
        fragment.append(placeholder)
        if (!isRejectedFileReference(key)) {
          collectCandidate(key, reference)
          registerPendingInstance(key, placeholder)
        }
      }
      offset = reference.end
    }
    fragment.append(source.slice(offset))
    textNode.replaceWith(fragment)
  }
}

/** Records a candidate for the next batched host existence check. */
function collectCandidate(key: string, reference: FileReference): void {
  referenceCandidates.set(key, reference)
}

function decorateFileLink(element: HTMLElement, reference: FileReference, actions: MarkdownActions): void {
  element.removeAttribute('href')
  element.classList.add('md-file-link')
  const extension = fileExtension(reference.path)
  if (extension !== undefined) element.dataset.fileExt = extension
  element.setAttribute('role', 'link')
  element.tabIndex = 0
  const open = (event: Event): void => {
    event.preventDefault()
    actions.openFile(reference)
  }
  element.addEventListener('click', open)
  element.addEventListener('keydown', (event) => {
    if (!(event instanceof KeyboardEvent) || (event.key !== 'Enter' && event.key !== ' ')) return
    open(event)
  })
}

/** Long code blocks collapse to a preview and expand on demand (diff-editor
 * diff style): a faded fade + "Show N more lines" affordance instead of an
 * inner scrollbar fighting the outer tool-detail scroller. */
const CODE_COLLAPSE_MIN_LINES = 20
const CODE_COLLAPSE_VISIBLE_LINES = 14

function decorateCodeBlock(pre: HTMLPreElement, actions: MarkdownActions): void {
  const code = pre.querySelector(':scope > code')
  if (code === null) return
  const language = Array.from(code.classList)
    .find((className) => className.startsWith('language-'))
    ?.slice('language-'.length) || actions.defaultCodeLanguage
  const wrapper = document.createElement('div')
  wrapper.className = 'md-codeblock'
  const header = document.createElement('div')
  header.className = 'md-codeblock-header'
  const label = document.createElement('span')
  label.className = 'md-codeblock-lang'
  label.textContent = language
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'md-copy'
  copy.textContent = actions.copyLabel
  copy.setAttribute('aria-label', actions.copyCodeLabel(language))
  copy.addEventListener('click', () => {
    actions.copyCode(code.textContent ?? '')
    copy.textContent = '✓'
    copy.setAttribute('aria-label', actions.copiedLabel)
    copy.classList.add('copied')
    setTimeout(() => {
      copy.textContent = actions.copyLabel
      copy.setAttribute('aria-label', actions.copyCodeLabel(language))
      copy.classList.remove('copied')
    }, 2_000)
  })
  header.append(label, copy)
  pre.replaceWith(wrapper)
  wrapper.append(header, pre)

  // Collapse long blocks. `textContent` is used for the line count because
  // browser line-breaking inside nested inline elements is unreliable.
  // While the block is still streaming (.streaming-content), it is left fully
  // expanded so the reader watches the code grow and the outer transcript
  // scroll follows the newest lines; the fold + "Show N more lines" only apply
  // once the turn lands (matching "collapsed by default" for finished blocks).
  if (pre.closest('.streaming-content') !== null) return
  const lineCount = (code.textContent ?? '').split('\n').length
  if (lineCount <= CODE_COLLAPSE_MIN_LINES) return
  pre.classList.add('collapsed')
  const expand = document.createElement('button')
  expand.type = 'button'
  expand.className = 'md-codeblock-expand'
  expand.textContent = actions.expandCodeLabel(Math.max(0, lineCount - CODE_COLLAPSE_VISIBLE_LINES))
  expand.setAttribute('aria-expanded', 'false')
  expand.addEventListener('click', () => {
    pre.classList.remove('collapsed')
    expand.remove()
  })
  wrapper.append(pre, expand)
}

function safeExternalUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/** Upgrades scheme-less web-URL anchors (e.g. `docs.example.com/guide`) to https. */
function schemeLessWebUrl(raw: string): string | undefined {
  if (!looksLikeWebUrl(raw)) return undefined
  try {
    return new URL(`https://${raw}`).href
  } catch {
    return undefined
  }
}
