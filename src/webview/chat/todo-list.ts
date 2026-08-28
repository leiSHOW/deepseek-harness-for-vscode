import { todoGlyph, type TodoEntry } from '../../domain/todo-view.js'
import { node } from './context.js'

export type { TodoEntry } from '../../domain/todo-view.js'
export { todoGlyph, todoProgress, todoListSignature } from '../../domain/todo-view.js'

/** Appends one checkbox row per todo; used by the Plan tab and stream cards. */
export function appendTodoRows(target: HTMLElement | DocumentFragment, todos: readonly TodoEntry[]): void {
  for (const todo of todos) {
    const row = node('div', `todo-row ${todo.status}`)
    row.append(node('span', 'todo-check', todoGlyph(todo.status)), node('span', 'todo-text', todo.content))
    target.append(row)
  }
}
