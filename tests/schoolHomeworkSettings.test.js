import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_HOMEWORK_QUICK_DEADLINES,
    sanitizeHomeworkQuickDeadlines,
} from "../domain/schoolHomeworkSettings.js";

test("homework quick deadlines use school defaults when unset", () => {
    assert.deepEqual(sanitizeHomeworkQuickDeadlines(null), DEFAULT_HOMEWORK_QUICK_DEADLINES);
});

test("homework quick deadlines accept a bounded custom school schedule", () => {
    assert.deepEqual(sanitizeHomeworkQuickDeadlines([
        {label: "次日晨读", dayOffset: 1, time: "07:10"},
        {label: "周末前", dayOffset: 5, time: "18:30"},
    ], {strict: true}), [
        {label: "次日晨读", dayOffset: 1, time: "07:10"},
        {label: "周末前", dayOffset: 5, time: "18:30"},
    ]);
});

test("homework quick deadlines reject invalid or excessive values", () => {
    assert.throws(() => sanitizeHomeworkQuickDeadlines([
        {label: "错误", dayOffset: -1, time: "25:00"},
    ], {strict: true}), /无效/);
    assert.throws(() => sanitizeHomeworkQuickDeadlines([], {strict: true}), /1至8项/);
});
