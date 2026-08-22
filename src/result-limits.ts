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
