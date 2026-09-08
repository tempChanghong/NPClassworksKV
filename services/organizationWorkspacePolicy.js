import {workspaceIdentityConflict} from "../domain/workspaceIdentity.js";

// Read-only preflight, also repeated inside the import transaction before writes.
export async function organizationWorkspaceConflicts(client, schoolId, normalized) {
    if (!schoolId) return [];
    const term = await client.academicTerm.findUnique({where: {schoolId_academicYear_semester: {
        schoolId, academicYear: normalized.term.academicYear, semester: normalized.term.semester,
    }}});
    if (!term) return [];
    const entries = [
        ...normalized.administrativeClasses.map((row, index) => ({...row, type: "ADMIN_CLASS", path: "administrativeClasses[" + index + "]"})),
        ...normalized.courseGroups.map((row, index) => ({...row, type: "COURSE_GROUP", path: "courseGroups[" + index + "]"})),
    ];
    const [grade, subjects, workspaces] = await Promise.all([
        client.grade.findUnique({where: {termId_code: {termId: term.id, code: normalized.grade.code}}}),
        client.subject.findMany({where: {schoolId, code: {in: normalized.subjects.map(row => row.code)}}}),
        client.workspace.findMany({where: {termId: term.id, code: {in: entries.map(row => row.code)}},
            include: {_count: {select: {publicationTargets: true, teachingAssignments: true}}}}),
    ]);
    const byCode = new Map(workspaces.map(row => [row.code, row]));
    const subjectByCode = new Map(subjects.map(row => [row.code, row.id]));
    return entries.flatMap(row => {
        const existing = byCode.get(row.code);
        if (!existing) return [];
        const conflict = workspaceIdentityConflict(existing, {
            type: row.type, gradeId: grade?.id ?? null,
            subjectId: row.type === "COURSE_GROUP" ? subjectByCode.get(row.subjectCode) ?? null : null,
        });
        return conflict ? [{...conflict, path: row.path, workspaceId: existing.id,
            message: row.code + "：" + conflict.message}] : [];
    });
}
