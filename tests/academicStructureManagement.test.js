import test from "node:test";
import assert from "node:assert/strict";
import {
    normalizeSourceClassIds,
    normalizeSubjectRules,
    normalizeWorkspaceCode,
    validateAdministrativeClassFields,
    validateCourseGroupFields,
    validateGradeFields,
    validateSubjectFields,
} from "../domain/academicStructureManagement.js";

test("subject rules allow any administrative-class and walking-class combination", () => {
    const result = normalizeSubjectRules([
        {subjectId: "history", deliveryMode: "ADMIN_CLASS"},
        {subjectId: "geography", deliveryMode: "ADMIN_CLASS"},
        {subjectId: "politics", deliveryMode: "ADMIN_CLASS"},
        {subjectId: "physics", deliveryMode: "COURSE_GROUP"},
    ]);
    assert.equal(result.valid, true);
    assert.deepEqual(result.rules.map((item) => item.deliveryMode), [
        "ADMIN_CLASS",
        "ADMIN_CLASS",
        "ADMIN_CLASS",
        "COURSE_GROUP",
    ]);
});

test("subject rule normalization rejects duplicates and unknown modes", () => {
    const result = normalizeSubjectRules([
        {subjectId: "physics", deliveryMode: "ADMIN_CLASS"},
        {subjectId: "physics", deliveryMode: "NOT_OFFERED"},
    ]);
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 2);
});

test("course group sources are unique and workspace codes are normalized", () => {
    assert.deepEqual(normalizeSourceClassIds(["c1", "c1", " c2 ", ""]), ["c1", "c2"]);
    assert.equal(normalizeWorkspaceCode(" g2-his-b1 "), "G2-HIS-B1");
    assert.deepEqual(validateCourseGroupFields({
        code: "G2-HIS-B1",
        name: "历史B1",
        subjectId: "history",
        sourceClassIds: ["c3"],
    }), []);
});

test("grade and administrative class fields support visual management", () => {
    assert.deepEqual(validateGradeFields({code: "G2", name: "高二", sortOrder: 20}), []);
    assert.deepEqual(validateAdministrativeClassFields({code: "G2-C01", name: "高二1班", gradeId: "grade-2"}), []);
    assert.ok(validateGradeFields({code: "?", name: "", sortOrder: 1.5}).length >= 2);
    assert.ok(validateAdministrativeClassFields({code: "!", name: "", gradeId: ""}).length >= 2);
});

test("subject fields support safe visual editing", () => {
    assert.deepEqual(validateSubjectFields({code: "IT", name: "信息技术", category: "OTHER", sortOrder: 100}), []);
    assert.ok(validateSubjectFields({code: "?", name: "", category: "UNKNOWN", sortOrder: 1.2}).length >= 3);
});
