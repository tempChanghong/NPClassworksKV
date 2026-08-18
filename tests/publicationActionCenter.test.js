import assert from "node:assert/strict";
import test from "node:test";
import {
    ACTION_REQUIRED_REASONS,
    classifyActionRequiredPublication,
    compareActionRequiredItems,
    summarizePublicationChanges,
} from "../domain/publicationActionCenter.js";

function publication(overrides = {}) {
    return {
        id: "publication-1",
        revision: 2,
        type: "ASSIGNMENT",
        subjectId: "physics",
        title: "练习册",
        content: "完成第 10 页",
        boardDate: "2026-08-18",
        publishAt: "2026-08-18T00:00:00.000Z",
        dueAt: "2026-08-19T00:00:00.000Z",
        expiresAt: null,
        priority: "NORMAL",
        status: "PUBLISHED",
        latestActorType: "CLASSROOM_SCREEN",
        updatedAt: "2026-08-18T01:00:00.000Z",
        targets: [{workspaceId: "class-1"}],
        revisions: [],
        ...overrides,
    };
}

test("new screen publication becomes a created-by-screen action", () => {
    const item = classifyActionRequiredPublication(publication(), {
        now: new Date("2026-08-18T12:00:00.000Z"),
    });
    assert.equal(item.reason, ACTION_REQUIRED_REASONS.CREATED_BY_SCREEN);
    assert.equal(item.dueSoon, true);
    assert.equal(item.overdue, false);
});

test("a screen edit after certification is classified as highest-risk and includes a diff", () => {
    const item = classifyActionRequiredPublication(publication({
        content: "完成第 12 页",
        revisions: [{
            revision: 1,
            snapshot: {
                title: "练习册",
                content: "完成第 10 页",
                subjectId: "physics",
                boardDate: "2026-08-18",
                publishAt: "2026-08-18T00:00:00.000Z",
                dueAt: "2026-08-19T00:00:00.000Z",
                expiresAt: null,
                priority: "NORMAL",
                targetWorkspaceIds: ["class-1"],
            },
        }],
    }), {now: new Date("2026-08-18T12:00:00.000Z")});
    assert.equal(item.reason, ACTION_REQUIRED_REASONS.CHANGED_AFTER_CERTIFICATION);
    assert.equal(item.severity, "HIGH");
    assert.deepEqual(item.changedFields.map((change) => change.field), ["content"]);
});

test("target order does not create a false diff", () => {
    assert.deepEqual(summarizePublicationChanges(
        {targetWorkspaceIds: ["a", "b"]},
        {targetWorkspaceIds: ["b", "a"]},
    ), []);
});

test("changed-after-certification sorts before ordinary screen entries", () => {
    const changed = {reason: ACTION_REQUIRED_REASONS.CHANGED_AFTER_CERTIFICATION, overdue: false, dueSoon: false,
        publication: {priority: "NORMAL", updatedAt: "2026-08-18T02:00:00.000Z"}};
    const created = {reason: ACTION_REQUIRED_REASONS.CREATED_BY_SCREEN, overdue: true, dueSoon: false,
        publication: {priority: "URGENT", updatedAt: "2026-08-18T01:00:00.000Z"}};
    assert.ok(compareActionRequiredItems(changed, created) < 0);
});
