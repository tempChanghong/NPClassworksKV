import assert from "node:assert/strict";
import test from "node:test";
import {
    localProviderId,
    normalizeLocalUsername,
    validateLocalTeacherImport,
    validateSharedTeacherPassword,
    validateTeacherPin,
} from "../domain/localAccount.js";

test("school local account identity is stable and case insensitive", () => {
    assert.equal(normalizeLocalUsername(" WangLS "), "wangls");
    assert.equal(localProviderId(" newfires-school ", " WangLS "), "NEWFIRES-SCHOOL:wangls");
});

test("personal PIN teacher import creates normalized assignments", () => {
    const result = validateLocalTeacherImport({
        assignments: [{
            username: " WangLS ",
            name: " 王老师 ",
            pin: "260101",
            role: "teacher",
            workspaceCodes: ["g2-c1", "G2-C1", "g2-phy-a1"],
        }],
    }, "LOCAL_PIN");
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.deepEqual(result.normalized.assignments[0], {
        username: "wangls",
        name: "王老师",
        pin: "260101",
        role: "TEACHER",
        workspaceCodes: ["G2-C1", "G2-PHY-A1"],
    });
});

test("personal PIN mode rejects weak or malformed PINs", () => {
    for (const pin of ["123", "123456789", "12ab56"]) {
        assert.equal(validateTeacherPin(pin), false);
    }
    const result = validateLocalTeacherImport({
        assignments: [{username: "wangls", name: "王老师", pin: "123", workspaceCodes: ["G2-C1"]}],
    }, "LOCAL_PIN");
    assert.ok(result.errors.some((error) => error.code === "INVALID_TEACHER_PIN"));
});

test("shared password mode keeps individual teacher identity without requiring a PIN", () => {
    const result = validateLocalTeacherImport({
        assignments: [{username: "lils", name: "李老师", workspaceCodes: ["G2-C2"]}],
    }, "SHARED_PASSWORD");
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.equal(result.normalized.assignments[0].pin, "");
    assert.equal(validateSharedTeacherPassword("teachers-2026"), true);
    assert.equal(validateSharedTeacherPassword("short"), false);
});

test("OAuth schools reject local teacher provisioning", () => {
    const result = validateLocalTeacherImport({
        assignments: [{username: "lils", name: "李老师", workspaceCodes: ["G2-C2"]}],
    }, "OAUTH_EMAIL");
    assert.ok(result.errors.some((error) => error.code === "LOCAL_LOGIN_DISABLED"));
});
