import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const sourcePath = path.resolve("deploy/.env.production.example");
const targetPath = path.resolve(process.argv[2] || "deploy/.env.production");

if (fs.existsSync(targetPath)) {
    console.error(`拒绝覆盖已有文件：${targetPath}`);
    process.exit(1);
}

function secret() {
    return crypto.randomBytes(48).toString("base64url");
}

let content = fs.readFileSync(sourcePath, "utf8");
for (const [key, value] of [
    ["POSTGRES_PASSWORD", secret()],
    ["JWT_SECRET", secret()],
    ["REFRESH_TOKEN_SECRET", secret()],
    ["METRICS_TOKEN", secret()],
    ["BOOTSTRAP_SETUP_KEY", secret()],
]) {
    content = content.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`);
}

fs.writeFileSync(targetPath, content, {encoding: "utf8", mode: 0o600, flag: "wx"});
console.log(`已生成 ${targetPath}`);
console.log("下一步：妥善保存 BOOTSTRAP_SETUP_KEY，然后运行 pnpm run deploy:check。");
