const GRADE_POSITIONS = new Set(["PRIMARY", "DEPUTY"]);
const CLASS_POSITIONS = new Set(["HEAD_TEACHER", "CO_HEAD_TEACHER"]);

function cleanId(value) {
    return typeof value === "string" ? value.trim() : "";
}

export function normalizeGradeLeadershipInput(input = {}) {
    const value = {
        gradeId: cleanId(input.gradeId),
        accountId: cleanId(input.accountId),
        position: typeof input.position === "string" ? input.position.trim().toUpperCase() : "PRIMARY",
    };
    const errors = [];
    if (!value.gradeId) errors.push({path: "gradeId", message: "必须选择年级"});
    if (!value.accountId) errors.push({path: "accountId", message: "必须选择教师"});
    if (!GRADE_POSITIONS.has(value.position)) errors.push({path: "position", message: "无效的年级职责"});
    return {valid: errors.length === 0, errors, value};
}

export function normalizeClassLeadershipInput(input = {}) {
    const value = {
        administrativeClassId: cleanId(input.administrativeClassId),
        accountId: cleanId(input.accountId),
        position: typeof input.position === "string" ? input.position.trim().toUpperCase() : "HEAD_TEACHER",
    };
    const errors = [];
    if (!value.administrativeClassId) errors.push({path: "administrativeClassId", message: "必须选择行政班"});
    if (!value.accountId) errors.push({path: "accountId", message: "必须选择教师"});
    if (!CLASS_POSITIONS.has(value.position)) errors.push({path: "position", message: "无效的班主任职责"});
    return {valid: errors.length === 0, errors, value};
}

function issue(code, severity, message, context = {}) {
    return {code, severity, message, ...context};
}

export function buildStaffResponsibilityDiagnostics({school, grades = [], administrativeClasses = []} = {}) {
    const diagnostics = [];
    const classesByGrade = new Map();
    for (const administrativeClass of administrativeClasses.filter((item) => item.isActive !== false)) {
        const list = classesByGrade.get(administrativeClass.gradeId) || [];
        list.push(administrativeClass);
        classesByGrade.set(administrativeClass.gradeId, list);
    }

    for (const grade of grades) {
        const gradeClasses = classesByGrade.get(grade.id) || [];
        const leaderships = (grade.leaderships || []).filter((item) => item.isActive !== false);
        const primaryLeaders = leaderships.filter((item) => item.position === "PRIMARY");
        if (!primaryLeaders.length) {
            diagnostics.push(issue("GRADE_WITHOUT_LEADER", "WARNING", `${grade.name}尚未设置年级组长`, {gradeId: grade.id}));
        }
        if (primaryLeaders.length > 1) {
            diagnostics.push(issue(
                "MULTIPLE_PRIMARY_GRADE_LEADERS",
                "WARNING",
                `${grade.name}有 ${primaryLeaders.length} 位主要年级组长`,
                {gradeId: grade.id},
            ));
        }
        for (const leadership of leaderships) {
            const accountName = leadership.account?.name || leadership.account?.localUsername || "教师";
            const classLeaderships = gradeClasses.flatMap((item) => item.leaderships || [])
                .filter((item) => item.accountId === leadership.accountId && item.isActive !== false);
            const teachingAssignments = grade.teachingAssignments?.filter(
                (item) => item.accountId === leadership.accountId && item.isActive !== false,
            ) || [];
            if (school?.gradeLeaderMustBeHomeroom && !classLeaderships.length) {
                diagnostics.push(issue(
                    "GRADE_LEADER_NOT_HOMEROOM",
                    "WARNING",
                    `${accountName}是${grade.name}年级组长，但尚未担任本年级班主任`,
                    {gradeId: grade.id, accountId: leadership.accountId},
                ));
            }
            if (school?.gradeLeaderMustTeach && !teachingAssignments.length) {
                diagnostics.push(issue(
                    "GRADE_LEADER_NOT_TEACHING",
                    "WARNING",
                    `${accountName}是${grade.name}年级组长，但尚无本年级任课关系`,
                    {gradeId: grade.id, accountId: leadership.accountId},
                ));
            }
            if (leadership.account?.localDisabled) {
                diagnostics.push(issue(
                    "DISABLED_GRADE_LEADER",
                    "ERROR",
                    `${accountName}的账号已停用，但仍担任${grade.name}年级组长`,
                    {gradeId: grade.id, accountId: leadership.accountId},
                ));
            }
        }
    }

    for (const administrativeClass of administrativeClasses.filter((item) => item.isActive !== false)) {
        const leaderships = (administrativeClass.leaderships || []).filter((item) => item.isActive !== false);
        const primary = leaderships.filter((item) => item.position === "HEAD_TEACHER");
        if (!primary.length) {
            diagnostics.push(issue(
                "CLASS_WITHOUT_HOMEROOM",
                "WARNING",
                `${administrativeClass.name}尚未设置班主任`,
                {gradeId: administrativeClass.gradeId, administrativeClassId: administrativeClass.id},
            ));
        }
        if (primary.length > 1) {
            diagnostics.push(issue(
                "MULTIPLE_HEAD_TEACHERS",
                "WARNING",
                `${administrativeClass.name}有 ${primary.length} 位主班主任`,
                {gradeId: administrativeClass.gradeId, administrativeClassId: administrativeClass.id},
            ));
        }
        for (const leadership of leaderships) {
            const accountName = leadership.account?.name || leadership.account?.localUsername || "教师";
            const grade = grades.find((item) => item.id === administrativeClass.gradeId);
            const teachingAssignments = grade?.teachingAssignments?.filter(
                (item) => item.accountId === leadership.accountId && item.isActive !== false,
            ) || [];
            if (school?.homeroomMustTeach && !teachingAssignments.length) {
                diagnostics.push(issue(
                    "HOMEROOM_NOT_TEACHING",
                    "WARNING",
                    `${accountName}是${administrativeClass.name}班主任，但尚无本年级任课关系`,
                    {
                        gradeId: administrativeClass.gradeId,
                        administrativeClassId: administrativeClass.id,
                        accountId: leadership.accountId,
                    },
                ));
            }
            if (leadership.account?.localDisabled) {
                diagnostics.push(issue(
                    "DISABLED_HOMEROOM",
                    "ERROR",
                    `${accountName}的账号已停用，但仍担任${administrativeClass.name}班主任`,
                    {
                        gradeId: administrativeClass.gradeId,
                        administrativeClassId: administrativeClass.id,
                        accountId: leadership.accountId,
                    },
                ));
            }
        }
    }
    return diagnostics;
}
