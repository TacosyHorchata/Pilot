/**
 * Translate Playwright errors into LLM-actionable messages.
 * Ported from gstack browse server.ts wrapError().
 */

export function wrapError(err: any): string {
  const msg = err.message || String(err);

  // Timeout errors
  if (err.name === 'TimeoutError' || msg.includes('Timeout') || msg.includes('timeout')) {
    if (msg.includes('locator.click') || msg.includes('locator.fill') || msg.includes('locator.hover')) {
      return 'Element not found or not interactable within timeout. Check your selector or run pilot_snapshot for fresh refs.';
    }
    if (msg.includes('page.goto') || msg.includes('Navigation')) {
      return 'Page navigation timed out. The URL may be unreachable or the page may be loading slowly.';
    }
    return `Operation timed out: ${msg.split('\n')[0]}`;
  }

  // Multiple elements matched
  if (msg.includes('resolved to') && msg.includes('elements')) {
    return "Selector matched multiple elements. Be more specific or use @refs from pilot_snapshot.";
  }

  // Stale refs
  if (msg.includes('stale') || msg.includes('no longer exists')) {
    return 'Element is stale — it no longer exists in the DOM. Run pilot_snapshot for fresh refs.';
  }

  return msg;
}
