import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExtractionInput,
  MAX_EXTRACTION_ATTEMPTS,
  settleExtractionItems,
} from "../src/lib/extraction.ts";
import { classifyProfilePatch } from "../src/lib/profile-patch.ts";

test("a later short answer receives earlier audio as context, while only new audio is extractable", () => {
  const earlierRun = buildExtractionInput([], ["seller-question"]);
  assert.match(earlierRun.input[0].content[0].text, /New committed audio/);

  const nextRun = buildExtractionInput(["seller-question"], ["short-answer"]);
  const markerTexts = nextRun.input
    .filter((item) => item.type === "message")
    .map((item) => item.content[0].text);
  const references = nextRun.input
    .filter((item) => item.type === "item_reference")
    .map((item) => item.id);

  assert.match(markerTexts[0], /context only/);
  assert.match(markerTexts[1], /Only these items can provide new or corrected facts/);
  assert.deepEqual(references, ["seller-question", "short-answer"]);
  assert.deepEqual(nextRun.contextIds, ["seller-question"]);
});

test("a mixed patch keeps valid customer facts and permanently skips agent or invalid facts", () => {
  const result = classifyProfilePatch(JSON.stringify({ updates: [
    {
      operation: "set",
      field: "personal.age",
      value: 35,
      sourceSpeaker: "agent",
      evidence: "คุณอายุ 35 ใช่ไหม",
    },
    {
      operation: "set",
      field: "financial.monthlyIncome",
      value: 80_000,
      sourceSpeaker: "customer",
      evidence: "รายได้เดือนละ 80,000 บาท",
    },
    {
      operation: "set",
      field: "personal.age",
      value: 180,
      sourceSpeaker: "customer",
      evidence: "อายุ 180 ปี",
    },
  ] }));

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.deepEqual(result.accepted.map((update) => update.field), ["financial.monthlyIncome"]);
  assert.equal(result.skipped.length, 2);
});

test("a malformed update does not discard valid updates from the same patch", () => {
  const result = classifyProfilePatch(JSON.stringify({ updates: [
    {
      operation: "set",
      field: "financial.monthlyIncome",
      value: 80_000,
      sourceSpeaker: "customer",
      evidence: "รายได้เดือนละ 80,000 บาท",
    },
    {
      operation: "set",
      field: "personal.age",
      value: { amount: 35 },
      sourceSpeaker: "customer",
      evidence: "อายุ 35 ปี",
    },
  ] }));

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.deepEqual(result.accepted.map((update) => [update.field, update.value]), [
    ["financial.monthlyIncome", 80_000],
  ]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].field, "personal.age");
});

test("transient failures retry up to the cap, then stop requeueing the same audio item", () => {
  let pendingItemIds = ["audio-1"];
  let retryCounts = new Map();

  for (let attempt = 1; attempt < MAX_EXTRACTION_ATTEMPTS; attempt += 1) {
    const result = settleExtractionItems(pendingItemIds, retryCounts, ["audio-1"], false);
    pendingItemIds = result.pendingItemIds;
    retryCounts = result.retryCounts;
    assert.deepEqual(pendingItemIds, ["audio-1"]);
    assert.equal(retryCounts.get("audio-1"), attempt);
    assert.deepEqual(result.exhaustedIds, []);
  }

  const exhausted = settleExtractionItems(pendingItemIds, retryCounts, ["audio-1"], false);
  assert.deepEqual(exhausted.pendingItemIds, []);
  assert.deepEqual(exhausted.exhaustedIds, ["audio-1"]);
});
