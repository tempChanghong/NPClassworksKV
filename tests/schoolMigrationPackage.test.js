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

test("school migration package rejects tampering", async (t) => {
    const encrypted = await encryptMigrationPayload(payload, passphrase);
    for (const field of ["ciphertext", "authTag", "iv", "salt"]) {
        await t.test(`rejects a changed byte in ${field}`, async () => {
            const envelope = JSON.parse(encrypted.toString("utf8"));
            const container = field === "ciphertext" ? envelope : envelope.encryption;
            const original = Buffer.from(container[field], "base64url");
            const tampered = Buffer.from(original);
            // Replacing encoded characters may leave the decoded bytes unchanged.
            // Flip a bit instead, guaranteeing a real change for every random package.
            tampered[tampered.length - 1] ^= 1;
            container[field] = tampered.toString("base64url");
            assert.notDeepEqual(Buffer.from(container[field], "base64url"), original);
            await assert.rejects(
                () => decryptMigrationPackage(Buffer.from(JSON.stringify(envelope)), passphrase),
                (error) => error.code === "MIGRATION_PACKAGE_DECRYPT_FAILED" && error.statusCode === 422,
            );
        });
    }
});

test("school migration package enforces a meaningful passphrase", async () => {
    await assert.rejects(
        () => encryptMigrationPayload(payload, "short"),
        (error) => error.code === "MIGRATION_PASSPHRASE_INVALID" && error.statusCode === 422,
    );
});
