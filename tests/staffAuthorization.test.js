import test from "node:test";
import assert from "node:assert/strict";
import {
    getResponsibilityAccessForWorkspaces,
    getResponsibilityWorkspaceIds,
} from "../services/staffAuthorizationService.js";

function fakeClient({gradeIds = [], classIds = []} = {}) {
    return {
        gradeLeadership: {
            findMany: async () => gradeIds.map((gradeId) => ({gradeId})),
        },
        administrativeClassLeadership: {
            findMany: async () => classIds.map((administrativeClassId) => ({administrativeClassId})),
        },
    };
}

const administrativeClass = {
    id: "class-3",
    gradeId: "grade-2",
    type: "ADMIN_CLASS",
    sourceClasses: [],
};
const courseGroup = {
    id: "physics-a1",
    gradeId: "grade-2",
    type: "COURSE_GROUP",
    sourceClasses: [{administrativeClassId: "class-3"}],
};

test("班主任可管理本行政班并只读关联走班教学班", async () => {
    const access = await getResponsibilityAccessForWorkspaces(
        "teacher",
        [administrativeClass, courseGroup],
        fakeClient({classIds: ["class-3"]}),
    );
    assert.deepEqual([...access.writableIds], ["class-3"]);
    assert.deepEqual([...access.readableIds], ["class-3", "physics-a1"]);
});

test("年级组长可管理本年级行政班和走班教学班", async () => {
    const access = await getResponsibilityAccessForWorkspaces(
        "leader",
        [administrativeClass, courseGroup],
        fakeClient({gradeIds: ["grade-2"]}),
    );
    assert.deepEqual([...access.writableIds], ["class-3", "physics-a1"]);
    assert.deepEqual([...access.readableIds], ["class-3", "physics-a1"]);
});

test("职责工作空间查询使用学期主键并保留学校范围", async () => {
    const queries = [];
    const client = {
        gradeLeadership: {
            findMany: async (query) => {
                queries.push(query);
                return [];
            },
        },
        administrativeClassLeadership: {
            findMany: async (query) => {
                queries.push(query);
                return [];
            },
        },
    };
    const result = await getResponsibilityWorkspaceIds(
        "teacher",
        {termId: "term-2026", schoolIds: ["school-2"]},
        client,
    );
    assert.deepEqual(result, {readableIds: [], writableIds: []});
    assert.deepEqual(queries[0].where.grade.term, {
        id: "term-2026",
        schoolId: {in: ["school-2"]},
    });
    assert.deepEqual(queries[1].where.administrativeClass.term, {
        id: "term-2026",
        schoolId: {in: ["school-2"]},
    });
});
