import assert from "node:assert/strict";
import test from "node:test";
import {
    decryptMigrationPackage,
    encryptMigrationPayload,
    FORMAT,
    FORMAT_VERSION,
} from "../services/schoolMigrationService.js";

const passphrase = "correct-horse-battery-staple";
const payload = {
    manifest: {
        format: FORMAT,
        formatVersion: FORMAT_VERSION,
        migrationId: "migration-test",
    },
    data: {school: {id: "school-1", code: "TEST", name: "测试学校"}},
};

test("school migration package encrypts and decrypts authenticated payload", async () => {
    const encrypted = await encryptMigrationPayload(payload, passphrase);
    assert.equal(encrypted.includes(Buffer.from("测试学校")), false);
    assert.deepEqual(await decryptMigrationPackage(encrypted, passphrase), payload);
});

test("school migration package rejects a wrong passphrase", async () => {
    const encrypted = await encryptMigrationPayload(payload, passphrase);
    await assert.rejects(
        () => decryptMigrationPackage(encrypted, "this-is-the-wrong-password"),
        (error) => error.code === "MIGRATION_PACKAGE_DECRYPT_FAILED" && error.statusCode === 422,
    );
});

test("school migration package rejects tampering", async () => {
    const encrypted = await encryptMigrationPayload(payload, passphrase);
    const envelope = JSON.parse(encrypted.toString("utf8"));
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}aa`;
    await assert.rejects(
        () => decryptMigrationPackage(Buffer.from(JSON.stringify(envelope)), passphrase),
        (error) => error.code === "MIGRATION_PACKAGE_DECRYPT_FAILED",
    );
});

test("school migration package enforces a meaningful passphrase", async () => {
    await assert.rejects(
        () => encryptMigrationPayload(payload, "short"),
        (error) => error.code === "MIGRATION_PASSPHRASE_INVALID" && error.statusCode === 422,
    );
});
