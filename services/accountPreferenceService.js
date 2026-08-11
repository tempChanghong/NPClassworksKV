import {prisma} from "../utils/prisma.js";
import {sanitizeTeacherTargetPreferences} from "../domain/teacherTargetPreferences.js";

const TEACHER_TARGETS_KEY = "teacher-targets";

export async function getTeacherTargetPreferences(accountId) {
    const record = await prisma.accountPreference.findUnique({
        where: {accountId_key: {accountId, key: TEACHER_TARGETS_KEY}},
    });
    return {
        preferences: sanitizeTeacherTargetPreferences(record?.value || {}),
        updatedAt: record?.updatedAt || null,
    };
}

export async function saveTeacherTargetPreferences(accountId, value) {
    const preferences = sanitizeTeacherTargetPreferences(value);
    const record = await prisma.accountPreference.upsert({
        where: {accountId_key: {accountId, key: TEACHER_TARGETS_KEY}},
        create: {accountId, key: TEACHER_TARGETS_KEY, value: preferences},
        update: {value: preferences},
    });
    return {preferences, updatedAt: record.updatedAt};
}
