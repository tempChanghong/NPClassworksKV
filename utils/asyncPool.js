export async function mapWithConcurrency(items, concurrency, mapper) {
    const values = Array.from(items || []);
    if (values.length === 0) return [];
    const workerCount = Math.min(
        values.length,
        Math.max(1, Math.floor(Number(concurrency) || 1)),
    );
    const results = new Array(values.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < values.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await mapper(values[index], index);
        }
    }

    await Promise.all(Array.from({length: workerCount}, () => worker()));
    return results;
}
