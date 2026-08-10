const TEACHER_AUTH_MODES = new Set(["LOCAL_PIN", "SHARED_PASSWORD", "OAUTH_EMAIL"]);
const WORKSPACE_ROLES = new Set(["OWNER", "TEACHER", "ASSISTANT", "VIEWER"]);

export function normalizeSchoolCode(value) {
    return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export function normalizeLocalUsername(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function validateLocalUsername(value) {
    const username = normalizeLocalUsername(value);
    return /^[a-z0-9][a-z0-9._-]{1,31}$/.test(username);
}

export function validateTeacherPin(value) {
    return typeof value === "string" && /^\d{4,8}$/.test(value);
}

export function validateSharedTeacherPassword(value) {
    return typeof value === "string" && value.length >= 8 && value.length <= 64;
}

export function localProviderId(schoolCode, username) {
    return `${normalizeSchoolCode(schoolCode)}:${normalizeLocalUsername(username)}`;
}

export function validateLocalTeacherImport(input, teacherAuthMode) {
    const errors = [];
    const warnings = [];
    const mode = String(teacherAuthMode || "").toUpperCase();
    const rawAssignments = Array.isArray(input?.assignments) ? input.assignments : [];

    if (!TEACHER_AUTH_MODES.has(mode)) {
        errors.push({path: "teacherAuthMode", code: "INVALID_TEACHER_AUTH_MODE", message: "无效的教师登录方式"});
    }
    if (mode === "OAUTH_EMAIL") {
        errors.push({path: "teacherAuthMode", code: "LOCAL_LOGIN_DISABLED", message: "当前学校使用 OAuth 邮箱，请使用邮箱分配"});
    }
    if (rawAssignments.length === 0) {
        errors.push({path: "assignments", code: "ASSIGNMENTS_REQUIRED", message: "至少需要一条教师分配"});
    }
    if (rawAssignments.length > 500) {
        errors.push({path: "assignments", code: "TOO_MANY_ASSIGNMENTS", message: "单次最多导入500名教师"});
    }

    const pairRoles = new Map();
    const normalized = [];
    rawAssignments.forEach((item, index) => {
        const username = normalizeLocalUsername(item?.username);
        const name = typeof item?.name === "string" ? item.name.trim() : "";
        const pin = typeof item?.pin === "string" ? item.pin : "";
        const role = String(item?.role || "TEACHER").trim().toUpperCase();
        const rawCodes = Array.isArray(item?.workspaceCodes)
            ? item.workspaceCodes
            : Array.isArray(item?.workspaces) ? item.workspaces : [];
        const workspaceCodes = [...new Set(rawCodes
            .map((code) => typeof code === "string" ? code.trim().toUpperCase() : "")
            .filter(Boolean))];

        if (!validateLocalUsername(username)) {
            errors.push({
                path: `assignments[${index}].username`,
                code: "INVALID_LOCAL_USERNAME",
                message: "教师短账号需为2至32位小写字母、数字、点、横线或下划线",
            });
        }
        if (!name || name.length > 64) {
            errors.push({path: `assignments[${index}].name`, code: "INVALID_TEACHER_NAME", message: "教师姓名需为1至64个字符"});
        }
        if (mode === "LOCAL_PIN" && !validateTeacherPin(pin)) {
            errors.push({path: `assignments[${index}].pin`, code: "INVALID_TEACHER_PIN", message: "教师 PIN 需为4至8位数字"});
        }
        if (!WORKSPACE_ROLES.has(role)) {
            errors.push({path: `assignments[${index}].role`, code: "INVALID_WORKSPACE_ROLE", message: "无效的教学空间角色"});
        }
        if (workspaceCodes.length === 0) {
            errors.push({path: `assignments[${index}].workspaceCodes`, code: "WORKSPACES_REQUIRED", message: "至少选择一个教学空间"});
        }

        for (const code of workspaceCodes) {
            const pairKey = `${username}\u0000${code}`;
            const previousRole = pairRoles.get(pairKey);
            if (previousRole && previousRole !== role) {
                errors.push({
                    path: `assignments[${index}].workspaceCodes`,
                    code: "CONFLICTING_ASSIGNMENT_ROLE",
                    message: `${username} 在 ${code} 上出现冲突角色`,
                });
            }
            pairRoles.set(pairKey, role);
        }
        normalized.push({username, name, pin: mode === "LOCAL_PIN" ? pin : "", role, workspaceCodes});
    });

    const deduplicated = new Map();
    for (const assignment of normalized) {
        const key = `${assignment.username}\u0000${assignment.role}`;
        if (!deduplicated.has(key)) deduplicated.set(key, {...assignment, workspaceCodes: []});
        const target = deduplicated.get(key);
        if (target.name !== assignment.name || target.pin !== assignment.pin) {
            errors.push({
                path: "assignments",
                code: "CONFLICTING_TEACHER_CREDENTIAL",
                message: `${assignment.username} 出现不同的姓名或 PIN`,
            });
        }
        target.workspaceCodes = [...new Set([...target.workspaceCodes, ...assignment.workspaceCodes])];
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        normalized: {assignments: [...deduplicated.values()]},
        summary: {teachers: deduplicated.size, memberships: pairRoles.size},
    };
}

export {TEACHER_AUTH_MODES};
