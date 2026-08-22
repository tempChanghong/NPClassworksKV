import test from "node:test";
import assert from "node:assert/strict";
import {validateStaffConfigurationImport} from "../domain/staffConfigurationImport.js";

function configuration() {
    return {
        schemaVersion: 1,
        schoolCode: "school-1",
        term: {academicYear: 2026, semester: 1},
        teachers: [{
            username: "wang.physics",
            name: "王老师",
            credential: {mode: "GENERATE_PIN"},
            teachingAssignments: [
                {workspaceCode: "g2-c1", subjectCode: "phy", position: "primary"},
                {workspaceCode: "g2-phy-a1", subjectCode: "phy", position: "primary"},
            ],
            responsibilities: {
                gradeLeaderships: [{gradeCode: "g2", position: "primary"}],
                classLeaderships: [{classCode: "g2-c1", position: "head_teacher"}],
            },
        }],
    };
}

test("normalizes a complete teacher, teaching and responsibility configuration", () => {
    const result = validateStaffConfigurationImport(configuration(), "LOCAL_PIN");
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.equal(result.normalized.schoolCode, "SCHOOL-1");
    assert.equal(result.normalized.teachers[0].teachingAssignments[0].workspaceCode, "G2-C1");
    assert.equal(result.summary.teachers, 1);
    assert.equal(result.summary.teachingAssignments, 2);
    assert.equal(result.summary.gradeLeaderships, 1);
    assert.equal(result.summary.classLeaderships, 1);
});

test("accepts fixed PIN credentials and rejects duplicate teacher identities", () => {
    const document = configuration();
    document.teachers[0].credential = {mode: "FIXED_PIN", pin: "527391"};
    document.teachers.push({...document.teachers[0]});
    const result = validateStaffConfigurationImport(document, "LOCAL_PIN");
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === "DUPLICATE_TEACHER"));
    assert.ok(result.errors.some((error) => error.code === "DUPLICATE_FIXED_PIN"));
});

test("shared-password schools do not accept personal PIN credential modes", () => {
    const result = validateStaffConfigurationImport(configuration(), "SHARED_PASSWORD");
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === "CREDENTIAL_MODE_MISMATCH"));

    const document = configuration();
    document.teachers[0].credential = {mode: "SHARED_PASSWORD"};
    assert.equal(validateStaffConfigurationImport(document, "SHARED_PASSWORD").valid, true);
});

test("warns when a grade leader has no class or teaching responsibility", () => {
    const document = configuration();
    document.teachers[0].teachingAssignments = [];
    document.teachers[0].responsibilities.classLeaderships = [];
    const result = validateStaffConfigurationImport(document, "LOCAL_PIN");
    assert.equal(result.valid, true);
    assert.ok(result.warnings.some((warning) => warning.code === "TEACHER_WITHOUT_ASSIGNMENT"));
    assert.ok(result.warnings.some((warning) => warning.code === "GRADE_LEADER_WITHOUT_HOMEROOM"));
});
