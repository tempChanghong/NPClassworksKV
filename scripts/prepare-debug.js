import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import path from "node:path";
import process from "node:process";

function assertSafeDebugDatabase() {
    if (process.env.NODE_ENV === "production") {
        throw new Error("拒绝在 NODE_ENV=production 下准备调试数据");
    }
    const databaseUrl = new URL(process.env.DATABASE_URL || "");
    if (!new Set(["127.0.0.1", "localhost"]).has(databaseUrl.hostname)) {
        throw new Error("调试数据库必须位于 localhost 或 127.0.0.1");
    }
    if (databaseUrl.port !== "55432" || databaseUrl.pathname !== "/classworks_debug") {
        throw new Error("调试数据库必须使用 127.0.0.1:55432/classworks_debug");
    }
    if (!process.env.BOOTSTRAP_SETUP_KEY) {
        throw new Error("BOOTSTRAP_SETUP_KEY 未设置，请先运行 pnpm run debug:init");
    }
}

function deployMigrations() {
    const prismaCli = path.resolve("node_modules/prisma/build/index.js");
    execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit",
    });
}

assertSafeDebugDatabase();
deployMigrations();

const [
    {prisma},
    {localProviderId},
    localAccountService,
    {importOrganization},
    classroomScreenService,
] = await Promise.all([
    import("../utils/prisma.js"),
    import("../domain/localAccount.js"),
    import("../services/localAccountService.js"),
    import("../services/organizationAdminService.js"),
    import("../services/classroomScreenService.js"),
]);

const schoolCode = "DEBUG-SCHOOL";
const ownerUsername = "admin";
const credentials = {
    owner: {username: ownerUsername, pin: "260100", name: "调试 OWNER"},
    backup: {username: "backup-admin", pin: "260102", name: "调试备用管理员"},
    classOne: {username: "class1-teacher", pin: "260101", name: "一班教师"},
    streamed: {username: "walk-teacher", pin: "260103", name: "走班教师"},
    screen: {loginCode: "G2-C1-SCREEN", pin: "260110", name: "高二1班一体机"},
};

try {
    let owner = await prisma.account.findUnique({
        where: {
            provider_providerId: {
                provider: "school-local",
                providerId: localProviderId(schoolCode, ownerUsername),
            },
        },
    });
    if (!owner) {
        const bootstrapped = await localAccountService.bootstrapLocalAdministrator({
            setupKey: process.env.BOOTSTRAP_SETUP_KEY,
            schoolCode,
            username: ownerUsername,
            name: credentials.owner.name,
            pin: credentials.owner.pin,
        });
        owner = bootstrapped.account;
    }

    const organization = JSON.parse(readFileSync(
        new URL("../config/examples/newfires-high-school-organization.example.json", import.meta.url),
        "utf8",
    ));
    organization.school.code = schoolCode;
    organization.school.name = "Classworks 本地调试学校";
    organization.term.name = "本地调试学期";

    const imported = await importOrganization({
        accountId: owner.id,
        document: organization,
        dryRun: false,
    });
    if (!imported.imported) {
        throw new Error(`组织导入失败：${JSON.stringify(imported.errors || imported)}`);
    }

    const {school, term} = imported.result;
    const teacherImport = await localAccountService.importLocalTeachers({
        managerAccountId: owner.id,
        schoolId: school.id,
        termId: term.id,
        document: {
            assignments: [
                {
                    ...credentials.classOne,
                    role: "TEACHER",
                    workspaceCodes: ["G2-C1"],
                },
                {
                    ...credentials.streamed,
                    role: "TEACHER",
                    workspaceCodes: ["G2-C3", "G2-PHY-A1"],
                },
            ],
        },
        dryRun: false,
    });
    if (!teacherImport.imported) {
        throw new Error(`教师导入失败：${JSON.stringify(teacherImport.errors || teacherImport)}`);
    }

    await localAccountService.createLocalAdministrator({
        managerAccountId: owner.id,
        schoolId: school.id,
        username: credentials.backup.username,
        name: credentials.backup.name,
        pin: credentials.backup.pin,
        role: "ADMIN",
    });

    const administrativeClass = await prisma.workspace.findFirst({
        where: {termId: term.id, type: "ADMIN_CLASS", code: "G2-C1"},
    });
    let existingScreen = await prisma.classroomScreenBinding.findUnique({
        where: {schoolId_loginCode: {schoolId: school.id, loginCode: credentials.screen.loginCode}},
    });
    const legacyScreen = await prisma.classroomScreenBinding.findFirst({
        where: {
            schoolId: school.id,
            administrativeClassId: administrativeClass.id,
            deviceFingerprint: {not: null},
            ...(existingScreen ? {NOT: {id: existingScreen.id}} : {}),
        },
        orderBy: {createdAt: "asc"},
    });
    if (legacyScreen) {
        if (existingScreen && !existingScreen.deviceFingerprint) {
            await prisma.classroomScreenBinding.delete({where: {id: existingScreen.id}});
        }
        existingScreen = await classroomScreenService.configureClassroomScreenAccount({
            managerAccountId: owner.id,
            schoolId: school.id,
            bindingId: legacyScreen.id,
            loginCode: credentials.screen.loginCode,
            pin: credentials.screen.pin,
        });
    } else if (!existingScreen) {
        await classroomScreenService.createClassroomScreenAccount({
            managerAccountId: owner.id,
            schoolId: school.id,
            administrativeClassId: administrativeClass.id,
            ...credentials.screen,
        });
    }

    console.log("\n本地调试数据准备完成：");
    console.log(`学校代码：${schoolCode}`);
    console.log(`OWNER：${credentials.owner.username} / ${credentials.owner.pin}`);
    console.log(`备用管理员：${credentials.backup.username} / ${credentials.backup.pin}`);
    console.log(`一班教师：${credentials.classOne.username} / ${credentials.classOne.pin}`);
    console.log(`走班教师：${credentials.streamed.username} / ${credentials.streamed.pin}`);
    console.log(`一班大屏：${credentials.screen.loginCode} / ${credentials.screen.pin}`);
    console.log("管理页：http://localhost:3031/classworks-admin");
    console.log("Classworks 作业板：http://localhost:3031/");
} finally {
    await prisma.$disconnect();
}
