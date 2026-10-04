/** Diagnostics must remain safe even for thrown values with hostile coercion hooks. */
export function describeError(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return 'Unknown error (could not describe thrown value)';
  }
}
