export function fitMultiStoreResults(results, characterLimit) {
    const fittedResults = [...results];
    const omittedStores = [];
    const value = () => ({
        count: fittedResults.length,
        succeeded: fittedResults.filter((result) => result.ok === true).length,
        failed: fittedResults.filter((result) => result.ok !== true).length,
        responseTruncated: omittedStores.length > 0,
        omittedStores,
        results: fittedResults
    });
    while (JSON.stringify(value()).length > characterLimit) {
        const candidates = fittedResults
            .map((result, index) => ({ index, result, size: JSON.stringify(result).length }))
            .filter(({ result }) => result.ok === true && result.result !== undefined)
            .sort((left, right) => right.size - left.size);
        const candidate = candidates[0];
        if (!candidate)
            break;
        const envelope = candidate.result.result && typeof candidate.result.result === "object"
            ? candidate.result.result
            : {};
        const store = String(candidate.result.store ?? "unknown");
        omittedStores.push(store);
        fittedResults[candidate.index] = {
            store,
            ok: false,
            complete: false,
            truncated: true,
            error: `The response for ${store} was omitted because the combined result exceeded ${characterLimit} characters. Query this store separately or request fewer fields.`,
            ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
            ...(envelope.elapsedMs !== undefined ? { elapsedMs: envelope.elapsedMs } : {})
        };
    }
    return value();
}
//# sourceMappingURL=result-limits.js.map