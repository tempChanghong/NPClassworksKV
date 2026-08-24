import {authorizationError} from "./academicAuthorizationService.js";

function parseExpectedUpdatedAt(value) {
    if (value === undefined || value === null || value === "") return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw authorizationError("数据版本标识无效，请刷新页面后重试", "EXPECTED_UPDATED_AT_INVALID", 422);
    }
    return parsed;
}

function conflictError(current) {
    return authorizationError(
        "该数据已被其他管理员修改，请刷新后核对最新内容",
        "ORGANIZATION_VERSION_CONFLICT",
        409,
        {current: current ? {id: current.id, updatedAt: current.updatedAt} : null},
    );
}

/**
 * Uses updatedAt as an optimistic concurrency token. Missing tokens remain
 * compatible with clients deployed before concurrency protection was added.
 */
export async function updateVersionedRecord({client, model, id, expectedUpdatedAt, data}) {
    const expected = parseExpectedUpdatedAt(expectedUpdatedAt);
    if (!expected) return client[model].update({where: {id}, data});

    const result = await client[model].updateMany({
        where: {id, updatedAt: expected},
        data,
    });
    if (result.count === 0) {
        const current = await client[model].findUnique({
            where: {id},
            select: {id: true, updatedAt: true},
        });
        throw conflictError(current);
    }
    return client[model].findUnique({where: {id}});
}

export {parseExpectedUpdatedAt};
