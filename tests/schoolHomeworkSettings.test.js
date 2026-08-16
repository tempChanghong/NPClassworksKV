import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_HOMEWORK_QUICK_DEADLINES,
    DEFAULT_HOMEWORK_QUICK_INPUTS,
    sanitizeHomeworkQuickDeadlines,
    sanitizeHomeworkQuickInputs,
} from "../domain/schoolHomeworkSettings.js";

test("homework quick deadlines use school defaults when unset", () => {
    assert.deepEqual(sanitizeHomeworkQuickDeadlines(null), DEFAULT_HOMEWORK_QUICK_DEADLINES);
});

test("homework quick inputs use defaults, support subject scopes, and may be disabled", () => {
    assert.deepEqual(sanitizeHomeworkQuickInputs(null), DEFAULT_HOMEWORK_QUICK_INPUTS);
    const custom = [{label: "读两遍", text: "朗读两遍", group: "语文", subjectIds: ["chinese", "chinese"], insertMode: "NEW_LINE"}];
    assert.deepEqual(sanitizeHomeworkQuickInputs(custom, {strict: true}), [{...custom[0], subjectIds: ["chinese"]}]);
    assert.deepEqual(sanitizeHomeworkQuickInputs([], {strict: true}), []);
});

test("homework quick inputs reject invalid inline entries", () => {
    assert.throws(() => sanitizeHomeworkQuickInputs([{label: "空内容", text: "", insertMode: "INLINE"}], {strict: true}), /无效/);
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

test("homework quick deadlines accept next-weekday rules", () => {
    const preset = {label: "下周一 7:30", dateRule: "next-weekday", weekday: 1, time: "07:30"};
    assert.deepEqual(sanitizeHomeworkQuickDeadlines([preset], {strict: true}), [preset]);
    assert.ok(DEFAULT_HOMEWORK_QUICK_DEADLINES.some((item) => item.dateRule === "next-weekday" && item.weekday === 1));
});
