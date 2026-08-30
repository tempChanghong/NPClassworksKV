import assert from "node:assert/strict";
import test from "node:test";
import {sanitizeAuditValue} from "../domain/auditLog.js";
import {classroomScreenDutyState, normalizeScreenRuntimeStatus} from "../domain/classroomScreenDuty.js";
import {validateStudentCourseSelection} from "../domain/academicCatalog.js";

const courseOptions = {
    subjects: [
        {
            subject: {id: "physics", name: "物理"},
            requiresCourseGroupSelection: true,
            isCompulsory: false,
            courseGroups: [{id: "physics-a1", name: "物理A1"}],
        },
        {
            subject: {id: "chemistry", name: "化学"},
            requiresCourseGroupSelection: true,
            isCompulsory: false,
            courseGroups: [{id: "chemistry-a2", name: "化学A2"}],
        },
        {
            subject: {id: "chinese", name: "语文"},
            requiresCourseGroupSelection: false,
            isCompulsory: true,
            courseGroups: [],
        },
    ],
};

test("student selection requires an explicit decision for every streamed subject", () => {
    const result = validateStudentCourseSelection(courseOptions, {
        courseGroupIds: {physics: "physics-a1"},
    });
    assert.equal(result.valid, false);
    assert.equal(result.issues[0].code, "SELECTION_DECISION_REQUIRED");
    assert.equal(result.issues[0].subjectId, "chemistry");
});

test("student selection accepts a class choice plus an explicit not-taking decision", () => {
    const result = validateStudentCourseSelection(courseOptions, {
        courseGroupIds: {physics: "physics-a1", chinese: "legacy"},
        declinedSubjectIds: ["chemistry"],
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.normalized, {
        courseGroupIds: {physics: "physics-a1"},
        declinedSubjectIds: ["chemistry"],
    });
    assert.equal(result.issues[0].code, "SUBJECT_NO_LONGER_STREAMED");
});

test("student selection rejects a course group outside the administrative class", () => {
    const result = validateStudentCourseSelection(courseOptions, {
        courseGroupIds: {physics: "physics-b9"},
        declinedSubjectIds: ["chemistry"],
    });
    assert.equal(result.valid, false);
    assert.equal(result.issues[0].code, "COURSE_GROUP_NOT_AVAILABLE");
});

test("audit metadata recursively redacts credentials", () => {
    assert.deepEqual(sanitizeAuditValue({
        name: "screen",
        pin: "123456",
        nested: {accessToken: "secret", enabled: true},
    }), {
        name: "screen",
        pin: "[REDACTED]",
        nested: {accessToken: "[REDACTED]", enabled: true},
    });
});

test("audit metadata never records a migration passphrase", () => {
    const result = sanitizeAuditValue({passphrase: "migration-secret", confirmationSchoolCode: "SCHOOL"});
    assert.equal(result.passphrase, "[REDACTED]");
    assert.equal(result.confirmationSchoolCode, "SCHOOL");
});

test("screen duty distinguishes online, degraded and offline devices", () => {
    const now = Date.now();
    const base = {
        isActive: true,
        activatedAt: new Date(now - 60_000),
        lastHeartbeatAt: new Date(now - 30_000),
        runtimeStatus: normalizeScreenRuntimeStatus({online: true, realtimeConnected: true, syncState: "synced"}),
    };
    assert.equal(classroomScreenDutyState(base, now), "ONLINE");
    assert.equal(classroomScreenDutyState({...base, runtimeStatus: {...base.runtimeStatus, pendingUploads: 1}}, now), "DEGRADED");
    assert.equal(classroomScreenDutyState({...base, lastHeartbeatAt: new Date(now - 6 * 60_000)}, now), "OFFLINE");
});
