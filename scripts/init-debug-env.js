import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const backendEnvPath = path.resolve("deploy/.env.debug");
const frontendEnvPath = path.resolve("../NPClassworks/.env.local");

function secret() {
    return crypto.randomBytes(36).toString("base64url");
}

function writeNewFile(targetPath, content) {
    if (fs.existsSync(targetPath)) {
        console.log(`保留已有文件：${targetPath}`);
        return false;
    }
    fs.mkdirSync(path.dirname(targetPath), {recursive: true});
    fs.writeFileSync(targetPath, content, {encoding: "utf8", mode: 0o600, flag: "wx"});
    console.log(`已生成：${targetPath}`);
    return true;
}

const postgresPassword = secret();
const backendEnv = [
    "NODE_ENV=development",
    "PORT=3000",
    "BASE_URL=http://localhost:3000",
    "FRONTEND_URL=http://localhost:3031",
    "DEBUG_POSTGRES_PORT=55432",
    "POSTGRES_USER=classworks_debug",
    "POSTGRES_DB=classworks_debug",
    `POSTGRES_PASSWORD=${postgresPassword}`,
    `DATABASE_URL=postgresql://classworks_debug:${postgresPassword}@127.0.0.1:55432/classworks_debug?schema=public`,
    "JWT_ALG=HS256",
    `JWT_SECRET=${secret()}`,
    `REFRESH_TOKEN_SECRET=${secret()}`,
    `METRICS_TOKEN=${secret()}`,
    `BOOTSTRAP_SETUP_KEY=${secret()}`,
    "ALLOW_OAUTH_BOOTSTRAP=false",
    "ACCESS_TOKEN_EXPIRES_IN=15m",
    "REFRESH_TOKEN_EXPIRES_IN=30d",
    "LOCAL_AUTH_BCRYPT_ROUNDS=10",
    "",
].join("\n");

const frontendEnv = [
    "VITE_DEFAULT_KV_SERVER=http://localhost:3031",
    "VITE_SERVER_URL=http://localhost:3031",
    "",
].join("\n");

writeNewFile(backendEnvPath, backendEnv);
writeNewFile(frontendEnvPath, frontendEnv);
console.log("调试环境文件已就绪。下一步运行 pnpm run debug:db:up 和 pnpm run debug:prepare。");
