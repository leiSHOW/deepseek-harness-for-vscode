/** One checklist entry as projected from the harness `todo/write` event log. */
export interface TodoEntry {
  readonly content: string
  readonly status: string
}

/** Checklist glyph per todo status, shared by the Plan tab and stream cards. */
export function todoGlyph(status: string): '☑' | '●' | '○' {
  if (status === 'completed') return '☑'
  if (status === 'in_progress') return '●'
  return '○'
}

/** Completed/total counts for the `x/y` progress readout. */
export function todoProgress(todos: readonly TodoEntry[]): { readonly done: number; readonly total: number } {
  return { done: todos.filter((todo) => todo.status === 'completed').length, total: todos.length }
}

/** A compact content fingerprint for deciding whether a live card needs a refresh. */
export function todoListSignature(todos: readonly TodoEntry[]): string {
  return JSON.stringify(todos)
}
