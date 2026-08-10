import {
    SUBJECT_DELIVERY_MODES,
    WORKSPACE_TYPES,
} from "./academicCatalog.js";
import {
    TEACHER_AUTH_MODES,
    validateSharedTeacherPassword,
} from "./localAccount.js";

const TERM_STATUSES = new Set(["DRAFT", "ACTIVE", "ARCHIVED"]);
const SUBJECT_CATEGORIES = new Set(["CORE", "ELECTIVE", "OTHER"]);

function cleanCode(value) {
    return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function cleanText(value) {
    return typeof value === "string" ? value.trim() : "";
}

function addRequiredTextError(errors, value, path, label) {
    if (!cleanText(value)) errors.push({path, code: "REQUIRED", message: `${label}不能为空`});
}

function findDuplicates(items, keySelector) {
    const seen = new Set();
    const duplicates = new Set();
    for (const item of items) {
        const key = keySelector(item);
        if (!key) continue;
        if (seen.has(key)) duplicates.add(key);
        seen.add(key);
    }
    return [...duplicates];
}

function normalizeSubjectRule(value) {
    if (typeof value === "string") {
        return {
            deliveryMode: value.trim().toUpperCase(),
            isCompulsory: value.trim().toUpperCase() === SUBJECT_DELIVERY_MODES.ADMIN_CLASS,
        };
    }
    return {
        deliveryMode: cleanCode(value?.deliveryMode),
        isCompulsory: value?.isCompulsory === true,
    };
}

/**
 * Validate and normalize a complete single-grade organization import.
 * No database access occurs here, so this function powers both dry-run and tests.
 */
export function validateOrganizationImport(input) {
    const errors = [];
    const warnings = [];

    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return {
            valid: false,
            errors: [{path: "$", code: "INVALID_DOCUMENT", message: "组织配置必须是JSON对象"}],
            warnings,
            normalized: null,
            summary: null,
        };
    }

    const teacherSharedPassword = typeof input.school?.teacherAuth?.sharedPassword === "string"
        ? input.school.teacherAuth.sharedPassword
        : "";
    const school = {
        code: cleanCode(input.school?.code),
        name: cleanText(input.school?.name),
        teacherAuthMode: cleanCode(input.school?.teacherAuth?.mode || input.school?.teacherAuthMode || "LOCAL_PIN"),
        allowOAuthTeacherLogin: input.school?.teacherAuth?.allowOAuthFallback === true ||
            input.school?.allowOAuthTeacherLogin === true,
    };
    addRequiredTextError(errors, school.code, "school.code", "学校代码");
    addRequiredTextError(errors, school.name, "school.name", "学校名称");
    if (!TEACHER_AUTH_MODES.has(school.teacherAuthMode)) {
        errors.push({path: "school.teacherAuth.mode", code: "INVALID_TEACHER_AUTH_MODE", message: "教师登录方式必须是 LOCAL_PIN、SHARED_PASSWORD 或 OAUTH_EMAIL"});
    }
    if (teacherSharedPassword && !validateSharedTeacherPassword(teacherSharedPassword)) {
        errors.push({path: "school.teacherAuth.sharedPassword", code: "INVALID_SHARED_TEACHER_PASSWORD", message: "学校通用教师口令需为8至64个字符"});
    }

    const academicYear = Number(input.term?.academicYear);
    const semester = Number(input.term?.semester);
    const term = {
        name: cleanText(input.term?.name),
        academicYear,
        semester,
        status: cleanCode(input.term?.status || "DRAFT"),
        startsAt: input.term?.startsAt || null,
        endsAt: input.term?.endsAt || null,
    };
    addRequiredTextError(errors, term.name, "term.name", "学期名称");
    if (!Number.isInteger(academicYear) || academicYear < 2000 || academicYear > 2200) {
        errors.push({path: "term.academicYear", code: "INVALID_YEAR", message: "学年必须是2000至2200之间的整数"});
    }
    if (!Number.isInteger(semester) || semester < 1 || semester > 3) {
        errors.push({path: "term.semester", code: "INVALID_SEMESTER", message: "学期序号必须是1至3之间的整数"});
    }
    if (!TERM_STATUSES.has(term.status)) {
        errors.push({path: "term.status", code: "INVALID_TERM_STATUS", message: "无效的学期状态"});
    }
    for (const dateField of ["startsAt", "endsAt"]) {
        if (term[dateField] && Number.isNaN(Date.parse(term[dateField]))) {
            errors.push({path: `term.${dateField}`, code: "INVALID_DATE", message: `${dateField}不是有效日期`});
        }
    }

    const grade = {
        code: cleanCode(input.grade?.code),
        name: cleanText(input.grade?.name),
        sortOrder: Number.isFinite(Number(input.grade?.sortOrder)) ? Number(input.grade.sortOrder) : 0,
    };
    addRequiredTextError(errors, grade.code, "grade.code", "年级代码");
    addRequiredTextError(errors, grade.name, "grade.name", "年级名称");

    const rawSubjects = Array.isArray(input.subjects) ? input.subjects : [];
    if (rawSubjects.length === 0) {
        errors.push({path: "subjects", code: "SUBJECTS_REQUIRED", message: "至少需要一个科目"});
    }
    const subjects = rawSubjects.map((subject, index) => {
        const normalized = {
            code: cleanCode(subject?.code),
            name: cleanText(subject?.name),
            category: cleanCode(subject?.category || "OTHER"),
            sortOrder: Number.isFinite(Number(subject?.sortOrder)) ? Number(subject.sortOrder) : index,
        };
        addRequiredTextError(errors, normalized.code, `subjects[${index}].code`, "科目代码");
        addRequiredTextError(errors, normalized.name, `subjects[${index}].name`, "科目名称");
        if (!SUBJECT_CATEGORIES.has(normalized.category)) {
            errors.push({path: `subjects[${index}].category`, code: "INVALID_SUBJECT_CATEGORY", message: "无效的科目类型"});
        }
        return normalized;
    });
    for (const code of findDuplicates(subjects, (item) => item.code)) {
        errors.push({path: "subjects", code: "DUPLICATE_SUBJECT", message: `科目代码重复：${code}`});
    }
    const subjectCodes = new Set(subjects.map((subject) => subject.code));

    const rawAdministrativeClasses = Array.isArray(input.administrativeClasses)
        ? input.administrativeClasses
        : [];
    if (rawAdministrativeClasses.length === 0) {
        errors.push({path: "administrativeClasses", code: "ADMIN_CLASSES_REQUIRED", message: "至少需要一个行政班"});
    }
    const administrativeClasses = rawAdministrativeClasses.map((item, index) => {
        const normalized = {
            code: cleanCode(item?.code),
            name: cleanText(item?.name),
            subjectRules: [],
        };
        addRequiredTextError(errors, normalized.code, `administrativeClasses[${index}].code`, "行政班代码");
        addRequiredTextError(errors, normalized.name, `administrativeClasses[${index}].name`, "行政班名称");

        if (!item?.subjectRules || typeof item.subjectRules !== "object" || Array.isArray(item.subjectRules)) {
            errors.push({path: `administrativeClasses[${index}].subjectRules`, code: "SUBJECT_RULES_REQUIRED", message: "行政班必须配置科目授课模式"});
            return normalized;
        }

        for (const [rawSubjectCode, rawRule] of Object.entries(item.subjectRules)) {
            const subjectCode = cleanCode(rawSubjectCode);
            const rule = normalizeSubjectRule(rawRule);
            if (!subjectCodes.has(subjectCode)) {
                errors.push({path: `administrativeClasses[${index}].subjectRules.${rawSubjectCode}`, code: "UNKNOWN_SUBJECT", message: `未知科目：${rawSubjectCode}`});
            }
            if (!Object.values(SUBJECT_DELIVERY_MODES).includes(rule.deliveryMode)) {
                errors.push({path: `administrativeClasses[${index}].subjectRules.${rawSubjectCode}`, code: "INVALID_DELIVERY_MODE", message: "授课模式必须是 ADMIN_CLASS 或 COURSE_GROUP"});
            }
            normalized.subjectRules.push({subjectCode, ...rule});
        }
        return normalized;
    });
    for (const code of findDuplicates(administrativeClasses, (item) => item.code)) {
        errors.push({path: "administrativeClasses", code: "DUPLICATE_ADMIN_CLASS", message: `行政班代码重复：${code}`});
    }
    const adminClassByCode = new Map(administrativeClasses.map((item) => [item.code, item]));

    const rawCourseGroups = Array.isArray(input.courseGroups) ? input.courseGroups : [];
    const courseGroups = rawCourseGroups.map((item, index) => {
        const normalized = {
            code: cleanCode(item?.code),
            name: cleanText(item?.name),
            subjectCode: cleanCode(item?.subject),
            sourceClasses: Array.isArray(item?.sourceClasses)
                ? [...new Set(item.sourceClasses.map(cleanCode).filter(Boolean))]
                : [],
            isStudentSelectable: item?.isStudentSelectable !== false,
        };
        addRequiredTextError(errors, normalized.code, `courseGroups[${index}].code`, "教学班代码");
        addRequiredTextError(errors, normalized.name, `courseGroups[${index}].name`, "教学班名称");
        if (!subjectCodes.has(normalized.subjectCode)) {
            errors.push({path: `courseGroups[${index}].subject`, code: "UNKNOWN_SUBJECT", message: `未知科目：${item?.subject || ""}`});
        }
        if (normalized.sourceClasses.length === 0) {
            errors.push({path: `courseGroups[${index}].sourceClasses`, code: "SOURCE_CLASS_REQUIRED", message: "走班教学班至少需要一个来源行政班"});
        }
        for (const classCode of normalized.sourceClasses) {
            const adminClass = adminClassByCode.get(classCode);
            if (!adminClass) {
                errors.push({path: `courseGroups[${index}].sourceClasses`, code: "UNKNOWN_ADMIN_CLASS", message: `未知行政班：${classCode}`});
                continue;
            }
            const rule = adminClass.subjectRules.find((candidate) => candidate.subjectCode === normalized.subjectCode);
            if (!rule) {
                errors.push({path: `courseGroups[${index}].sourceClasses`, code: "MISSING_SUBJECT_RULE", message: `${classCode}未配置${normalized.subjectCode}的授课模式`});
            } else if (rule.deliveryMode !== SUBJECT_DELIVERY_MODES.COURSE_GROUP) {
                errors.push({path: `courseGroups[${index}].sourceClasses`, code: "DELIVERY_MODE_CONFLICT", message: `${classCode}的${normalized.subjectCode}随行政班授课，不能关联走班教学班${normalized.code}`});
            }
        }
        return normalized;
    });
    for (const code of findDuplicates(courseGroups, (item) => item.code)) {
        errors.push({path: "courseGroups", code: "DUPLICATE_COURSE_GROUP", message: `教学班代码重复：${code}`});
    }
    const allWorkspaceCodes = [...administrativeClasses, ...courseGroups].map((item) => item.code);
    for (const code of findDuplicates(allWorkspaceCodes, (item) => item)) {
        errors.push({path: "workspaces", code: "DUPLICATE_WORKSPACE_CODE", message: `教学空间代码重复：${code}`});
    }

    for (const adminClass of administrativeClasses) {
        for (const rule of adminClass.subjectRules) {
            if (rule.deliveryMode !== SUBJECT_DELIVERY_MODES.COURSE_GROUP) continue;
            const optionCount = courseGroups.filter((group) =>
                group.subjectCode === rule.subjectCode && group.sourceClasses.includes(adminClass.code),
            ).length;
            if (optionCount === 0) {
                warnings.push({
                    path: `administrativeClasses.${adminClass.code}.subjectRules.${rule.subjectCode}`,
                    code: "NO_COURSE_GROUP_OPTIONS",
                    message: `${adminClass.code}的${rule.subjectCode}标记为走班，但当前没有可选教学班`,
                });
            }
        }
    }

    const normalized = {
        school,
        term,
        grade,
        subjects,
        administrativeClasses,
        courseGroups,
    };
    const summary = {
        subjects: subjects.length,
        administrativeClasses: administrativeClasses.length,
        courseGroups: courseGroups.length,
        subjectRules: administrativeClasses.reduce((total, item) => total + item.subjectRules.length, 0),
        sourceRelations: courseGroups.reduce((total, item) => total + item.sourceClasses.length, 0),
    };

    return {valid: errors.length === 0, errors, warnings, normalized, summary};
}

export {WORKSPACE_TYPES};
