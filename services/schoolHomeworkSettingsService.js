import {prisma} from "../utils/prisma.js";
import {assertSchoolManager, authorizationError} from "./academicAuthorizationService.js";
import {sanitizeHomeworkQuickDeadlines, sanitizeHomeworkQuickInputs} from "../domain/schoolHomeworkSettings.js";

function settingsError(message) {
    return authorizationError(message, "HOMEWORK_SETTINGS_INVALID", 422);
}

export async function getSchoolHomeworkSettings({managerAccountId, schoolId}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const school = await prisma.school.findUnique({
        where: {id: schoolId},
        select: {homeworkQuickDeadlines: true, homeworkQuickInputs: true},
    });
    return schoolSettings(school);
}

export async function getPublicSchoolHomeworkSettings(schoolId) {
    const school = await prisma.school.findUnique({
        where: {id: schoolId},
        select: {homeworkQuickDeadlines: true, homeworkQuickInputs: true},
    });
    if (!school) throw authorizationError("学校不存在", "SCHOOL_NOT_FOUND", 404);
    return schoolSettings(school);
}

function schoolSettings(school) {
    return {
        quickDeadlines: sanitizeHomeworkQuickDeadlines(school?.homeworkQuickDeadlines),
        quickInputs: sanitizeHomeworkQuickInputs(school?.homeworkQuickInputs),
    };
}

export async function updateSchoolHomeworkSettings({managerAccountId, schoolId, quickDeadlines, quickInputs}) {
    await assertSchoolManager(managerAccountId, schoolId);
    let normalizedDeadlines;
    let normalizedInputs;
    try {
        normalizedDeadlines = sanitizeHomeworkQuickDeadlines(quickDeadlines, {strict: true});
        normalizedInputs = sanitizeHomeworkQuickInputs(quickInputs, {strict: true});
    } catch (error) {
        throw settingsError(error.message);
    }
    await prisma.school.update({
        where: {id: schoolId},
        data: {homeworkQuickDeadlines: normalizedDeadlines, homeworkQuickInputs: normalizedInputs},
    });
    return {quickDeadlines: normalizedDeadlines, quickInputs: normalizedInputs};
}
