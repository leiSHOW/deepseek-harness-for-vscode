/**
 * Image-input capability lookup shared by the composer picker, the auto model
 * selection, and relay profile writing.
 *
 * The wire model catalog (`sessions.models`) drops each model's
 * `inputModalities`, so capability cannot be read back from the harness. It is
 * inferred from the id instead: vision-capable ids follow the `vision` naming
 * convention (`deepseek-v4-flash-vision-exp` in the bundled DeepSeek catalog,
 * and relay ids such as `deepseek/deepseek-v4-flash-vision-exp`). A wrong
 * positive only moves the rejection from admission to the provider's own
 * error, while a wrong negative silently breaks image prompts — so the
 * heuristic stays permissive.
 */
export function supportsImageInput(modelId: string): boolean {
  return modelId.toLowerCase().includes('vision')
}
