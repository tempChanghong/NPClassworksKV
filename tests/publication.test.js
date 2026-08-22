import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_NOTICE_LIFETIME_MS,
    earliestPublicationTransition,
    validatePublicationSnapshot,
} from "../domain/publication.js";
import {
    SUBJECT_DELIVERY_MODES,
    WORKSPACE_TYPES,
} from "../domain/academicCatalog.js";

const term = {
    id: "term-2026-1",
    schoolId: "school-1",
    status: "ACTIVE",
    school: {id: "school-1"},
};

function adminClass(id, name, deliveryMode) {
    return {
        id,
        name,
        type: WORKSPACE_TYPES.ADMIN_CLASS,
        termId: term.id,
        term,
        subjectId: null,
        subjectRules: [{subjectId: "physics", deliveryMode}],
    };
}

function courseGroup(id, name, subjectId = "physics") {
    return {
        id,
        name,
        type: WORKSPACE_TYPES.COURSE_GROUP,
        termId: term.id,
        term,
        subjectId,
        subjectRules: [],
    };
}

function assignment(targetWorkspaceIds) {
    return {
        type: "ASSIGNMENT",
        subjectId: "physics",
        content: "完成练习册第10页",
        status: "PUBLISHED",
        boardDate: "2026-08-10",
        publishAt: "2026-08-09T08:00:00.000Z",
        dueAt: "2026-08-10T08:00:00.000Z",
        targetWorkspaceIds,
    };
}

test("Class 1 and Class 2 minor subjects can publish directly to the administrative class", () => {
    const classOne = adminClass("g2-c1", "高二1班", SUBJECT_DELIVERY_MODES.ADMIN_CLASS);
    const classTwo = adminClass("g2-c2", "高二2班", SUBJECT_DELIVERY_MODES.ADMIN_CLASS);
    const result = validatePublicationSnapshot({
        input: assignment([classOne.id, classTwo.id]),
        workspaces: [classOne, classTwo],
    });

    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
});

test("a streamed subject cannot be assigned to the administrative class", () => {
    const classFive = adminClass("g2-c5", "高二5班", SUBJECT_DELIVERY_MODES.COURSE_GROUP);
    const result = validatePublicationSnapshot({
        input: assignment([classFive.id]),
        workspaces: [classFive],
    });

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === "COURSE_GROUP_TARGET_REQUIRED"));
});

test("a streamed assignment can target the matching course group", () => {
    const physicsA1 = courseGroup("g2-physics-a1", "物理A1");
    const result = validatePublicationSnapshot({
        input: assignment([physicsA1.id]),
        workspaces: [physicsA1],
    });

    assert.equal(result.valid, true);
});

test("a course group rejects an assignment for another subject", () => {
    const chemistryA2 = courseGroup("g2-chemistry-a2", "化学A2", "chemistry");
    const result = validatePublicationSnapshot({
        input: assignment([chemistryA2.id]),
        workspaces: [chemistryA2],
    });

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === "COURSE_GROUP_SUBJECT_MISMATCH"));
});

test("notices may target mixed administrative classes and course groups without a subject", () => {
    const classFive = adminClass("g2-c5", "高二5班", SUBJECT_DELIVERY_MODES.COURSE_GROUP);
    const physicsA1 = courseGroup("g2-physics-a1", "物理A1");
    const result = validatePublicationSnapshot({
        input: {
            type: "NOTICE",
            title: "临时调课",
            content: "明日第一节课调整",
            status: "PUBLISHED",
            targetWorkspaceIds: [classFive.id, physicsA1.id],
        },
        workspaces: [classFive, physicsA1],
    });

    assert.equal(result.valid, true);
});

test("notices without an explicit expiry default to three days after publication", () => {
    const classOne = adminClass("g2-c1", "高二1班", SUBJECT_DELIVERY_MODES.ADMIN_CLASS);
    const publishAt = "2026-08-09T08:15:30.000Z";
    const result = validatePublicationSnapshot({
        input: {
            type: "NOTICE",
            title: "临时通知",
            status: "PUBLISHED",
            publishAt,
            targetWorkspaceIds: [classOne.id],
        },
        workspaces: [classOne],
    });

    assert.equal(result.valid, true);
    assert.equal(
        result.normalized.expiresAt.getTime(),
        new Date(publishAt).getTime() + DEFAULT_NOTICE_LIFETIME_MS,
    );
    assert.equal(result.normalized.expiresAt.toISOString(), "2026-08-12T08:15:30.000Z");
});

test("an explicit notice expiry overrides the three-day default", () => {
    const classOne = adminClass("g2-c1", "高二1班", SUBJECT_DELIVERY_MODES.ADMIN_CLASS);
    const expiresAt = "2026-08-20T12:00:00.000Z";
    const result = validatePublicationSnapshot({
        input: {
            type: "NOTICE",
            title: "长期通知",
            status: "PUBLISHED",
            publishAt: "2026-08-09T08:00:00.000Z",
            expiresAt,
            targetWorkspaceIds: [classOne.id],
        },
        workspaces: [classOne],
    });

    assert.equal(result.valid, true);
    assert.equal(result.normalized.expiresAt.toISOString(), expiresAt);
});

test("targets from different terms are rejected", () => {
    const classOne = adminClass("g2-c1", "高二1班", SUBJECT_DELIVERY_MODES.ADMIN_CLASS);
    const otherTermClass = {
        ...adminClass("g2-c2", "高二2班", SUBJECT_DELIVERY_MODES.ADMIN_CLASS),
        termId: "term-2027-1",
        term: {...term, id: "term-2027-1"},
    };
    const result = validatePublicationSnapshot({
        input: assignment([classOne.id, otherTermClass.id]),
        workspaces: [classOne, otherTermClass],
    });

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === "CROSS_TERM_TARGETS"));
});

test("due time cannot be earlier than publish time", () => {
    const classOne = adminClass("g2-c1", "高二1班", SUBJECT_DELIVERY_MODES.ADMIN_CLASS);
    const input = assignment([classOne.id]);
    input.dueAt = "2026-08-08T08:00:00.000Z";
    const result = validatePublicationSnapshot({input, workspaces: [classOne]});

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === "DUE_BEFORE_PUBLISH"));
});

test("published content cannot have both an empty title and body", () => {
    const classOne = adminClass("g2-c1", "高二1班", SUBJECT_DELIVERY_MODES.ADMIN_CLASS);
    const input = assignment([classOne.id]);
    input.content = "  ";
    const result = validatePublicationSnapshot({input, workspaces: [classOne]});

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === "PUBLICATION_CONTENT_REQUIRED"));
});

test("assignments require a strict calendar date while notices remain date-independent", () => {
    const classOne = adminClass("g2-c1", "高二1班", SUBJECT_DELIVERY_MODES.ADMIN_CLASS);
    const missingDate = assignment([classOne.id]);
    delete missingDate.boardDate;
    const assignmentResult = validatePublicationSnapshot({input: missingDate, workspaces: [classOne]});
    assert.equal(assignmentResult.valid, false);
    assert.ok(assignmentResult.errors.some((error) => error.code === "BOARD_DATE_REQUIRED"));

    const noticeResult = validatePublicationSnapshot({
        input: {
            type: "NOTICE",
            title: "持续通知",
            status: "PUBLISHED",
            boardDate: "not-a-date",
            targetWorkspaceIds: [classOne.id],
        },
        workspaces: [classOne],
    });
    assert.equal(noticeResult.valid, true);
    assert.equal(noticeResult.normalized.boardDate, null);
});

test("the feed chooses the earliest scheduled publish or expiry boundary", () => {
    assert.equal(
        earliestPublicationTransition(
            "2026-08-09T10:30:00.000Z",
            "2026-08-09T10:00:00.000Z",
        ).toISOString(),
        "2026-08-09T10:00:00.000Z",
    );
    assert.equal(earliestPublicationTransition(null, undefined), null);
});
