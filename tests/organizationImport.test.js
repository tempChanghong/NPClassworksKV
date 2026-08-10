import test from "node:test";
import assert from "node:assert/strict";
import {validateOrganizationImport} from "../domain/organizationImport.js";
import {readFileSync} from "node:fs";

function baseDocument() {
    return {
        school: {code: "school", name: "示例中学"},
        term: {name: "2026-2027上", academicYear: 2026, semester: 1, status: "ACTIVE"},
        grade: {code: "g2", name: "高二", sortOrder: 2},
        subjects: [
            {code: "CHN", name: "语文", category: "CORE", sortOrder: 10},
            {code: "PHY", name: "物理", category: "ELECTIVE", sortOrder: 40},
        ],
        administrativeClasses: [
            {
                code: "G2-C1",
                name: "高二1班",
                subjectRules: {CHN: "ADMIN_CLASS", PHY: "ADMIN_CLASS"},
            },
            {
                code: "G2-C5",
                name: "高二5班",
                subjectRules: {CHN: "ADMIN_CLASS", PHY: "COURSE_GROUP"},
            },
        ],
        courseGroups: [
            {code: "G2-PHY-A1", name: "物理A1", subject: "PHY", sourceClasses: ["G2-C5"]},
        ],
    };
}

test("normalizes a valid organization and preserves fixed Class 1 delivery", () => {
    const result = validateOrganizationImport(baseDocument());
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.normalized.school.code, "SCHOOL");
    assert.equal(result.normalized.school.teacherAuthMode, "LOCAL_PIN");

    const classOne = result.normalized.administrativeClasses.find((item) => item.code === "G2-C1");
    const physicsRule = classOne.subjectRules.find((rule) => rule.subjectCode === "PHY");
    assert.equal(physicsRule.deliveryMode, "ADMIN_CLASS");
    assert.equal(physicsRule.isCompulsory, true);
});

test("organization import accepts a school-wide password strategy without exposing a default secret", () => {
    const document = baseDocument();
    document.school.teacherAuth = {
        mode: "SHARED_PASSWORD",
        allowOAuthFallback: true,
        sharedPassword: "teachers-2026",
    };
    const result = validateOrganizationImport(document);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.equal(result.normalized.school.teacherAuthMode, "SHARED_PASSWORD");
    assert.equal(result.normalized.school.allowOAuthTeacherLogin, true);
    assert.equal(Object.hasOwn(result.normalized.school, "teacherSharedPassword"), false);
});

test("rejects linking a course group to a class whose subject follows the administrative class", () => {
    const document = baseDocument();
    document.courseGroups[0].sourceClasses.push("G2-C1");
    const result = validateOrganizationImport(document);

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === "DELIVERY_MODE_CONFLICT"));
});

test("warns when a streamed subject has no selectable course group", () => {
    const document = baseDocument();
    document.courseGroups = [];
    const result = validateOrganizationImport(document);

    assert.equal(result.valid, true);
    assert.ok(result.warnings.some((warning) => warning.code === "NO_COURSE_GROUP_OPTIONS"));
});

test("rejects unknown subjects and administrative classes", () => {
    const document = baseDocument();
    document.administrativeClasses[1].subjectRules.UNKNOWN = "COURSE_GROUP";
    document.courseGroups[0].sourceClasses.push("G2-C99");
    const result = validateOrganizationImport(document);

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === "UNKNOWN_SUBJECT"));
    assert.ok(result.errors.some((error) => error.code === "UNKNOWN_ADMIN_CLASS"));
});

test("rejects duplicate workspace codes across administrative classes and course groups", () => {
    const document = baseDocument();
    document.courseGroups[0].code = "G2-C5";
    const result = validateOrganizationImport(document);

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === "DUPLICATE_WORKSPACE_CODE"));
});

test("the eight-class rollout template preserves fixed and walking-class subjects", () => {
    const document = JSON.parse(readFileSync(
        new URL("../config/examples/newfires-high-school-organization.example.json", import.meta.url),
        "utf8",
    ));
    const result = validateOrganizationImport(document);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.equal(result.summary.administrativeClasses, 8);
    assert.equal(result.summary.courseGroups, 12);

    const classOne = result.normalized.administrativeClasses.find((item) => item.code === "G2-C1");
    const classTwo = result.normalized.administrativeClasses.find((item) => item.code === "G2-C2");
    for (const administrativeClass of [classOne, classTwo]) {
        for (const subjectCode of ["PHY", "CHE", "BIO"]) {
            assert.equal(
                administrativeClass.subjectRules.find((rule) => rule.subjectCode === subjectCode)?.deliveryMode,
                "ADMIN_CLASS",
            );
        }
    }
    const classThree = result.normalized.administrativeClasses.find((item) => item.code === "G2-C3");
    assert.equal(classThree.subjectRules.find((rule) => rule.subjectCode === "HIS")?.deliveryMode, "ADMIN_CLASS");
    assert.equal(classThree.subjectRules.find((rule) => rule.subjectCode === "PHY")?.deliveryMode, "COURSE_GROUP");
});
