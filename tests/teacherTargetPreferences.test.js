import test from "node:test";
import assert from "node:assert/strict";
import {
    sanitizeTeacherTargetPreferences,
    teacherTargetCombinationId,
} from "../domain/teacherTargetPreferences.js";

const fixedNow = () => new Date("2026-08-11T00:00:00.000Z");

test("teacher target preferences normalize ids and remove duplicates", () => {
    const input = {
        favorites: [
            {type: "NOTICE", targetWorkspaceIds: ["b", "a", "a"]},
            {type: "NOTICE", targetWorkspaceIds: ["a", "b"]},
        ],
    };
    const result = sanitizeTeacherTargetPreferences(input, fixedNow);
    assert.equal(result.favorites.length, 1);
    assert.deepEqual(result.favorites[0].targetWorkspaceIds, ["a", "b"]);
    assert.equal(result.favorites[0].savedAt, "2026-08-11T00:00:00.000Z");
});

test("teacher target preference limits bound server-side payload size", () => {
    const favorites = Array.from({length: 20}, (_, index) => ({
        type: "ASSIGNMENT",
        subjectId: `subject-${index}`,
        targetWorkspaceIds: Array.from({length: 30}, (__, targetIndex) => `workspace-${index}-${targetIndex}`),
    }));
    const result = sanitizeTeacherTargetPreferences({favorites}, fixedNow);
    assert.equal(result.favorites.length, 8);
    assert.equal(result.favorites[0].targetWorkspaceIds.length, 20);
});

test("teacher target combination ids do not depend on target order", () => {
    assert.equal(
        teacherTargetCombinationId({type: "NOTICE", targetWorkspaceIds: ["b", "a"]}),
        teacherTargetCombinationId({type: "NOTICE", targetWorkspaceIds: ["a", "b"]}),
    );
});
