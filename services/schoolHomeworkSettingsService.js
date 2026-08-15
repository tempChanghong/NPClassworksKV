import {prisma} from "../utils/prisma.js";
import {assertSchoolManager, authorizationError} from "./academicAuthorizationService.js";
import {sanitizeHomeworkQuickDeadlines} from "../domain/schoolHomeworkSettings.js";

function settingsError(message) {
    return authorizationError(message, "HOMEWORK_SETTINGS_INVALID", 422);
}

export async function getSchoolHomeworkSettings({managerAccountId, schoolId}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const school = await prisma.school.findUnique({
        where: {id: schoolId},
        select: {homeworkQuickDeadlines: true},
    });
    return {quickDeadlines: sanitizeHomeworkQuickDeadlines(school?.homeworkQuickDeadlines)};
}

export async function updateSchoolHomeworkSettings({managerAccountId, schoolId, quickDeadlines}) {
    await assertSchoolManager(managerAccountId, schoolId);
    let normalized;
    try {
        normalized = sanitizeHomeworkQuickDeadlines(quickDeadlines, {strict: true});
    } catch (error) {
        throw settingsError(error.message);
    }
    await prisma.school.update({
        where: {id: schoolId},
        data: {homeworkQuickDeadlines: normalized},
    });
    return {quickDeadlines: normalized};
}
