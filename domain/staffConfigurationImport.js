import {
    normalizeLocalUsername,
    normalizeSchoolCode,
    validateLocalUsername,
    validateTeacherPin,
} from "./localAccount.js";

const CREDENTIAL_MODES = new Set(["GENERATE_PIN", "FIXED_PIN", "SHARED_PASSWORD"]);
const TEACHING_POSITIONS = new Set(["PRIMARY", "CO_TEACHER"]);
const GRADE_POSITIONS = new Set(["PRIMARY", "DEPUTY"]);
const CLASS_POSITIONS = new Set(["HEAD_TEACHER", "CO_HEAD_TEACHER"]);

function cleanCode(value) {
    return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function cleanText(value) {
    return typeof value === "string" ? value.trim() : "";
}

function duplicateKeys(items, keyOf) {
    const seen = new Set();
    const duplicates = new Set();
    for (const item of items) {
        const key = keyOf(item);
        if (!key) continue;
        if (seen.has(key)) duplicates.add(key);
        seen.add(key);
    }
    return [...duplicates];
}

export function validateStaffConfigurationImport(input, teacherAuthMode) {
    const errors = [];
    const warnings = [];
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return {
            valid: false,
            errors: [{path: "$", code: "INVALID_DOCUMENT", message: "教师配置必须是JSON对象"}],
            warnings,
            normalized: null,
            summary: null,
        };
    }

    const schemaVersion = Number(input.schemaVersion ?? 1);
    const schoolCode = normalizeSchoolCode(input.schoolCode);
    const academicYear = Number(input.term?.academicYear);
    const semester = Number(input.term?.semester);
    const authMode = cleanCode(teacherAuthMode);
    if (schemaVersion !== 1) errors.push({path: "schemaVersion", code: "UNSUPPORTED_SCHEMA_VERSION", message: "教师配置 schemaVersion 目前必须为1"});
    if (!schoolCode) errors.push({path: "schoolCode", code: "SCHOOL_CODE_REQUIRED", message: "必须填写学校代码"});
    if (!Number.isInteger(academicYear) || academicYear < 2000 || academicYear > 2200) {
        errors.push({path: "term.academicYear", code: "INVALID_YEAR", message: "学年必须是2000至2200之间的整数"});
    }
    if (!Number.isInteger(semester) || semester < 1 || semester > 3) {
        errors.push({path: "term.semester", code: "INVALID_SEMESTER", message: "学期序号必须是1至3之间的整数"});
    }
    if (authMode === "OAUTH_EMAIL") {
        errors.push({path: "teachers", code: "LOCAL_LOGIN_DISABLED", message: "当前学校使用 OAuth 邮箱登录，暂不支持通过教师配置创建短账号"});
    }

    const rawTeachers = Array.isArray(input.teachers) ? input.teachers : [];
    if (!rawTeachers.length) errors.push({path: "teachers", code: "TEACHERS_REQUIRED", message: "至少需要一名教师"});
    if (rawTeachers.length > 500) errors.push({path: "teachers", code: "TOO_MANY_TEACHERS", message: "一次最多导入500名教师"});

    const teachers = rawTeachers.map((item, teacherIndex) => {
        const path = `teachers[${teacherIndex}]`;
        const username = normalizeLocalUsername(item?.username);
        const name = cleanText(item?.name);
        const requestedCredentialMode = cleanCode(item?.credential?.mode);
        const credentialMode = requestedCredentialMode || (authMode === "SHARED_PASSWORD" ? "SHARED_PASSWORD" : "GENERATE_PIN");
        const pin = typeof item?.credential?.pin === "string" ? item.credential.pin : "";
        if (!validateLocalUsername(username)) errors.push({path: `${path}.username`, code: "INVALID_LOCAL_USERNAME", message: "教师短账号需为2至32位小写字母、数字、点、横线或下划线"});
        if (!name || name.length > 64) errors.push({path: `${path}.name`, code: "INVALID_TEACHER_NAME", message: "教师姓名需为1至64个字符"});
        if (!CREDENTIAL_MODES.has(credentialMode)) errors.push({path: `${path}.credential.mode`, code: "INVALID_CREDENTIAL_MODE", message: "凭据模式必须是 GENERATE_PIN、FIXED_PIN 或 SHARED_PASSWORD"});
        if (authMode === "LOCAL_PIN" && !new Set(["GENERATE_PIN", "FIXED_PIN"]).has(credentialMode)) {
            errors.push({path: `${path}.credential.mode`, code: "CREDENTIAL_MODE_MISMATCH", message: "个人 PIN 登录只能使用 GENERATE_PIN 或 FIXED_PIN"});
        }
        if (authMode === "SHARED_PASSWORD" && credentialMode !== "SHARED_PASSWORD") {
            errors.push({path: `${path}.credential.mode`, code: "CREDENTIAL_MODE_MISMATCH", message: "学校通用口令模式下应使用 SHARED_PASSWORD"});
        }
        if (credentialMode === "FIXED_PIN" && !validateTeacherPin(pin)) {
            errors.push({path: `${path}.credential.pin`, code: "INVALID_TEACHER_PIN", message: "固定 PIN 需为4至8位数字"});
        }

        const teachingAssignments = (Array.isArray(item?.teachingAssignments) ? item.teachingAssignments : []).map((assignment, index) => {
            const assignmentPath = `${path}.teachingAssignments[${index}]`;
            const normalized = {
                workspaceCode: cleanCode(assignment?.workspaceCode),
                subjectCode: cleanCode(assignment?.subjectCode),
                position: cleanCode(assignment?.position || "PRIMARY"),
            };
            if (!normalized.workspaceCode) errors.push({path: `${assignmentPath}.workspaceCode`, code: "WORKSPACE_CODE_REQUIRED", message: "必须填写任课教学空间代码"});
            if (!normalized.subjectCode) errors.push({path: `${assignmentPath}.subjectCode`, code: "SUBJECT_CODE_REQUIRED", message: "必须填写任课科目代码"});
            if (!TEACHING_POSITIONS.has(normalized.position)) errors.push({path: `${assignmentPath}.position`, code: "INVALID_TEACHING_POSITION", message: "任课身份必须是 PRIMARY 或 CO_TEACHER"});
            return normalized;
        });
        for (const key of duplicateKeys(teachingAssignments, (entry) => `${entry.workspaceCode}\0${entry.subjectCode}`)) {
            errors.push({path: `${path}.teachingAssignments`, code: "DUPLICATE_TEACHING_ASSIGNMENT", message: `重复的任课关系：${key.replace("\0", "/")}`});
        }

        const gradeLeaderships = (Array.isArray(item?.responsibilities?.gradeLeaderships) ? item.responsibilities.gradeLeaderships : []).map((leadership, index) => {
            const leadershipPath = `${path}.responsibilities.gradeLeaderships[${index}]`;
            const normalized = {gradeCode: cleanCode(leadership?.gradeCode), position: cleanCode(leadership?.position || "PRIMARY")};
            if (!normalized.gradeCode) errors.push({path: `${leadershipPath}.gradeCode`, code: "GRADE_CODE_REQUIRED", message: "必须填写年级代码"});
            if (!GRADE_POSITIONS.has(normalized.position)) errors.push({path: `${leadershipPath}.position`, code: "INVALID_GRADE_POSITION", message: "年级职责必须是 PRIMARY 或 DEPUTY"});
            return normalized;
        });
        for (const code of duplicateKeys(gradeLeaderships, (entry) => entry.gradeCode)) {
            errors.push({path: `${path}.responsibilities.gradeLeaderships`, code: "DUPLICATE_GRADE_LEADERSHIP", message: `${username || name}重复配置了年级职责：${code}`});
        }

        const classLeaderships = (Array.isArray(item?.responsibilities?.classLeaderships) ? item.responsibilities.classLeaderships : []).map((leadership, index) => {
            const leadershipPath = `${path}.responsibilities.classLeaderships[${index}]`;
            const normalized = {classCode: cleanCode(leadership?.classCode), position: cleanCode(leadership?.position || "HEAD_TEACHER")};
            if (!normalized.classCode) errors.push({path: `${leadershipPath}.classCode`, code: "CLASS_CODE_REQUIRED", message: "必须填写行政班代码"});
            if (!CLASS_POSITIONS.has(normalized.position)) errors.push({path: `${leadershipPath}.position`, code: "INVALID_CLASS_POSITION", message: "班级职责必须是 HEAD_TEACHER 或 CO_HEAD_TEACHER"});
            return normalized;
        });
        for (const code of duplicateKeys(classLeaderships, (entry) => entry.classCode)) {
            errors.push({path: `${path}.responsibilities.classLeaderships`, code: "DUPLICATE_CLASS_LEADERSHIP", message: `${username || name}重复配置了班主任职责：${code}`});
        }

        if (!teachingAssignments.length) {
            warnings.push({path: `${path}.teachingAssignments`, code: "TEACHER_WITHOUT_ASSIGNMENT", message: `${name || username || `第${teacherIndex + 1}名教师`}没有任课关系`});
        }
        if (gradeLeaderships.length && !classLeaderships.length) {
            warnings.push({path: `${path}.responsibilities`, code: "GRADE_LEADER_WITHOUT_HOMEROOM", message: `${name || username}是年级组长但没有班主任职责`});
        }
        return {username, name, credential: {mode: credentialMode, pin}, teachingAssignments, responsibilities: {gradeLeaderships, classLeaderships}};
    });

    for (const username of duplicateKeys(teachers, (teacher) => teacher.username)) {
        errors.push({path: "teachers", code: "DUPLICATE_TEACHER", message: `教师短账号重复：${username}`});
    }
    for (const pin of duplicateKeys(teachers.filter((teacher) => teacher.credential.mode === "FIXED_PIN"), (teacher) => teacher.credential.pin)) {
        errors.push({path: "teachers", code: "DUPLICATE_FIXED_PIN", message: `固定 PIN 重复：${pin}`});
    }

    const summary = {
        teachers: teachers.length,
        teachingAssignments: teachers.reduce((sum, teacher) => sum + teacher.teachingAssignments.length, 0),
        gradeLeaderships: teachers.reduce((sum, teacher) => sum + teacher.responsibilities.gradeLeaderships.length, 0),
        classLeaderships: teachers.reduce((sum, teacher) => sum + teacher.responsibilities.classLeaderships.length, 0),
    };
    return {
        valid: errors.length === 0,
        errors,
        warnings,
        normalized: {schemaVersion, schoolCode, term: {academicYear, semester}, teachers},
        summary,
    };
}

export {CREDENTIAL_MODES};
