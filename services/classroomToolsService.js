import {lockClassroomScreenWrite} from "./screenWriteAuthorization.js";
import {prisma} from "../utils/prisma.js";
import {authorizationError} from "./academicAuthorizationService.js";

const EMPTY_ATTENDANCE = Object.freeze({absent: [], late: [], excluded: []});

function toolError(message, code, statusCode = 400, details = null) {
    return authorizationError(message, code, statusCode, details);
}

function cleanText(value, maxLength) {
    const text = typeof value === "string" ? value.trim() : "";
    return text.slice(0, maxLength);
}

function parseAttendanceDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw toolError("考勤日期格式必须为 YYYY-MM-DD", "ATTENDANCE_DATE_INVALID", 422);
    }
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        throw toolError("考勤日期无效", "ATTENDANCE_DATE_INVALID", 422);
    }
    return date;
}

function normalizeRoster(students) {
    if (!Array.isArray(students)) {
        throw toolError("学生名单必须为数组", "CLASS_ROSTER_INVALID", 422);
    }
    if (students.length > 120) {
        throw toolError("一个行政班最多保存120名学生", "CLASS_ROSTER_TOO_LARGE", 422);
    }
    const seenIds = new Set();
    const seenNumbers = new Set();
    return students.map((student, index) => {
        const id = cleanText(student?.id, 191) || null;
        const name = cleanText(student?.name, 64);
        const studentNumber = cleanText(student?.studentNumber, 64) || null;
        if (!name) throw toolError(`第${index + 1}名学生缺少姓名`, "CLASS_ROSTER_NAME_REQUIRED", 422);
        if (id && seenIds.has(id)) throw toolError("学生名单包含重复记录", "CLASS_ROSTER_DUPLICATE_ID", 422);
        if (studentNumber && seenNumbers.has(studentNumber)) {
            throw toolError(`学号 ${studentNumber} 重复`, "CLASS_ROSTER_DUPLICATE_NUMBER", 422);
        }
        if (id) seenIds.add(id);
        if (studentNumber) seenNumbers.add(studentNumber);
        return {id, name, studentNumber, sortOrder: index};
    });
}

function normalizeAttendance(input, activeStudentIds) {
    const used = new Set();
    const normalizeList = (key) => {
        const values = input?.[key] ?? [];
        if (!Array.isArray(values)) {
            throw toolError("考勤状态必须为学生 ID 数组", "ATTENDANCE_STATE_INVALID", 422);
        }
        return values.map((value) => cleanText(value, 191)).filter(Boolean).map((studentId) => {
            if (!activeStudentIds.has(studentId)) {
                throw toolError("考勤包含不属于当前行政班的学生", "ATTENDANCE_STUDENT_INVALID", 422);
            }
            if (used.has(studentId)) {
                throw toolError("同一学生不能同时处于多个考勤状态", "ATTENDANCE_STATE_CONFLICT", 422);
            }
            used.add(studentId);
            return studentId;
        });
    };
    return {
        absent: normalizeList("absent"),
        late: normalizeList("late"),
        excluded: normalizeList("excluded"),
    };
}

export async function listClassRoster({screenBinding}) {
    return prisma.administrativeClassStudent.findMany({
        where: {administrativeClassId: screenBinding.administrativeClassId, isActive: true},
        orderBy: [{sortOrder: "asc"}, {name: "asc"}],
    });
}

export async function replaceClassRoster({screenBinding, students}) {
    const normalized = normalizeRoster(students);
    return prisma.$transaction(async (tx) => {
        const existing = await tx.administrativeClassStudent.findMany({
            where: {administrativeClassId: screenBinding.administrativeClassId},
            select: {id: true},
        });
        const existingIds = new Set(existing.map((student) => student.id));
        for (const student of normalized) {
            if (student.id && !existingIds.has(student.id)) {
                throw toolError("学生记录不属于当前行政班", "CLASS_ROSTER_STUDENT_INVALID", 422);
            }
        }

        await tx.administrativeClassStudent.updateMany({
            where: {administrativeClassId: screenBinding.administrativeClassId, isActive: true},
            data: {isActive: false},
        });
        for (const student of normalized) {
            const data = {
                name: student.name,
                studentNumber: student.studentNumber,
                sortOrder: student.sortOrder,
                isActive: true,
            };
            if (student.id) {
                await tx.administrativeClassStudent.update({where: {id: student.id}, data});
            } else {
                await tx.administrativeClassStudent.create({
                    data: {...data, administrativeClassId: screenBinding.administrativeClassId},
                });
            }
        }
        return tx.administrativeClassStudent.findMany({
            where: {administrativeClassId: screenBinding.administrativeClassId, isActive: true},
            orderBy: [{sortOrder: "asc"}, {name: "asc"}],
        });
    });
}

export async function getClassAttendance({screenBinding, date}) {
    const attendanceDate = parseAttendanceDate(date);
    const result = await prisma.classAttendanceDay.findUnique({
        where: {
            administrativeClassId_attendanceDate: {
                administrativeClassId: screenBinding.administrativeClassId,
                attendanceDate,
            },
        },
    });
    return {
        date,
        ...(result?.attendance || EMPTY_ATTENDANCE),
        updatedAt: result?.updatedAt || null,
    };
}

export async function saveClassAttendance({screenBinding, date, attendance}) {
    const attendanceDate = parseAttendanceDate(date);
    const students = await prisma.administrativeClassStudent.findMany({
        where: {administrativeClassId: screenBinding.administrativeClassId, isActive: true},
        select: {id: true},
    });
    const normalized = normalizeAttendance(attendance, new Set(students.map((student) => student.id)));
    const result = await prisma.$transaction(async (tx) => {
        await lockClassroomScreenWrite(tx, screenBinding);
        return tx.classAttendanceDay.upsert({
            where: {
                administrativeClassId_attendanceDate: {
                    administrativeClassId: screenBinding.administrativeClassId,
                    attendanceDate,
                },
            },
            create: {
                administrativeClassId: screenBinding.administrativeClassId,
                attendanceDate,
                attendance: normalized,
                updatedByScreenBindingId: screenBinding.id,
            },
            update: {
                attendance: normalized,
                updatedByAccountId: null,
                updatedByScreenBindingId: screenBinding.id,
            },
        });
    });
    return {date, ...normalized, updatedAt: result.updatedAt};
}

export {parseAttendanceDate};
