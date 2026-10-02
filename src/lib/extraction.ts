export const MAX_EXTRACTION_ATTEMPTS = 3;
export const MAX_CONTEXT_ITEMS = 6;

export type ExtractionTranscriptItem = {
  itemId: string;
  transcript: string;
};

type RealtimeInputItem = {
  type: "message";
  role: "user";
  content: [{ type: "input_text"; text: string }];
};

export function buildExtractionInput(
  contextItems: ExtractionTranscriptItem[],
  newItems: ExtractionTranscriptItem[],
) {
  const newIds = new Set(newItems.map((item) => item.itemId));
  const context = contextItems
    .filter((item) => !newIds.has(item.itemId))
    .filter((item, index, items) => items.findIndex((candidate) => candidate.itemId === item.itemId) === index)
    .slice(-MAX_CONTEXT_ITEMS);
  const contextIds = context.map((item) => item.itemId);
  const input: RealtimeInputItem[] = [{
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text: JSON.stringify({
        context,
        newEvidence: newItems,
      }),
    }],
  }];

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
