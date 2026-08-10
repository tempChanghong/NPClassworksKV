import test from "node:test";
import assert from "node:assert/strict";
import {
    buildAdministrativeClassCourseOptions,
    SUBJECT_DELIVERY_MODES,
    WORKSPACE_TYPES,
} from "../domain/academicCatalog.js";

const subjects = {
    chinese: {id: "chinese", code: "CHN", name: "语文", category: "CORE", sortOrder: 10},
    physics: {id: "physics", code: "PHY", name: "物理", category: "ELECTIVE", sortOrder: 40},
};

function adminClass(id, name) {
    return {id, code: id, name, type: WORKSPACE_TYPES.ADMIN_CLASS, gradeId: "g2", termId: "term"};
}

test("Class 1 can explicitly keep minor subjects in the administrative class", () => {
    const result = buildAdministrativeClassCourseOptions({
        administrativeClass: adminClass("g2-c1", "高二1班"),
        subjectRules: [
            {
                subjectId: "physics",
                subject: subjects.physics,
                deliveryMode: SUBJECT_DELIVERY_MODES.ADMIN_CLASS,
                isCompulsory: true,
            },
        ],
        sourcedCourseGroups: [
            {
                workspace: {
                    id: "physics-a1",
                    code: "G2-PHY-A1",
                    name: "物理A1",
                    type: WORKSPACE_TYPES.COURSE_GROUP,
                    subjectId: "physics",
                },
            },
        ],
    });

    assert.equal(result.subjects[0].followsAdministrativeClass, true);
    assert.equal(result.subjects[0].requiresCourseGroupSelection, false);
    assert.deepEqual(result.subjects[0].courseGroups, []);
});

test("A streamed class receives selectable course groups for the same subject", () => {
    const result = buildAdministrativeClassCourseOptions({
        administrativeClass: adminClass("g2-c5", "高二5班"),
        subjectRules: [
            {
                subjectId: "chinese",
                subject: subjects.chinese,
                deliveryMode: SUBJECT_DELIVERY_MODES.ADMIN_CLASS,
                isCompulsory: true,
            },
            {
                subjectId: "physics",
                subject: subjects.physics,
                deliveryMode: SUBJECT_DELIVERY_MODES.COURSE_GROUP,
                isCompulsory: false,
            },
        ],
        sourcedCourseGroups: [
            {
                workspace: {
                    id: "physics-a2",
                    code: "G2-PHY-A2",
                    name: "物理A2",
                    type: WORKSPACE_TYPES.COURSE_GROUP,
                    subjectId: "physics",
                    isStudentSelectable: true,
                },
            },
            {
                workspace: {
                    id: "physics-a1",
                    code: "G2-PHY-A1",
                    name: "物理A1",
                    type: WORKSPACE_TYPES.COURSE_GROUP,
                    subjectId: "physics",
                    isStudentSelectable: true,
                },
            },
        ],
    });

    const [chinese, physics] = result.subjects;
    assert.equal(chinese.followsAdministrativeClass, true);
    assert.equal(physics.requiresCourseGroupSelection, true);
    assert.deepEqual(physics.courseGroups.map((group) => group.name), ["物理A1", "物理A2"]);
});

test("Non-administrative workspaces are rejected", () => {
    assert.throws(
        () => buildAdministrativeClassCourseOptions({
            administrativeClass: {id: "physics-a1", type: WORKSPACE_TYPES.COURSE_GROUP},
        }),
        /ADMIN_CLASS/,
    );
});
