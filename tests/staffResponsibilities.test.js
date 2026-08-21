import test from "node:test";
import assert from "node:assert/strict";
import {
    buildStaffResponsibilityDiagnostics,
    normalizeClassLeadershipInput,
    normalizeGradeLeadershipInput,
} from "../domain/staffResponsibilities.js";

test("职责输入规范化岗位名称并校验作用域", () => {
    assert.equal(normalizeGradeLeadershipInput({gradeId: "g2", accountId: "a1", position: "deputy"}).valid, true);
    assert.equal(normalizeClassLeadershipInput({position: "owner"}).valid, false);
});

test("岗位联动诊断发现年级组长和班主任缺少任课关系", () => {
    const account = {id: "teacher", name: "张老师", localDisabled: false};
    const grades = [{
        id: "g2",
        name: "高二",
        leaderships: [{accountId: account.id, position: "PRIMARY", account, isActive: true}],
        teachingAssignments: [],
    }];
    const administrativeClasses = [{
        id: "c1",
        gradeId: "g2",
        name: "高二1班",
        leaderships: [{accountId: account.id, position: "HEAD_TEACHER", account, isActive: true}],
        isActive: true,
    }];
    const diagnostics = buildStaffResponsibilityDiagnostics({
        school: {gradeLeaderMustBeHomeroom: true, gradeLeaderMustTeach: true, homeroomMustTeach: true},
        grades,
        administrativeClasses,
    });
    assert.deepEqual(diagnostics.map((item) => item.code), ["GRADE_LEADER_NOT_TEACHING", "HOMEROOM_NOT_TEACHING"]);
});
