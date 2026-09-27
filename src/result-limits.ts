type MultiStoreResult = Record<string, unknown> & {
  store?: unknown;
  ok?: unknown;
  result?: unknown;
};

export function fitMultiStoreResults(results: MultiStoreResult[], characterLimit: number): Record<string, unknown> {
  const fittedResults: MultiStoreResult[] = [...results];
  const omittedStores: string[] = [];
  const succeeded = results.filter((result) => result.ok === true).length;
  const failed = results.length - succeeded;
  const value = () => ({
    count: fittedResults.length,
    succeeded,
    failed,
    responseTruncated: omittedStores.length > 0,
    omittedStores,
    results: fittedResults
  });

  const candidates = fittedResults
    .map((result, index) => ({ index, result, serialized: JSON.stringify(result) }))
    .filter(({ result }) => result.ok === true && result.result !== undefined)
    .sort((left, right) => right.serialized.length - left.serialized.length);
  let serializedLength = JSON.stringify(value()).length;

  for (const candidate of candidates) {
    if (serializedLength <= characterLimit) break;
    const envelope = candidate.result.result && typeof candidate.result.result === "object"
      ? candidate.result.result as Record<string, unknown>
      : {};
    const store = String(candidate.result.store ?? "unknown");
    const previousOmittedLength = JSON.stringify(omittedStores).length;
    omittedStores.push(store);
    const replacement: MultiStoreResult = {
      store,
      ok: true,
      complete: false,
      truncated: true,
      notice: `The response for ${store} was omitted because the combined result exceeded ${characterLimit} characters. Query this store separately or request fewer fields.`,
      ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
      ...(envelope.elapsedMs !== undefined ? { elapsedMs: envelope.elapsedMs } : {})
    };
    fittedResults[candidate.index] = replacement;
    serializedLength += JSON.stringify(replacement).length - candidate.serialized.length;
    serializedLength += JSON.stringify(omittedStores).length - previousOmittedLength;
    if (omittedStores.length === 1) serializedLength -= 1;
  }

  if (serializedLength > characterLimit) {
    throw new Error(`The combined multi-store errors exceed ${characterLimit} characters. Query fewer stores or request fewer fields.`);
  }
  return value();
}

type Data = Record<string, unknown>;

/** Largest write-tool result, in JSON characters. */
export const WRITE_RESULT_CHARACTER_LIMIT = 150_000;

const APPLIED_OUTCOMES = new Set(["applied", "skipped"]);
const STATE_KEYS = ["mutationResponse", "verifiedState", "urlRedirect", "node", "metafield", "fulfillment"];
const IDENTITY_KEYS = ["store", "sku", "id", "variantId", "productId", "ownerId", "namespace", "key", "path", "target", "filename"];
const LONG_STRING = 500;

const isRecord = (value: unknown): value is Data => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isItem = (value: unknown): value is Data => isRecord(value) && ("outcome" in value || "ok" in value);
const isItemArray = (value: unknown): value is Data[] => Array.isArray(value) && value.length > 0 && value.every(isItem);
const size = (value: unknown) => JSON.stringify(value).length;
const itemApplied = (item: Data) => typeof item.outcome === "string" ? APPLIED_OUTCOMES.has(item.outcome) : item.ok === true && !("status" in item && item.status !== "ok");
const hasNestedItems = (item: Data) => Object.values(item).some(isItemArray);

/** The first value stored under key anywhere in value (depth-first, bounded). */
function deepFind(value: unknown, key: string, depth = 0): unknown {
  if (depth > 6 || !value || typeof value !== "object") return undefined;
  if (!Array.isArray(value) && key in value) return (value as Data)[key];
  for (const item of Object.values(value)) {
    const found = deepFind(item, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A state object cut down to its id and the changed fields (the keys of `requested`), or to its top-level scalars. */
function projectState(state: unknown, requested: unknown): unknown {
  if (!isRecord(state)) return state;
  const out: Data = {};
  if (state.id !== undefined) out.id = state.id;
  if (isRecord(requested)) {
    for (const key of Object.keys(requested)) {
      const found = key in state ? state[key] : deepFind(state, key);
      if (found !== undefined) out[key] = found;
    }
    return out;
  }
  for (const [key, value] of Object.entries(state)) if (value === null || typeof value !== "object") out[key] = value;
  return out;
}

/** Only the top-level fields whose values differ between before and after, plus id. */
function changedFields(before: unknown, after: unknown): { before: unknown; after: unknown } {
  if (!isRecord(before) || !isRecord(after)) return { before, after };
  const b: Data = {};
  const a: Data = {};
  if (after.id !== undefined) a.id = after.id;
  if (before.id !== undefined) b.id = before.id;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "id" || JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    b[key] = before[key];
    a[key] = after[key];
  }
  return { before: b, after: a };
}

function slimItem(item: Data): Data {
  const out: Data = { ...item };
  for (const key of STATE_KEYS) if (key in out) out[key] = projectState(out[key], item.requested);
  if (isRecord(out.before) && isRecord(out.after)) Object.assign(out, changedFields(out.before, out.after));
  return out;
}

function shortenStrings(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > LONG_STRING ? `${value.slice(0, LONG_STRING)}...` : value;
  if (depth > 8 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => shortenStrings(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shortenStrings(item, depth + 1)]));
}

function identity(item: Data): Data {
  const out: Data = {};
  for (const key of [...IDENTITY_KEYS, "outcome", "ok", "status", "verification"]) if (item[key] !== undefined) out[key] = item[key];
  if (item.error !== undefined) out.error = String(item.error).slice(0, 200);
  return out;
}

function summaryLine(item: Data): string {
  const label = IDENTITY_KEYS.filter((key) => typeof item[key] === "string" || typeof item[key] === "number").map((key) => `${key}=${String(item[key])}`).join(" ");
  const state = item.outcome ?? (item.ok === true ? "ok" : "not ok");
  return `${label} ${String(state)}${item.verification ? ` (${String(item.verification)})` : ""}`.trim();
}

type Stage = "slim" | "summarize" | "dropSummaries" | "shorten" | "identity";

/** Apply one stage to every item array in value, recursively. */
function applyStage(value: unknown, stage: Stage, counters: { summarized: number; omitted: number }, depth = 0): unknown {
  if (depth > 6 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => applyStage(item, stage, counters, depth + 1));
  const out: Data = {};
  for (const [key, child] of Object.entries(value)) {
    if (stage === "slim" && key === "completedSteps" && Array.isArray(child)) {
      out[key] = child.map((step) => isRecord(step) ? { operation: step.operation, apiVersion: step.apiVersion } : step);
      continue;
    }
    if (!isItemArray(child)) {
      out[key] = applyStage(child, stage, counters, depth + 1);
      continue;
    }
    const nested = child.map((item) => applyStage(item, stage, counters, depth + 1) as Data);
    if (stage === "slim") out[key] = nested.map(slimItem);
    else if (stage === "summarize" && !nested.some(hasNestedItems)) {
      const applied = nested.filter(itemApplied);
      out[key] = nested.filter((item) => !itemApplied(item));
      if (applied.length) {
        const summaryKey = `${key}AppliedSummary`;
        out[summaryKey] = [...((out[summaryKey] as string[] | undefined) ?? []), ...applied.map(summaryLine)];
        counters.summarized += applied.length;
      }
    } else if (stage === "shorten") out[key] = nested.map((item) => shortenStrings(item) as Data);
    else if (stage === "identity") out[key] = nested.map(identity);
    else out[key] = nested;
  }
  if (stage === "dropSummaries") {
    for (const key of Object.keys(out)) {
      if (key.endsWith("AppliedSummary") && Array.isArray(out[key])) {
        counters.omitted += (out[key] as unknown[]).length;
        delete out[key];
      }
    }
  }
  return out;
}

/**
 * Fit a write tool's result under the character limit without ever dropping it: after a write,
 * the caller must learn what happened. Stages, each only when still too large: trim per-item
 * mutation responses and verified state to the changed fields (and before/after to the fields
 * that differ); replace applied items with one summary line each; drop the summary lines (the
 * counts stay); shorten long strings; cut non-applied items to identity, outcome and error.
 * Top-level status and counts, and every item that did not apply, are always kept.
 */
export function fitWriteResult<T extends Data>(value: T, characterLimit = WRITE_RESULT_CHARACTER_LIMIT): Data {
  if (size(value) <= characterLimit) return value;
  const counters = { summarized: 0, omitted: 0 };
  let current: Data = value;
  const stages: Stage[] = ["slim", "summarize", "dropSummaries", "shorten", "identity"];
  let reached: Stage = "slim";
  for (const stage of stages) {
    reached = stage;
    current = applyStage(current, stage, counters) as Data;
    if (size(current) <= characterLimit) break;
  }
  const trimmed: Data = {
    stage: reached,
    ...(counters.summarized ? { appliedItemsSummarized: counters.summarized } : {}),
    ...(counters.omitted ? { appliedSummaryLinesOmitted: counters.omitted } : {}),
    notice: `The full result exceeded ${characterLimit} characters and was trimmed. Status, counts, and every item that did not apply are kept; read the records back for full detail. Nothing here means the write failed.`,
  };
  const fitted = { ...current, responseTrimmed: trimmed };
  if (size(fitted) <= characterLimit) return fitted;
  // Last resort: top-level scalars and the identity of each item that did not apply.
  const minimal: Data = { responseTrimmed: { ...trimmed, stage: "minimal" } };
  for (const [key, child] of Object.entries(current)) {
    if (child === null || typeof child !== "object") minimal[key] = child;
    else if (isItemArray(child)) minimal[key] = child.filter((item) => !itemApplied(item)).map(identity);
    else if (Array.isArray(child) && child.every((item) => typeof item === "string")) minimal[`${key}Count`] = child.length;
  }
  return minimal;
}
