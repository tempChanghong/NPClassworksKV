import assert from "node:assert/strict";
import test from "node:test";
import {collectProductionConfigErrors} from "../utils/productionConfig.js";

function validProductionEnvironment() {
    return {
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://classworks:password@postgres:5432/classworks",
        BASE_URL: "https://cs.newfires.top",
        FRONTEND_URL: "https://cs.newfires.top",
        JWT_ALG: "HS256",
        JWT_SECRET: "a".repeat(64),
        REFRESH_TOKEN_SECRET: "b".repeat(64),
        METRICS_TOKEN: "c".repeat(64),
        BOOTSTRAP_SETUP_KEY: "d".repeat(64),
        GITHUB_CLIENT_ID: "client-id",
        GITHUB_CLIENT_SECRET: "client-secret",
    };
}

test("a complete same-origin production environment is accepted", () => {
    assert.deepEqual(collectProductionConfigErrors(validProductionEnvironment()), []);
});

test("a split frontend and API production environment is accepted", () => {
    const env = validProductionEnvironment();
    env.BASE_URL = "https://api.newfires.top";
    env.FRONTEND_URL = "https://newfires.top";
    env.CORS_ALLOWED_ORIGINS = "https://newfires.top";
    assert.deepEqual(collectProductionConfigErrors(env), []);
});

test("production rejects wildcard, insecure and path-based CORS origins", () => {
    const env = validProductionEnvironment();
    env.CORS_ALLOWED_ORIGINS = "*,http://newfires.top,https://newfires.top/path";
    const errors = collectProductionConfigErrors(env);
    assert.equal(errors.filter((error) => error.includes("CORS_ALLOWED_ORIGINS")).length, 3);
});

test("production rejects placeholder secrets and insecure public URLs", () => {
    const env = validProductionEnvironment();
    env.BASE_URL = "http://cs.newfires.top/api";
    env.JWT_SECRET = "your-secret-key-change-this-in-production";
    env.REFRESH_TOKEN_SECRET = env.JWT_SECRET;

    const errors = collectProductionConfigErrors(env);
    assert.ok(errors.some((error) => error.includes("BASE_URL 在生产环境必须使用 HTTPS")));
    assert.ok(errors.some((error) => error.includes("BASE_URL 必须是纯站点根地址")));
    assert.ok(errors.some((error) => error.includes("JWT_SECRET 仍是示例默认值")));
    assert.ok(errors.some((error) => error.includes("必须使用不同值")));
});

test("production rejects the deployment example placeholders", () => {
    const env = validProductionEnvironment();
    env.METRICS_TOKEN = "replace_with_a_random_value_at_least_32_chars";
    assert.ok(
        collectProductionConfigErrors(env)
            .some((error) => error.includes("METRICS_TOKEN 仍是示例默认值")),
    );
});

test("production allows local school accounts without an OAuth provider", () => {
    const env = validProductionEnvironment();
    delete env.GITHUB_CLIENT_ID;
    delete env.GITHUB_CLIENT_SECRET;

    assert.deepEqual(collectProductionConfigErrors(env), []);
});

test("production requires a strong one-time bootstrap setup key", () => {
    const env = validProductionEnvironment();
    env.BOOTSTRAP_SETUP_KEY = "short";
    assert.ok(collectProductionConfigErrors(env).some((error) => error.includes("BOOTSTRAP_SETUP_KEY 至少需要 32 个字符")));
});
