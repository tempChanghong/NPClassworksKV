import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {mkdtemp, mkdir, readFile, writeFile, copyFile, readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import test from "node:test";

const enabled = process.env.RUN_DATABASE_TESTS === "true";
const root = fileURLToPath(new URL("../", import.meta.url));
const posix = path => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => "/" + drive.toLowerCase());
const native = path => process.platform === "win32" ? path.replace(/^\/([a-z])\//, (_, drive) => drive.toUpperCase() + ":/") : path;
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

test("real deployment scripts restore disposable data and history pages stay bounded", {skip: !enabled, timeout: 180000}, async t => {
    const url = new URL(process.env.DATABASE_URL);
    const project = process.env.INTEGRATION_COMPOSE_PROJECT;
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.match(url.pathname, /^\/npclassworks_test(?:_[a-z0-9_]+)?$/);
    assert.match(project || "", /^npclassworks-integration-\d+$/);
    const [{prisma}, service] = await Promise.all([import("../utils/prisma.js"), import("../services/publicationService.js")]);
    const directory = await mkdtemp(join(tmpdir(), "npclassworks-restore-test-"));
    await mkdir(join(directory, "deploy"));
    for (const file of ["lib.sh", "backup.sh", "restore.sh"]) {
        // Keep the actual production script logic; only its surrounding paths/config differ.
        await writeFile(join(directory, "deploy", file), (await readFile(join(root, "deploy", file), "utf8")).replaceAll("\r\n", "\n"));
    }
    for (const file of ["docker-compose.yml", "docker-compose.shared.yml"]) {
        await copyFile(join(root, "docker-compose.integration.yml"), join(directory, file));
    }
    async function config(mode) {
        const values = {DEPLOY_MODE: mode, COMPOSE_PROJECT_NAME: project,
            POSTGRES_USER: decodeURIComponent(url.username), POSTGRES_PASSWORD: decodeURIComponent(url.password), POSTGRES_DB: url.pathname.slice(1),
            INTEGRATION_POSTGRES_USER: decodeURIComponent(url.username), INTEGRATION_POSTGRES_PASSWORD: decodeURIComponent(url.password),
            INTEGRATION_POSTGRES_DB: url.pathname.slice(1), INTEGRATION_POSTGRES_PORT: url.port,
            BACKUP_RETENTION_DAYS: "0"};
        await writeFile(join(directory, "deploy/test.env"), Object.entries(values).map(([key,value]) => `${key}=${quote(value)}`).join("\n") + "\n");
    }
    const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
    function shell(script, args = [], success = true) {
        const result = spawnSync(bash, [script, ...args], {cwd: directory, encoding: "utf8", timeout: 60000,
            env: {...process.env, ENV_FILE: posix(join(directory, "deploy/test.env")), BACKUP_DIR: posix(join(directory, "backups")),
                RUNTIME_DIR: posix(join(directory, "runtime")), COMPOSE_PROJECT_NAME: project}});
        if (result.error) throw result.error;
        if (success) assert.equal(result.status, 0, result.stdout + result.stderr);
        else assert.notEqual(result.status, 0, "invalid restore must fail");
        return result;
    }
    const id = randomUUID();
    const school = await prisma.school.create({data: {code: `RESTORE-${id}`, name: "隔离恢复学校"}});
    const account = await prisma.account.create({data: {provider: "integration-test", providerId: id, name: "恢复教师"}});
    let publication, binding;
    try {
        await prisma.schoolMember.create({data: {schoolId: school.id, accountId: account.id, role: "OWNER"}});
        const term = await prisma.academicTerm.create({data: {schoolId: school.id, name: "测试学期", academicYear: 2099, semester: 1, status: "ACTIVE"}});
        const subject = await prisma.subject.create({data: {schoolId: school.id, code: "math", name: "数学"}});
        const workspace = await prisma.workspace.create({data: {termId: term.id, code: "C1", name: "恢复班级", type: "ADMIN_CLASS",
            subjectRules: {create: {subjectId: subject.id, deliveryMode: "ADMIN_CLASS"}}}});
        binding = await prisma.classroomScreenBinding.create({data: {schoolId: school.id, administrativeClassId: workspace.id,
            name: "恢复大屏", tokenHash: id.replaceAll("-", "").padEnd(64, "0"), createdByAccountId: account.id}});
        const screenBinding = {...binding, administrativeClass: workspace};
        publication = await service.createScreenPublication({screenBinding, input: {subjectId: subject.id, content: "版本1",
            targetWorkspaceIds: [workspace.id], boardDate: "2099-01-01", allowDuplicate: true, clientRequestId: randomUUID()}});
        const first = await prisma.publicationRevision.findFirst({where: {publicationId: publication.id}});
        await prisma.publicationRevision.createMany({data: Array.from({length: 44}, (_, index) => ({
            publicationId: publication.id, revision: index + 2, snapshot: {...first.snapshot, content: `版本${index + 2}`},
            action: "UPDATED", actorType: "ACCOUNT", editorAccountId: account.id, isCertified: index === 18,
        }))});
        await prisma.publication.update({where: {id: publication.id}, data: {revision: 45, content: "版本45", authorAccountId: account.id}});
        await t.test("teacher and screen cursor pages ignore newer inserts and keep legacy arrays compatible", async () => {
            for (const query of [options => service.listPublicationRevisions({accountId: account.id, publicationId: publication.id, ...options}),
                options => service.listScreenPublicationRevisions({screenBinding, publicationId: publication.id, ...options})]) {
                const page = await query({page: {limit: "20"}});
                assert.equal(page.items.length, 20); assert.equal(page.nextBeforeRevision, 26);
                assert.equal(page.items[0].revision, 45);
                const middle = await query({page: {limit: 20, beforeRevision: page.nextBeforeRevision}});
                assert.deepEqual(middle.items.map(row => row.revision), Array.from({length:20}, (_, i) => 25-i));
                assert.equal(middle.items.find(row => row.revision === 20).isCertified, true);
                const last = await query({page: {beforeRevision: middle.nextBeforeRevision}});
                assert.equal(last.items.length, 5); assert.equal(last.nextBeforeRevision, null);
                const legacy = await query({});
                assert.equal(legacy.length, 45);
                const pageBytes = Buffer.byteLength(JSON.stringify(page));
                const legacyBytes = Buffer.byteLength(JSON.stringify(legacy));
                assert.ok(pageBytes < legacyBytes * 0.6);
                console.log(`History payload fixture: first page ${pageBytes} bytes / legacy ${legacyBytes} bytes`);
                for (const page of [{limit: "0"}, {limit: "101"}, {beforeRevision: "-1"}, {beforeRevision: "abc"}, {limit: ["1","2"]}, {limit: ["1"]}]) {
                    await assert.rejects(query({page}), error => error.code === "PUBLICATION_HISTORY_PAGE_INVALID");
                }
            }
            const before = await service.listScreenPublicationRevisions({screenBinding, publicationId: publication.id, page: {limit: 20}});
            await service.updateScreenPublication({screenBinding, publicationId: publication.id, expectedRevision: 45, input: {content: "并发新增版本46"}});
            const after = await service.listScreenPublicationRevisions({screenBinding, publicationId: publication.id, page: {limit: 20, beforeRevision: before.nextBeforeRevision}});
            assert.equal(after.items[0].revision, 25);
            const restored = await service.restoreScreenPublicationRevision({screenBinding, publicationId: publication.id, expectedRevision: 46, sourceRevision: 1});
            assert.equal(restored.revision, 47); assert.equal(restored.content, "版本1");
        });
        async function snapshot() {
            return JSON.parse(JSON.stringify(await Promise.all([
                prisma.account.findUnique({where: {id: account.id}, include: {schoolMemberships: true}}),
                prisma.school.findUnique({where: {id: school.id}}),
                prisma.workspace.findUnique({where: {id: workspace.id}, include: {subjectRules: true}}),
                prisma.classroomScreenBinding.findUnique({where: {id: binding.id}}),
                prisma.publication.findUnique({where: {id: publication.id}, include: {targets: true, revisions: {orderBy: {revision: "asc"}}}}),
            ])));
        }
        for (const mode of ["standalone", "shared"]) await t.test(`${mode} backup/restore and rejection controls run actual shell scripts`, async () => {
            await config(mode);
            const expected = await snapshot();
            const backup = shell("deploy/backup.sh", ["--label", mode]).stdout.trim().split(/\r?\n/).at(-1);
            const backupFile = native(backup);
            assert.ok((await readFile(backupFile)).length > 100);
            assert.ok((await readFile(backupFile + ".sha256", "utf8")).length);
            await prisma.publication.update({where: {id: publication.id}, data: {content: "恢复前临时修改"}});
            await prisma.account.update({where: {id: account.id}, data: {name: "恢复前临时账号"}});
            await prisma.classroomScreenBinding.update({where: {id: binding.id}, data: {isActive: false}});
            const mutated = await snapshot();
            const noConfirmation = shell("deploy/restore.sh", [backup], false);
            assert.match(noConfirmation.stderr, /--yes/);
            const corrupt = join(directory, "backups", `corrupt-${mode}.dump`);
            await writeFile(corrupt, "invalid dump");
            await writeFile(corrupt + ".sha256", `${"0".repeat(64)}  corrupt-${mode}.dump\n`);
            assert.match(shell("deploy/restore.sh", [posix(corrupt), "--yes"], false).stderr, /校验和不匹配/);
            await writeFile(corrupt + ".sha256", `${createHash("sha256").update("invalid dump").digest("hex")}  corrupt-${mode}.dump\n`);
            shell("deploy/restore.sh", [posix(corrupt), "--yes"], false);
            assert.deepEqual(await snapshot(), mutated);
            await prisma.$disconnect();
            shell("deploy/restore.sh", [backup, "--yes"]);
            assert.deepEqual(await snapshot(), expected);
            assert.ok((await readdir(join(directory,"backups"))).some(name => name.includes("pre-restore") && name.endsWith(".dump")));
        });
        console.log(`Disposable restore evidence retained at ${directory}`);
    } finally {
        if (publication) await prisma.publication.delete({where: {id: publication.id}});
        if (binding) await prisma.classroomScreenBinding.delete({where: {id: binding.id}});
        const terms = await prisma.academicTerm.findMany({where: {schoolId: school.id}, select: {id:true}});
        await prisma.workspace.deleteMany({where: {termId: {in: terms.map(term => term.id)}}});
        await prisma.subject.deleteMany({where: {schoolId: school.id}});
        await prisma.academicTerm.deleteMany({where: {schoolId: school.id}});
        await prisma.schoolMember.deleteMany({where: {schoolId: school.id}});
        await prisma.school.delete({where: {id: school.id}});
        await prisma.account.delete({where: {id: account.id}});
        await prisma.$disconnect();
    }
});
