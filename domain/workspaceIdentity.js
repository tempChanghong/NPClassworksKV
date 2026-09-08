// Stable workspace codes identify the same teaching space across imports.
export function workspaceIdentityConflict(existing, next) {
    if (existing.type !== next.type) {
        return {code: "WORKSPACE_TYPE_LOCKED", message: "已有教学空间不能更换类型，请使用新代码创建"};
    }
    if (existing.gradeId !== next.gradeId) {
        return {code: "WORKSPACE_GRADE_LOCKED", message: "已有教学空间不能通过导入转移年级，请使用新代码创建"};
    }
    if (existing.subjectId !== next.subjectId &&
        (existing._count.publicationTargets > 0 || existing._count.teachingAssignments > 0)) {
        return {code: "COURSE_GROUP_SUBJECT_LOCKED", message: "已有作业历史或任课关系的教学班不能更换科目，请新建教学班并停用旧教学班"};
    }
    return null;
}
