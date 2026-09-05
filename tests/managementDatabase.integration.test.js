import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";

test("concurrent OWNER demotions keep at least one OWNER in PostgreSQL", {skip: process.env.RUN_DATABASE_TESTS !== "true"}, async () => {
    const [{prisma}, {upsertSchoolMember}] = await Promise.all([
        import("../utils/prisma.js"), import("../services/schoolMembershipService.js"),
    ]);
    const suffix = randomUUID();
    const accounts = [];
    let school;
    try {
        school = await prisma.school.create({data: {code: "OWN-" + suffix, name: "Owner authorization integration"}});
        for (let n = 0; n < 2; n++) {
            const account = await prisma.account.create({data: {provider: "integration-test", providerId: suffix + "-" + n, name: "Owner " + n}});
            accounts.push(account);
            await prisma.schoolMember.create({data: {schoolId: school.id, accountId: account.id, role: "OWNER"}});
        }
        const results = await Promise.allSettled(accounts.map((account) => upsertSchoolMember({
            managerAccountId: account.id, schoolId: school.id, accountId: account.id, role: "ADMIN",
        })));
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        const failure = results.find((r) => r.status === "rejected");
        assert.equal(failure.reason.code, "LAST_SCHOOL_OWNER");
        assert.equal(await prisma.schoolMember.count({where: {schoolId: school.id, role: "OWNER"}}), 1);
    } finally {
        if (school) {
            await prisma.schoolMember.deleteMany({where: {schoolId: school.id}});
            await prisma.school.delete({where: {id: school.id}});
        }
        await prisma.account.deleteMany({where: {id: {in: accounts.map((a) => a.id)}}});
        await prisma.$disconnect();
    }
});
