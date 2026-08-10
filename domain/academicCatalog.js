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
