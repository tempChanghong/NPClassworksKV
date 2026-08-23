import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const compose = fs.readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
const sharedCompose = fs.readFileSync(new URL("../docker-compose.shared.yml", import.meta.url), "utf8");
const caddy = fs.readFileSync(new URL("../deploy/Caddyfile", import.meta.url), "utf8");
const sharedCaddy = fs.readFileSync(new URL("../deploy/Caddyfile.shared.example", import.meta.url), "utf8");
const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const productionEnvExample = fs.readFileSync(new URL("../deploy/.env.production.example", import.meta.url), "utf8");
const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("the production stack keeps PostgreSQL private and exposes only Caddy", () => {
    const postgresService = compose.slice(compose.indexOf("  postgres:"), compose.indexOf("  backend:"));
    assert.match(compose, /postgres:[\s\S]*image: postgres:17-alpine/);
    assert.doesNotMatch(postgresService, /ports:/);
    assert.match(compose, /caddy:[\s\S]*"80:80"[\s\S]*"443:443"/);
});

test("shared-host deployment never occupies public HTTP ports", () => {
    assert.doesNotMatch(sharedCompose, /\n\s+caddy:/);
    assert.doesNotMatch(sharedCompose, /["']?(?:0\.0\.0\.0:)?(?:80|443):(?:80|443)/);
    assert.match(sharedCompose, /127\.0\.0\.1:\$\{SHARED_BACKEND_PORT:-13000}:3000/);
    assert.match(sharedCompose, /127\.0\.0\.1:\$\{SHARED_FRONTEND_PORT:-13080}:80/);
    const postgresService = sharedCompose.slice(sharedCompose.indexOf("  postgres:"), sharedCompose.indexOf("  backend:"));
    assert.doesNotMatch(postgresService, /ports:/);
    assert.match(sharedCaddy, /reverse_proxy 127\.0\.0\.1:13000/);
    assert.match(sharedCaddy, /reverse_proxy 127\.0\.0\.1:13080/);
    assert.match(sharedCaddy, /CLASSWORKS_DOMAIN:newfires\.top/);
    assert.match(sharedCaddy, /CLASSWORKS_API_DOMAIN:api\.newfires\.top/);
    assert.match(sharedCompose, /BASE_URL: \$\{VITE_DEFAULT_KV_SERVER/);
    assert.match(sharedCompose, /CORS_ALLOWED_ORIGINS:/);
    assert.match(sharedCompose, /VITE_DEFAULT_KV_SERVER: \$\{VITE_DEFAULT_KV_SERVER:-https:\/\/api\.newfires\.top}/);
    const deployLibrary = read("../deploy/lib.sh");
    const upgrade = read("../deploy/upgrade.sh");
    const rollback = read("../deploy/rollback.sh");
    assert.match(deployLibrary, /DEPLOY_MODE="\$\{DEPLOY_MODE:-standalone}"/);
    assert.match(deployLibrary, /shared\) COMPOSE_FILE="\$REPO_ROOT\/docker-compose\.shared\.yml"/);
    assert.match(upgrade, /compose_application_up -d/);
    assert.match(rollback, /compose_application_up -d --no-build --force-recreate/);
    assert.doesNotMatch(upgrade, /compose up -d postgres backend frontend caddy/);
    assert.doesNotMatch(rollback, /compose up .*backend frontend caddy/);
});

test("Caddy sends every backend namespace and readiness route to Node", () => {
    for (const path of [
        "/api/*",
        "/accounts/*",
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

test("Classworks 1 HTTP and Socket implementations are physically retired", () => {
    const app = read("../app.js");
    const accounts = read("../routes/accounts.js");
    const socket = read("../utils/socket.js");
    const backendHome = read("../views/index.ejs");
    for (const path of [
        "../routes/kv-token.js",
        "../routes/apps.js",
        "../routes/device.js",
        "../routes/device-auth.js",
        "../routes/auto-auth.js",
    ]) {
        assert.equal(fs.existsSync(new URL(path, import.meta.url)), false, path);
    }
    assert.doesNotMatch(app, /ENABLE_LEGACY_CLASSWORKS_API|kvRouter|appsRouter|deviceRouter/);
    assert.doesNotMatch(socket, /join-token|send-event|deviceUuids|appInstall/);
    assert.match(accounts, /router\.use\([\s\S]*req\.path\.startsWith\("\/devices\/"\)[\s\S]*status\(410\)/);
    assert.ok(accounts.indexOf("router.use(") < accounts.indexOf('router.post("/devices/bind"'));
    assert.match(caddy, /@retired[\s\S]*\/kv \/kv\/\*[\s\S]*respond .* 410/);
    assert.doesNotMatch(compose, /VITE_ENABLE_LEGACY_CLASSWORKS|ENABLE_LEGACY_CLASSWORKS_API/);
    assert.doesNotMatch(productionEnvExample, /ENABLE_LEGACY_CLASSWORKS_API/);
    assert.doesNotMatch(backendHome, /kv\.houlang\.cloud|window\.open|location\s*=/);
    assert.match(backendHome, /NPClassworks 服务端/);
});

test("classroom screens can only be provisioned through managed screen accounts", () => {
    const academicAdmin = read("../routes/v2/academic-admin.js");
    assert.doesNotMatch(academicAdmin, /classroom-screens\/bind/);
    assert.doesNotMatch(academicAdmin, /bindClassroomScreen/);
    assert.match(academicAdmin, /classroom-screen-accounts/);
    assert.match(academicAdmin, /configureClassroomScreenAccount/);
});

test("release verification runs isolated real PostgreSQL integration tests", () => {
    const integrationCompose = read("../docker-compose.integration.yml");
    const integrationRunner = read("../scripts/run-database-tests.js");
    assert.equal(packageJson.scripts["test:database"], "node scripts/run-database-tests.js");
    assert.match(integrationRunner, /--test-concurrency=1/);
    assert.match(integrationCompose, /postgres:17-alpine/);
    assert.match(integrationCompose, /tmpfs:/);
    assert.match(integrationRunner, /prisma[\s\S]*migrate[\s\S]*deploy/);
    assert.match(integrationRunner, /RUN_DATABASE_TESTS:\s*"true"/);
    assert.match(integrationRunner, /down[\s\S]*--volumes[\s\S]*--remove-orphans/);
});

test("production frontend analytics remain opt-in", () => {
    assert.match(compose, /VITE_ENABLE_ANALYTICS:\s*["']?false["']?/);
});

test("production images have stable local tags for application rollback", () => {
    assert.match(compose, /backend:[\s\S]*image: npclassworks-backend:current/);
    assert.match(compose, /frontend:[\s\S]*image: npclassworks-frontend:current/);
    assert.match(compose, /VITE_DEFAULT_KV_SERVER:/);
    assert.doesNotMatch(compose, /VITE_DEFAULT_AUTH_SERVER|VITE_DEFAULT_SERVER_PROVIDER/);
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
