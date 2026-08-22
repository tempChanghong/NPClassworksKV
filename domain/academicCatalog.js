export const WORKSPACE_TYPES = Object.freeze({
    ADMIN_CLASS: "ADMIN_CLASS",
    COURSE_GROUP: "COURSE_GROUP",
    GRADE_CHANNEL: "GRADE_CHANNEL",
    SCHOOL_CHANNEL: "SCHOOL_CHANNEL",
});

export const SUBJECT_DELIVERY_MODES = Object.freeze({
    ADMIN_CLASS: "ADMIN_CLASS",
    COURSE_GROUP: "COURSE_GROUP",
});

/**
 * Build the student/teacher catalog for one administrative class.
 *
 * The delivery mode is explicit. A subject with ADMIN_CLASS does not ask a
 * student to select a course group, even if similarly named groups exist.
 * This is how fixed classes such as Class 1 and Class 2 are represented.
 */
export function buildAdministrativeClassCourseOptions({
    administrativeClass,
    subjectRules = [],
    sourcedCourseGroups = [],
}) {
    if (!administrativeClass || administrativeClass.type !== WORKSPACE_TYPES.ADMIN_CLASS) {
        throw new TypeError("administrativeClass must be an ADMIN_CLASS workspace");
    }

    const groupsBySubject = new Map();
    for (const relation of sourcedCourseGroups) {
        const group = relation.workspace || relation;
        if (!group || group.type !== WORKSPACE_TYPES.COURSE_GROUP || !group.subjectId) continue;
        const groups = groupsBySubject.get(group.subjectId) || [];
        groups.push({
            id: group.id,
            code: group.code,
            name: group.name,
            subjectId: group.subjectId,
            isStudentSelectable: group.isStudentSelectable !== false,
        });
        groupsBySubject.set(group.subjectId, groups);
    }

    const subjects = subjectRules.map((rule) => {
        const subject = rule.subject || {};
        const followsAdministrativeClass =
            rule.deliveryMode === SUBJECT_DELIVERY_MODES.ADMIN_CLASS;
        const courseGroups = followsAdministrativeClass
            ? []
            : (groupsBySubject.get(rule.subjectId) || [])
                .filter((group) => group.isStudentSelectable)
                .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));

        return {
            subject: {
                id: rule.subjectId,
                code: subject.code,
                name: subject.name,
                category: subject.category,
                sortOrder: subject.sortOrder ?? 0,
            },
            deliveryMode: rule.deliveryMode,
            isCompulsory: rule.isCompulsory === true,
            followsAdministrativeClass,
            requiresCourseGroupSelection: !followsAdministrativeClass,
            courseGroups,
        };
    });

    subjects.sort((a, b) => {
        const orderDiff = a.subject.sortOrder - b.subject.sortOrder;
        return orderDiff || (a.subject.name || "").localeCompare(b.subject.name || "", "zh-CN");
    });

    return {
        administrativeClass: {
            id: administrativeClass.id,
            code: administrativeClass.code,
            name: administrativeClass.name,
            gradeId: administrativeClass.gradeId,
            termId: administrativeClass.termId,
        },
        subjects,
    };
}

export function validateStudentCourseSelection(courseOptions, input = {}) {
    const candidateGroups = input.courseGroupIds && typeof input.courseGroupIds === "object"
        ? input.courseGroupIds
        : {};
    const declined = new Set(Array.isArray(input.declinedSubjectIds)
        ? input.declinedSubjectIds.filter((item) => typeof item === "string")
        : []);
    const normalized = {courseGroupIds: {}, declinedSubjectIds: []};
    const issues = [];
    const streamed = (courseOptions?.subjects || []).filter((item) => item.requiresCourseGroupSelection);
    const streamedSubjectIds = new Set(streamed.map((item) => item.subject.id));

    for (const [subjectId, groupId] of Object.entries(candidateGroups)) {
        if (!streamedSubjectIds.has(subjectId) && groupId) {
            issues.push({severity: "WARNING", code: "SUBJECT_NO_LONGER_STREAMED", subjectId, message: "该科目已不再走班，旧选择已移除"});
        }
    }
    for (const subjectId of declined) {
        if (!streamedSubjectIds.has(subjectId)) {
            issues.push({severity: "WARNING", code: "DECLINED_SUBJECT_NO_LONGER_STREAMED", subjectId, message: "该科目的旧“不修读”标记已移除"});
        }
    }
    for (const item of streamed) {
        const subjectId = item.subject.id;
        const groupId = candidateGroups[subjectId];
        const group = (item.courseGroups || []).find((candidate) => candidate.id === groupId);
        if (group && declined.has(subjectId)) {
            issues.push({severity: "ERROR", code: "SELECTION_DECISION_CONFLICT", subjectId, message: `${item.subject.name}不能同时选择教学班和“不修读”`});
            continue;
        }
        if (group) {
            normalized.courseGroupIds[subjectId] = group.id;
            continue;
        }
        if (groupId) {
            issues.push({severity: "ERROR", code: "COURSE_GROUP_NOT_AVAILABLE", subjectId, message: `${item.subject.name}所选教学班不属于当前行政班`});
            continue;
        }
        if (declined.has(subjectId) && !item.isCompulsory) {
            normalized.declinedSubjectIds.push(subjectId);
            continue;
        }
        issues.push({
            severity: "ERROR",
            code: item.isCompulsory ? "COMPULSORY_COURSE_GROUP_REQUIRED" : "SELECTION_DECISION_REQUIRED",
            subjectId,
            message: item.isCompulsory
                ? `${item.subject.name}必须选择一个走班教学班`
                : `请为${item.subject.name}选择教学班，或明确选择“不修读该科”`,
        });
    }
    return {valid: !issues.some((item) => item.severity === "ERROR"), normalized, issues};
}
