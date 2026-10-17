// limit.js — run an async step over a list, a few at a time.

/**
 * fn(item, i) for every item, at most `n` running at once. Resolves to
 * [{value} | {error}] in the items' own order, whatever order they finish
 * in; a step that throws never stops the others. onDone(done, total)
 * after each step.
 */
export async function eachLimit(items, n, fn, onDone = () => {}) {
  const out = new Array(items.length);
  let next = 0;
  let done = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { value: await fn(items[i], i) }; } catch (e) { out[i] = { error: e }; }
      onDone(++done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(0, Math.min(n, items.length)) }, lane));
  return out;
}
