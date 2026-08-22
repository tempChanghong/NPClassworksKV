import test from "node:test";
import assert from "node:assert/strict";
import {mapWithConcurrency} from "../utils/asyncPool.js";

test("bounded async mapping preserves order and never exceeds its concurrency", async () => {
    let active = 0;
    let peak = 0;
    const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (value) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, value % 2 ? 4 : 1));
        active -= 1;
        return value * 2;
    });
    assert.deepEqual(result, [2, 4, 6, 8, 10, 12]);
    assert.equal(peak, 3);
});

test("bounded async mapping accepts an empty collection", async () => {
    assert.deepEqual(await mapWithConcurrency([], 4, async (value) => value), []);
});
