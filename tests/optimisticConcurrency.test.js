import assert from "node:assert/strict";
import test from "node:test";
import {
    parseExpectedUpdatedAt,
    updateVersionedRecord,
} from "../services/optimisticConcurrencyService.js";

test("expectedUpdatedAt accepts an ISO timestamp and rejects malformed values", () => {
    assert.equal(parseExpectedUpdatedAt(undefined), null);
    assert.equal(parseExpectedUpdatedAt("2026-08-24T10:00:00.000Z").toISOString(), "2026-08-24T10:00:00.000Z");
    assert.throws(() => parseExpectedUpdatedAt("not-a-date"), {code: "EXPECTED_UPDATED_AT_INVALID"});
});

test("versioned update rejects a stale organization record", async () => {
    const current = {id: "subject-1", updatedAt: new Date("2026-08-24T10:01:00.000Z")};
    const client = {
        subject: {
            updateMany: async () => ({count: 0}),
            findUnique: async () => current,
        },
    };
    await assert.rejects(
        updateVersionedRecord({
            client,
            model: "subject",
            id: current.id,
            expectedUpdatedAt: "2026-08-24T10:00:00.000Z",
            data: {name: "物理"},
        }),
        (error) => error.code === "ORGANIZATION_VERSION_CONFLICT" &&
            error.statusCode === 409 &&
            error.details.current.id === current.id,
    );
});

test("versioned update writes when the organization version still matches", async () => {
    const calls = [];
    const current = {id: "grade-1", updatedAt: new Date("2026-08-24T10:01:00.000Z")};
    const client = {
        grade: {
            updateMany: async (input) => {
                calls.push(input);
                return {count: 1};
            },
            findUnique: async () => current,
        },
    };
    const result = await updateVersionedRecord({
        client,
        model: "grade",
        id: current.id,
        expectedUpdatedAt: "2026-08-24T10:00:00.000Z",
        data: {name: "高二"},
    });
    assert.equal(result, current);
    assert.equal(calls[0].where.updatedAt.toISOString(), "2026-08-24T10:00:00.000Z");
});
