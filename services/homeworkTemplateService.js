import {randomUUID} from "node:crypto";
import {prisma} from "../utils/prisma.js";
import {templateError, validateHomeworkTemplate} from "../domain/homeworkTemplates.js";

const prefix = "homework-template:";
const keyFor = id => {
    if (!/^[a-f0-9-]{36}$/.test(id || "")) throw templateError("模板不存在", 404);
    return prefix + id;
};
const view = row => ({id: row.key.slice(prefix.length), ...row.value});

export async function listHomeworkTemplates(accountId) {
    return (await prisma.accountPreference.findMany({where: {accountId, key: {startsWith: prefix}}, orderBy: {createdAt: "asc"}, take: 50})).map(view);
}

export async function createHomeworkTemplate(accountId, input) {
    const value = {...validateHomeworkTemplate(input), revision: 1};
    return prisma.$transaction(async tx => {
        // Serialize the per-account limit without a new table or migration.
        await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${accountId} FOR UPDATE`;
        if (await tx.accountPreference.count({where: {accountId, key: {startsWith: prefix}}}) >= 50) throw templateError("最多保存50个个人模板，请先整理已有模板", 409);
        return view(await tx.accountPreference.create({data: {accountId, key: prefix + randomUUID(), value}}));
    });
}

export async function changeHomeworkTemplate(accountId, id, input, remove = false) {
    const key = keyFor(id), revision = input?.expectedRevision;
    if (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER) throw templateError("请重新载入模板后操作", 428);
    const value = remove ? null : {...validateHomeworkTemplate(input), revision: revision + 1};
    return prisma.$transaction(async tx => {
        // Lock the existing row before reading its version. Keep validation,
        // optional-field preservation and the write in this one transaction.
        await tx.$queryRaw`SELECT "accountId" FROM "AccountPreference" WHERE "accountId" = ${accountId} AND "key" = ${key} FOR UPDATE`;
        const where = {accountId_key: {accountId, key}};
        const existing = await tx.accountPreference.findUnique({where, select: {value: true}});
        if (existing?.value?.revision !== revision) throw templateError("模板已被修改或删除，输入已保留，请重新载入后核对", 409);
        // Old clients omit optional fields; only explicit empty strings clear them.
        for (const field of ["materials", "submission"]) {
            if (!remove && !Object.hasOwn(input, field) && existing.value[field]) value[field] = existing.value[field];
        }
        if (remove) await tx.accountPreference.delete({where});
        else await tx.accountPreference.update({where, data: {value}});
        return remove ? {id} : {id, ...value};
    });
}
