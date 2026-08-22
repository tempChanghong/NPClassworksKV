import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const compose = fs.readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
const caddy = fs.readFileSync(new URL("../deploy/Caddyfile", import.meta.url), "utf8");
const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

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
    assert.match(dockerfile, /apt-get install -y --no-install-recommends openssl/);
    assert.match(dockerfile, /COPY \. \./);
    assert.match(dockerfile, /\.\/node_modules\/\.bin\/prisma migrate deploy && exec node \.\/bin\/www/);
    assert.match(dockerfile, /\/ready/);
});

test("the production stack supplies the one-time local bootstrap key", () => {
    assert.match(compose, /BOOTSTRAP_SETUP_KEY: \$\{BOOTSTRAP_SETUP_KEY:\?/);
    assert.match(compose, /ALLOW_OAUTH_BOOTSTRAP: \$\{ALLOW_OAUTH_BOOTSTRAP:-false\}/);
    assert.match(compose, /REFRESH_TOKEN_EXPIRES_IN: \$\{REFRESH_TOKEN_EXPIRES_IN:-30d\}/);
});

test("production images have stable local tags for application rollback", () => {
    assert.match(compose, /backend:[\s\S]*image: npclassworks-backend:current/);
    assert.match(compose, /frontend:[\s\S]*image: npclassworks-frontend:current/);
    assert.match(compose, /VITE_DEFAULT_SERVER_PROVIDER: kv-server/);
});

test("database operations create verified backups and require explicit restore confirmation", () => {
    const backup = read("../deploy/backup.sh");
    const restore = read("../deploy/restore.sh");
    assert.match(backup, /pg_dump[\s\S]*--format custom/);
    assert.match(backup, /pg_restore --list/);
    assert.match(backup, /sha256sum/);
    assert.match(restore, /--yes/);
    assert.match(restore, /backup\.sh.*pre-restore/);
    assert.match(restore, /dropdb[\s\S]*createdb[\s\S]*pg_restore/);
});

test("upgrade retains previous images and database while rollback is explicit", () => {
    const upgrade = read("../deploy/upgrade.sh");
    const rollback = read("../deploy/rollback.sh");
    const timer = read("../deploy/install-backup-timer.sh");
    assert.match(upgrade, /backup\.sh.*pre-upgrade/);
    assert.match(upgrade, /npclassworks-backend:rollback-/);
    assert.match(upgrade, /rollback-state\.env/);
    assert.match(rollback, /--restore-database/);
    assert.match(rollback, /--force-recreate/);
    assert.match(timer, /OnCalendar=\*-\*-\* 03:30:00/);
    assert.match(timer, /Persistent=true/);
});
