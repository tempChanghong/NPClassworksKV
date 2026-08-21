import test from "node:test";
import assert from "node:assert/strict";
import {
    buildTeachingRelationshipDiagnostics,
    normalizeTeachingAssignmentBatchInput,
    normalizeTeachingAssignmentInput,
} from "../domain/teachingRelationships.js";

test("任课关系输入必须同时提供教师、空间和科目", () => {
    const result = normalizeTeachingAssignmentInput({position: "unknown"});
    assert.equal(result.valid, false);
    assert.deepEqual(result.errors.map((item) => item.path), ["workspaceId", "subjectId", "accountId", "position"]);
});

test("批量任课输入去重教学空间并限制数量", () => {
    const result = normalizeTeachingAssignmentBatchInput({
        accountId: "teacher-1",
        subjectId: "physics",
        position: "co_teacher",
        workspaceIds: ["class-1", "class-1", "physics-a1"],
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.value.workspaceIds, ["class-1", "physics-a1"]);
    assert.equal(result.value.position, "CO_TEACHER");
});

test("诊断随班缺教师、走班无覆盖和教学班缺来源", () => {
    const physics = {id: "physics", name: "物理"};
    const administrativeClasses = [{
        id: "class-3",
        name: "高二3班",
        gradeId: "grade-2",
        isActive: true,
        subjectRules: [
            {subjectId: "chinese", deliveryMode: "ADMIN_CLASS", subject: {name: "语文"}, assignments: []},
            {subjectId: physics.id, deliveryMode: "COURSE_GROUP", subject: physics, assignments: []},
        ],
    }];
    const courseGroups = [{
        id: "physics-a1",
        name: "物理A1",
        gradeId: "grade-2",
        subjectId: physics.id,
        isActive: true,
        sourceClasses: [],
        assignments: [],
    }];
    const codes = buildTeachingRelationshipDiagnostics({administrativeClasses, courseGroups})
        .map((item) => item.code);
    assert.deepEqual(codes, [
        "ADMIN_CLASS_SUBJECT_WITHOUT_TEACHER",
        "WALKING_SUBJECT_WITHOUT_GROUP",
        "COURSE_GROUP_WITHOUT_SOURCE",
        "COURSE_GROUP_WITHOUT_TEACHER",
    ]);
});

test("有效的走班来源和教师关系不会产生结构诊断", () => {
    const assignment = {id: "assignment", isActive: true, position: "PRIMARY", hasWorkspaceAccess: true};
    const administrativeClasses = [{
        id: "class-3",
        name: "高二3班",
        gradeId: "grade-2",
        isActive: true,
        subjectRules: [{
            subjectId: "physics",
            deliveryMode: "COURSE_GROUP",
            subject: {id: "physics", name: "物理"},
            assignments: [],
        }],
    }];
    const courseGroups = [{
        id: "physics-a1",
        name: "物理A1",
        gradeId: "grade-2",
        subjectId: "physics",
        isActive: true,
        sourceClasses: [{administrativeClassId: "class-3"}],
        assignments: [assignment],
    }];
    assert.deepEqual(buildTeachingRelationshipDiagnostics({administrativeClasses, courseGroups}), []);
});

test("诊断行政班中已经不符合授课规则的遗留任课关系", () => {
    const administrativeClasses = [{
        id: "class-1",
        name: "高二1班",
        gradeId: "grade-2",
        isActive: true,
        subjectRules: [{
            subjectId: "physics",
            deliveryMode: "COURSE_GROUP",
            subject: {id: "physics", name: "物理"},
            assignments: [],
        }],
        assignments: [{
            id: "old-assignment",
            workspaceId: "class-1",
            subjectId: "physics",
            accountId: "teacher-1",
            position: "PRIMARY",
            isActive: true,
            hasWorkspaceAccess: true,
        }],
    }];
    const courseGroups = [{
        id: "physics-a1",
        name: "物理A1",
        gradeId: "grade-2",
        subjectId: "physics",
        isActive: true,
        sourceClasses: [{administrativeClassId: "class-1"}],
        assignments: [{id: "assignment", isActive: true, position: "PRIMARY", hasWorkspaceAccess: true}],
    }];
    assert.equal(
        buildTeachingRelationshipDiagnostics({administrativeClasses, courseGroups})
            .some((item) => item.code === "TEACHING_ASSIGNMENT_SUBJECT_CONFLICT"),
        true,
    );
});
