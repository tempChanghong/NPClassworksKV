import assert from "node:assert/strict";
import test from "node:test";
import {
    createHttpCorsOptions,
    getAllowedOrigins,
    isOriginAllowed,
} from "../utils/corsConfig.js";

test("production CORS accepts only configured frontend origins", () => {
    const env = {
        NODE_ENV: "production",
        FRONTEND_URL: "https://newfires.top",
        CORS_ALLOWED_ORIGINS: "https://newfires.top, https://staging.newfires.top/path",
    };
    assert.deepEqual(getAllowedOrigins(env), [
        "https://newfires.top",
        "https://staging.newfires.top",
    ]);
    assert.equal(isOriginAllowed("https://newfires.top", env), true);
    assert.equal(isOriginAllowed("https://evil.example", env), false);
    assert.equal(isOriginAllowed(undefined, env), true);
});

test("development CORS retains both local Vite origins", () => {
    const origins = getAllowedOrigins({NODE_ENV: "development"});
    assert.ok(origins.includes("http://localhost:3031"));
    assert.ok(origins.includes("http://127.0.0.1:3031"));
});

test("HTTP preflight uses the same origin decision", async () => {
    const options = createHttpCorsOptions({
        NODE_ENV: "production",
        FRONTEND_URL: "https://newfires.top",
    });
    const decide = (origin) => new Promise((resolve, reject) => {
        options.origin(origin, (error, allowed) => error ? reject(error) : resolve(allowed));
    });
    assert.equal(await decide("https://newfires.top"), true);
    assert.equal(await decide("https://evil.example"), false);
    assert.ok(options.allowedHeaders.includes("X-Classworks-Device-ID"));
    assert.ok(options.allowedHeaders.includes("X-NPClassworks-Migration-Passphrase"));
    assert.ok(options.exposedHeaders.includes("Content-Disposition"));
});
