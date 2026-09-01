import type { MarkdownActions } from '../markdown.js'
import { post, t } from './context.js'
import { copyText } from './utils.js'

export const markdownActions: MarkdownActions = {
  openExternal: (url) => post('openExternal', { url }),
  openFile: (reference) => post('openFile', reference as unknown as Record<string, unknown>),
  copyCode: (code) => copyText(code),
  defaultCodeLanguage: t('code'),
  copyLabel: t('copy'),
  copiedLabel: t('copied'),
  copyCodeLabel: (language) => t('copyCode', { language }),
  expandCodeLabel: (hiddenLines) => t('expandCode', { lines: hiddenLines }),
}
