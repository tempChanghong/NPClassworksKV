import bcrypt from "bcrypt";
import crypto from "node:crypto";
import {promisify} from "node:util";
import packageJson from "../package.json" with {type: "json"};
import {prisma} from "../utils/prisma.js";
import {assertSchoolManager, authorizationError} from "./academicAuthorizationService.js";

const FORMAT = "npclassworks-school-transfer";
const FORMAT_VERSION = 1;
const DATABASE_SCHEMA = "20260822173000_default_notice_expiry";
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MIN_PASSPHRASE_LENGTH = 12;
const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEe.5l4KJg7jL7vY4PZwXH0mD7tZKX8zXn2";
const scrypt = promisify(crypto.scrypt);

const DATE_FIELDS = {
    accounts: ["createdAt", "updatedAt", "lastLoginAt"],
    school: ["createdAt", "updatedAt"],
    schoolMembers: ["createdAt", "updatedAt"],
    terms: ["startsAt", "endsAt", "createdAt", "updatedAt"],
    grades: ["createdAt", "updatedAt"],
    subjects: ["createdAt", "updatedAt"],
    workspaces: ["createdAt", "updatedAt"],
    workspaceSources: ["createdAt"],
    administrativeClassSubjects: ["createdAt", "updatedAt"],
    workspaceMembers: ["createdAt", "updatedAt"],
    teachingAssignments: ["createdAt", "updatedAt"],
    gradeLeaderships: ["createdAt", "updatedAt"],
    classLeaderships: ["createdAt", "updatedAt"],
    workspaceInvites: ["claimedAt", "createdAt", "updatedAt"],
    publications: ["boardDate", "publishAt", "dueAt", "expiresAt", "certifiedAt", "withdrawnAt", "createdAt", "updatedAt"],
    publicationTargets: ["createdAt"],
    screens: ["lockedUntil", "activatedAt", "lastUsedAt", "lastHeartbeatAt", "createdAt", "updatedAt"],
    auditLogs: ["createdAt"],
    notificationDeliveries: ["receivedAt", "displayedAt", "acknowledgedAt", "updatedAt"],
    students: ["createdAt", "updatedAt"],
    attendanceDays: ["attendanceDate", "createdAt", "updatedAt"],
    publicationRevisions: ["certifiedAt", "purgedAt", "createdAt"],
};

function migrationError(message, code, statusCode = 400, details = null) {
    return authorizationError(message, code, statusCode, details);
}

function validatePassphrase(passphrase) {
    if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH || passphrase.length > 256) {
        throw migrationError(
            `迁移密码需要 ${MIN_PASSPHRASE_LENGTH} 至 256 个字符`,
            "MIGRATION_PASSPHRASE_INVALID",
            422,
        );
    }
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

function sha256(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function safeFilename(value) {
    return String(value || "school").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64) || "school";
}

async function deriveKey(passphrase, salt) {
    return scrypt(passphrase, salt, 32, {N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024});
}

export async function encryptMigrationPayload(payload, passphrase) {
    validatePassphrase(passphrase);
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = await deriveKey(passphrase, salt);
    const aad = Buffer.from(`${FORMAT}:${FORMAT_VERSION}`, "utf8");
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = {
        format: FORMAT,
        version: FORMAT_VERSION,
        encryption: {
            algorithm: "aes-256-gcm",
            kdf: "scrypt",
            salt: salt.toString("base64url"),
            iv: iv.toString("base64url"),
            authTag: cipher.getAuthTag().toString("base64url"),
        },
        ciphertext: ciphertext.toString("base64url"),
    };
    return Buffer.from(JSON.stringify(envelope), "utf8");
}

export async function decryptMigrationPackage(packageBuffer, passphrase) {
    validatePassphrase(passphrase);
    if (!Buffer.isBuffer(packageBuffer) || packageBuffer.length === 0 || packageBuffer.length > MAX_PACKAGE_BYTES) {
        throw migrationError("迁移包为空或超过 64 MB 限制", "MIGRATION_PACKAGE_SIZE_INVALID", 413);
    }
    let envelope;
    try {
        envelope = JSON.parse(packageBuffer.toString("utf8"));
    } catch {
        throw migrationError("无法解析迁移包", "MIGRATION_PACKAGE_INVALID", 422);
    }
    if (envelope?.format !== FORMAT || envelope?.version !== FORMAT_VERSION ||
        envelope?.encryption?.algorithm !== "aes-256-gcm" || envelope?.encryption?.kdf !== "scrypt") {
        throw migrationError("迁移包格式或版本不受支持", "MIGRATION_PACKAGE_UNSUPPORTED", 422);
    }
    try {
        const salt = Buffer.from(envelope.encryption.salt, "base64url");
        const iv = Buffer.from(envelope.encryption.iv, "base64url");
        const authTag = Buffer.from(envelope.encryption.authTag, "base64url");
        const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
        const key = await deriveKey(passphrase, salt);
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(Buffer.from(`${FORMAT}:${FORMAT_VERSION}`, "utf8"));
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return JSON.parse(plaintext.toString("utf8"));
    } catch {
        throw migrationError("迁移密码错误，或迁移包已经损坏", "MIGRATION_PACKAGE_DECRYPT_FAILED", 422);
    }
}

async function verifyManagerConfirmation({managerAccountId, schoolId, currentPin, confirmationSchoolCode}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const [account, school] = await Promise.all([
        prisma.account.findUnique({where: {id: managerAccountId}}),
        prisma.school.findUnique({where: {id: schoolId}}),
    ]);
    if (!school) throw migrationError("学校不存在", "SCHOOL_NOT_FOUND", 404);
    if (account?.localPasswordHash) {
        const matches = await bcrypt.compare(String(currentPin || ""), account.localPasswordHash || DUMMY_HASH);
        if (!matches) throw migrationError("管理员 PIN 不正确", "MIGRATION_REAUTH_FAILED", 401);
        return {school, reauthMethod: "PIN"};
    }
    if (String(confirmationSchoolCode || "").trim().toUpperCase() !== school.code.toUpperCase()) {
        throw migrationError("请输入完整学校代码确认迁出", "MIGRATION_REAUTH_FAILED", 401);
    }
    return {school, reauthMethod: "SCHOOL_CODE"};
}

async function collectSchoolData(client, schoolId) {
    const school = await client.school.findUnique({where: {id: schoolId}});
    if (!school) throw migrationError("学校不存在", "SCHOOL_NOT_FOUND", 404);
    const terms = await client.academicTerm.findMany({where: {schoolId}, orderBy: {id: "asc"}});
    const termIds = terms.map((item) => item.id);
    const [grades, subjects, workspaces, schoolMembers, screens, auditLogs] = await Promise.all([
        client.grade.findMany({where: {termId: {in: termIds}}, orderBy: {id: "asc"}}),
        client.subject.findMany({where: {schoolId}, orderBy: {id: "asc"}}),
        client.workspace.findMany({where: {termId: {in: termIds}}, orderBy: {id: "asc"}}),
        client.schoolMember.findMany({where: {schoolId}, orderBy: {accountId: "asc"}}),
        client.classroomScreenBinding.findMany({where: {schoolId}, orderBy: {id: "asc"}}),
        client.auditLog.findMany({where: {schoolId}, orderBy: [{createdAt: "asc"}, {id: "asc"}]}),
    ]);
    const gradeIds = grades.map((item) => item.id);
    const workspaceIds = workspaces.map((item) => item.id);
    const screenIds = screens.map((item) => item.id);
    const [workspaceSources, administrativeClassSubjects, workspaceMembers, teachingAssignments,
        gradeLeaderships, classLeaderships, workspaceInvites, publicationTargets, students, attendanceDays] =
        await Promise.all([
            client.workspaceSourceClass.findMany({where: {workspaceId: {in: workspaceIds}}, orderBy: {workspaceId: "asc"}}),
            client.administrativeClassSubject.findMany({where: {administrativeClassId: {in: workspaceIds}}, orderBy: {administrativeClassId: "asc"}}),
            client.workspaceMember.findMany({where: {workspaceId: {in: workspaceIds}}, orderBy: {workspaceId: "asc"}}),
            client.teachingAssignment.findMany({where: {workspaceId: {in: workspaceIds}}, orderBy: {id: "asc"}}),
            client.gradeLeadership.findMany({where: {gradeId: {in: gradeIds}}, orderBy: {id: "asc"}}),
            client.administrativeClassLeadership.findMany({where: {administrativeClassId: {in: workspaceIds}}, orderBy: {id: "asc"}}),
            client.workspaceMemberInvite.findMany({where: {workspaceId: {in: workspaceIds}}, orderBy: {id: "asc"}}),
            client.publicationTarget.findMany({where: {workspaceId: {in: workspaceIds}}, orderBy: {publicationId: "asc"}}),
            client.administrativeClassStudent.findMany({where: {administrativeClassId: {in: workspaceIds}}, orderBy: {id: "asc"}}),
            client.classAttendanceDay.findMany({where: {administrativeClassId: {in: workspaceIds}}, orderBy: {attendanceDate: "asc"}}),
        ]);
    const publicationIds = unique(publicationTargets.map((item) => item.publicationId));
    const [publications, publicationRevisions, notificationDeliveries] = await Promise.all([
        client.publication.findMany({where: {id: {in: publicationIds}}, orderBy: {id: "asc"}}),
        client.publicationRevision.findMany({where: {publicationId: {in: publicationIds}}, orderBy: [{publicationId: "asc"}, {revision: "asc"}]}),
        client.notificationScreenDelivery.findMany({
            where: {publicationId: {in: publicationIds}, screenBindingId: {in: screenIds}},
            orderBy: {publicationId: "asc"},
        }),
    ]);
    const accountIds = unique([
        ...schoolMembers.map((item) => item.accountId),
        ...workspaceMembers.map((item) => item.accountId),
        ...teachingAssignments.map((item) => item.accountId),
        ...gradeLeaderships.map((item) => item.accountId),
        ...classLeaderships.map((item) => item.accountId),
        ...workspaceInvites.flatMap((item) => [item.invitedByAccountId, item.claimedByAccountId]),
        ...publications.flatMap((item) => [item.authorAccountId, item.certifiedByAccountId]),
        ...publicationRevisions.flatMap((item) => [item.editorAccountId, item.certifiedByAccountId]),
        ...screens.map((item) => item.createdByAccountId),
        ...attendanceDays.map((item) => item.updatedByAccountId),
        ...auditLogs.map((item) => item.actorAccountId),
    ]);
    const accounts = await client.account.findMany({
        where: {id: {in: accountIds}},
        orderBy: {id: "asc"},
        select: {
            id: true, provider: true, providerId: true, email: true, name: true, avatarUrl: true,
            createdAt: true, updatedAt: true, tokenVersion: true, localUsername: true,
            localPasswordHash: true, localDisabled: true, lastLoginAt: true,
        },
    });
    return {
        accounts: accounts.map((account) => ({
            ...account,
            providerData: account.provider === "school-local"
                ? {schoolCode: school.code, migrated: true}
                : null,
            accessToken: null,
            refreshToken: null,
            refreshTokenExpiry: null,
            tokenVersion: account.tokenVersion + 1,
            localLoginFailures: 0,
            localLockedUntil: null,
        })),
        school,
        schoolMembers,
        terms,
        grades,
        subjects,
        workspaces: workspaces.map((workspace) => ({...workspace, legacyDeviceId: null})),
        workspaceSources,
        administrativeClassSubjects,
        workspaceMembers,
        teachingAssignments,
        gradeLeaderships,
        classLeaderships,
        workspaceInvites,
        publications,
        publicationTargets,
        screens: screens.map((screen) => ({
            ...screen,
            deviceFingerprint: null,
            tokenHash: sha256(crypto.randomBytes(32)),
            loginFailures: 0,
            lockedUntil: null,
            credentialVersion: screen.credentialVersion + 1,
            activatedAt: null,
            lastUsedAt: null,
            lastHeartbeatAt: null,
            runtimeStatus: null,
        })),
        auditLogs,
        notificationDeliveries,
        students,
        attendanceDays,
        publicationRevisions,
    };
}

function summarize(data) {
    return {
        accounts: data.accounts.length,
        administrators: data.schoolMembers.filter((item) => ["OWNER", "ADMIN"].includes(item.role)).length,
        terms: data.terms.length,
        grades: data.grades.length,
        subjects: data.subjects.length,
        workspaces: data.workspaces.length,
        teachers: data.teachingAssignments.length,
        screens: data.screens.length,
        students: data.students.length,
        attendanceDays: data.attendanceDays.length,
        publications: data.publications.length,
        revisions: data.publicationRevisions.length,
        auditLogs: data.auditLogs.length,
    };
}

export async function getSchoolMigrationReadiness({managerAccountId, schoolId}) {
    const membership = await assertSchoolManager(managerAccountId, schoolId);
    const [school, account, accounts, terms, grades, subjects, workspaces, teachingAssignments,
        screens, students, attendanceDays, publications, revisions, auditLogs] = await Promise.all([
        prisma.school.findUnique({where: {id: schoolId}, select: {id: true, code: true, name: true, updatedAt: true}}),
        prisma.account.findUnique({where: {id: managerAccountId}, select: {localPasswordHash: true}}),
        prisma.schoolMember.count({where: {schoolId}}),
        prisma.academicTerm.count({where: {schoolId}}),
        prisma.grade.count({where: {term: {schoolId}}}),
        prisma.subject.count({where: {schoolId}}),
        prisma.workspace.count({where: {term: {schoolId}}}),
        prisma.teachingAssignment.count({where: {workspace: {term: {schoolId}}}}),
        prisma.classroomScreenBinding.count({where: {schoolId}}),
        prisma.administrativeClassStudent.count({where: {administrativeClass: {term: {schoolId}}}}),
        prisma.classAttendanceDay.count({where: {administrativeClass: {term: {schoolId}}}}),
        prisma.publication.count({where: {targets: {some: {workspace: {term: {schoolId}}}}}}),
        prisma.publicationRevision.count({where: {publication: {targets: {some: {workspace: {term: {schoolId}}}}}}}),
        prisma.auditLog.count({where: {schoolId}}),
    ]);
    const counts = {
        accounts,
        administrators: await prisma.schoolMember.count({where: {schoolId, role: {in: ["OWNER", "ADMIN"]}}}),
        terms,
        grades,
        subjects,
        workspaces,
        teachers: teachingAssignments,
        screens,
        students,
        attendanceDays,
        publications,
        revisions,
        auditLogs,
    };
    return {
        format: FORMAT,
        formatVersion: FORMAT_VERSION,
        school,
        role: membership.role,
        reauthMethod: account?.localPasswordHash ? "PIN" : "SCHOOL_CODE",
        counts,
        exclusions: ["ACCOUNT_SESSIONS", "OAUTH_TOKENS", "SCREEN_DEVICE_TOKENS", "PENDING_SCREEN_COMMANDS", "LEGACY_CLASSWORKS_1"],
        requiresEmptyTarget: true,
    };
}

export async function createSchoolMigrationPackage({
    managerAccountId,
    schoolId,
    currentPin,
    confirmationSchoolCode,
    passphrase,
}) {
    const {school} = await verifyManagerConfirmation({managerAccountId, schoolId, currentPin, confirmationSchoolCode});
    const data = await prisma.$transaction(async (tx) => collectSchoolData(tx, schoolId), {
        isolationLevel: "RepeatableRead",
        timeout: 120000,
    });
    const dataJson = JSON.stringify(data);
    const summary = summarize(data);
    const migrationId = crypto.randomUUID();
    const manifest = {
        format: FORMAT,
        formatVersion: FORMAT_VERSION,
        migrationId,
        exportedAt: new Date().toISOString(),
        applicationVersion: packageJson.version,
        databaseSchema: DATABASE_SCHEMA,
        school: {id: school.id, code: school.code, name: school.name},
        counts: summary,
        dataSha256: sha256(dataJson),
        security: {
            sessionsIncluded: false,
            oauthTokensIncluded: false,
            screenDevicesRequireRebind: true,
        },
    };
    const buffer = await encryptMigrationPayload({manifest, data}, passphrase);
    return {
        buffer,
        filename: `${safeFilename(school.code)}-${new Date().toISOString().slice(0, 10)}.npcw-transfer`,
        manifest,
    };
}

function reviveDates(data) {
    const revived = {...data};
    for (const [collection, fields] of Object.entries(DATE_FIELDS)) {
        if (collection === "school") {
            revived.school = {...revived.school};
            for (const field of fields) if (revived.school[field]) revived.school[field] = new Date(revived.school[field]);
            continue;
        }
        revived[collection] = (revived[collection] || []).map((record) => {
            const item = {...record};
            for (const field of fields) if (item[field]) item[field] = new Date(item[field]);
            return item;
        });
    }
    return revived;
}

function validatePayload(payload) {
    const manifest = payload?.manifest;
    const data = payload?.data;
    if (manifest?.format !== FORMAT || manifest?.formatVersion !== FORMAT_VERSION || !data?.school) {
        throw migrationError("迁移内容结构不受支持", "MIGRATION_PAYLOAD_UNSUPPORTED", 422);
    }
    const requiredCollections = Object.keys(DATE_FIELDS).filter((key) => key !== "school");
    if (!requiredCollections.every((key) => Array.isArray(data[key]))) {
        throw migrationError("迁移包缺少必要的数据集合", "MIGRATION_PAYLOAD_INCOMPLETE", 422);
    }
    if (manifest.databaseSchema !== DATABASE_SCHEMA) {
        throw migrationError(
            "迁移包与当前数据库结构版本不兼容；请先将两台服务器升级到相同版本",
            "MIGRATION_SCHEMA_INCOMPATIBLE",
            409,
            {source: manifest.databaseSchema, target: DATABASE_SCHEMA},
        );
    }
    const dataJson = JSON.stringify(data);
    if (sha256(dataJson) !== manifest.dataSha256) {
        throw migrationError("迁移内容完整性检查失败", "MIGRATION_CHECKSUM_MISMATCH", 422);
    }
    const actualCounts = summarize(data);
    if (JSON.stringify(actualCounts) !== JSON.stringify(manifest.counts)) {
        throw migrationError("迁移包数据计数与清单不一致", "MIGRATION_COUNT_MISMATCH", 422);
    }
    if (!data.schoolMembers.some((item) => item.schoolId === data.school.id && item.role === "OWNER")) {
        throw migrationError("迁移包没有学校所有者", "MIGRATION_OWNER_MISSING", 422);
    }
    if (!data.terms.some((item) => item.schoolId === data.school.id && item.status === "ACTIVE")) {
        throw migrationError("迁移包没有启用学期", "MIGRATION_ACTIVE_TERM_MISSING", 422);
    }
    return {manifest, data: reviveDates(data), counts: actualCounts};
}

async function assertEmptyTarget(client = prisma) {
    const [schools, accounts, terms, workspaces, publications] = await Promise.all([
        client.school.count(),
        client.account.count(),
        client.academicTerm.count(),
        client.workspace.count(),
        client.publication.count(),
    ]);
    if (schools || accounts || terms || workspaces || publications) {
        throw migrationError(
            "目标实例不是空白实例；第一版迁移不支持合并或覆盖现有数据",
            "MIGRATION_TARGET_NOT_EMPTY",
            409,
            {schools, accounts, terms, workspaces, publications},
        );
    }
}

export async function previewSchoolMigrationImport({packageBuffer, passphrase}) {
    await assertEmptyTarget();
    const payload = await decryptMigrationPackage(packageBuffer, passphrase);
    const {manifest, counts} = validatePayload(payload);
    return {
        valid: true,
        manifest,
        counts,
        warnings: [
            "所有网页登录会话都会失效，用户需要重新登录。",
            "大屏账号和 PIN 会保留，但每台大屏需要重新绑定设备。",
            "OAuth 用户需要在新服务器重新完成授权。",
        ],
    };
}

async function createMany(client, model, records) {
    if (!records?.length) return;
    await client[model].createMany({data: records});
}

export async function importSchoolMigrationPackage({packageBuffer, passphrase}) {
    await assertEmptyTarget();
    const payload = await decryptMigrationPackage(packageBuffer, passphrase);
    const {manifest, data, counts} = validatePayload(payload);
    await prisma.$transaction(async (tx) => {
        await assertEmptyTarget(tx);
        await createMany(tx, "account", data.accounts);
        await tx.school.create({data: data.school});
        await createMany(tx, "schoolMember", data.schoolMembers);
        await createMany(tx, "academicTerm", data.terms);
        await createMany(tx, "grade", data.grades);
        await createMany(tx, "subject", data.subjects);
        await createMany(tx, "workspace", data.workspaces);
        await createMany(tx, "workspaceSourceClass", data.workspaceSources);
        await createMany(tx, "administrativeClassSubject", data.administrativeClassSubjects);
        await createMany(tx, "workspaceMember", data.workspaceMembers);
        await createMany(tx, "teachingAssignment", data.teachingAssignments);
        await createMany(tx, "gradeLeadership", data.gradeLeaderships);
        await createMany(tx, "administrativeClassLeadership", data.classLeaderships);
        await createMany(tx, "workspaceMemberInvite", data.workspaceInvites);
        await createMany(tx, "classroomScreenBinding", data.screens);
        await createMany(tx, "publication", data.publications);
        await createMany(tx, "publicationTarget", data.publicationTargets);
        await createMany(tx, "publicationRevision", data.publicationRevisions);
        await createMany(tx, "notificationScreenDelivery", data.notificationDeliveries);
        await createMany(tx, "administrativeClassStudent", data.students);
        await createMany(tx, "classAttendanceDay", data.attendanceDays);
        await createMany(tx, "auditLog", data.auditLogs);
        await tx.auditLog.create({
            data: {
                schoolId: data.school.id,
                actorType: "SETUP",
                action: "SCHOOL_MIGRATION_IMPORT_COMPLETED",
                entityType: "SCHOOL",
                entityId: data.school.id,
                success: true,
                summary: "从加密迁移包导入学校",
                metadata: {migrationId: manifest.migrationId, sourceVersion: manifest.applicationVersion, counts},
            },
        });
        await tx.instanceSetup.create({data: {id: "default", setupVersion: 2}});
    }, {timeout: 180000});
    return {
        imported: true,
        school: {id: data.school.id, code: data.school.code, name: data.school.name},
        manifest,
        counts,
        requiresOwnerLoginTest: true,
        screensRequireRebind: data.screens.length,
    };
}

export {FORMAT, FORMAT_VERSION, MAX_PACKAGE_BYTES, MIN_PASSPHRASE_LENGTH};
