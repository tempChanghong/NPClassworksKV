import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const compose = fs.readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
const caddy = fs.readFileSync(new URL("../deploy/Caddyfile", import.meta.url), "utf8");
const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

test("the production stack keeps PostgreSQL private and exposes only Caddy", () => {
    const postgresService = compose.slice(compose.indexOf("  postgres:"), compose.indexOf("  backend:"));
    assert.match(compose, /postgres:[\s\S]*image: postgres:17-alpine/);
    assert.doesNotMatch(postgresService, /ports:/);
    assert.match(compose, /caddy:[\s\S]*"80:80"[\s\S]*"443:443"/);
});

test("Caddy sends every backend namespace and readiness route to Node", () => {
    for (const path of [
        "/api/*",
        "/accounts/*",
        "/kv/*",
        "/apps/*",
        "/devices/*",
        "/auth/*",
        "/auto-auth/*",
        "/socket.io/*",
        "/check",
        "/ready",
        "/metrics",
    ]) {
        assert.ok(caddy.includes(path), `Caddy 缺少后端路径 ${path}`);
    }
    assert.match(caddy, /reverse_proxy backend:3000/);
    assert.match(caddy, /reverse_proxy frontend:80/);
});

test("the backend image deploys migrations before accepting traffic", () => {
    assert.match(dockerfile, /COPY \. \./);
    assert.match(dockerfile, /\.\/node_modules\/\.bin\/prisma migrate deploy && exec node \.\/bin\/www/);
    assert.match(dockerfile, /\/ready/);
});

test("the production stack supplies the one-time local bootstrap key", () => {
    assert.match(compose, /BOOTSTRAP_SETUP_KEY: \$\{BOOTSTRAP_SETUP_KEY:\?/);
    assert.match(compose, /ALLOW_OAUTH_BOOTSTRAP: \$\{ALLOW_OAUTH_BOOTSTRAP:-false\}/);
    assert.match(compose, /REFRESH_TOKEN_EXPIRES_IN: \$\{REFRESH_TOKEN_EXPIRES_IN:-30d\}/);
});
