export const MAX_EXTRACTION_ATTEMPTS = 3;
export const MAX_CONTEXT_ITEMS = 6;

type RealtimeInputItem =
  | { type: "item_reference"; id: string }
  | { type: "message"; role: "user"; content: [{ type: "input_text"; text: string }] };

export function buildExtractionInput(contextItemIds: string[], newItemIds: string[]) {
  const newIds = new Set(newItemIds);
  const contextIds = [...new Set(contextItemIds)]
    .filter((itemId) => !newIds.has(itemId))
    .slice(-MAX_CONTEXT_ITEMS);
  const input: RealtimeInputItem[] = [];

  if (contextIds.length > 0) {
    input.push({
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `Earlier conversation audio is context only. Use it to resolve short replies, but do not extract facts from it. Context item IDs: ${contextIds.join(", ")}`,
      }],
    });
    input.push(...contextIds.map((id) => ({ type: "item_reference" as const, id })));
  }

  input.push({
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text: `New committed audio to process. Only these items can provide new or corrected facts: ${newItemIds.join(", ")}`,
    }],
  });
  input.push(...newItemIds.map((id) => ({ type: "item_reference" as const, id })));

  return { contextIds, input };
}

export function settleExtractionItems(
  pendingItemIds: string[],
  retryCounts: Map<string, number>,
  runItemIds: string[],
  processed: boolean,
) {
  const runIds = new Set(runItemIds);
  const exhaustedIds: string[] = [];
  const nextRetryCounts = new Map(retryCounts);

  if (processed) {
    runIds.forEach((itemId) => nextRetryCounts.delete(itemId));
  } else {
    runIds.forEach((itemId) => {
      const attempts = (nextRetryCounts.get(itemId) ?? 0) + 1;
      if (attempts >= MAX_EXTRACTION_ATTEMPTS) {
        nextRetryCounts.delete(itemId);
        exhaustedIds.push(itemId);
      } else {
        nextRetryCounts.set(itemId, attempts);
      }
    });
  }

  const nextPendingItemIds = pendingItemIds.filter((itemId) =>
    !runIds.has(itemId) || (!processed && !exhaustedIds.includes(itemId))
  );

  return { pendingItemIds: nextPendingItemIds, retryCounts: nextRetryCounts, exhaustedIds };
}
