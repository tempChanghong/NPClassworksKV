import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import {collectProductionConfigErrors} from "../utils/productionConfig.js";

const envPath = path.resolve(process.argv[2] || "deploy/.env.production");
if (!fs.existsSync(envPath)) {
    console.error(`找不到生产环境文件：${envPath}`);
    console.error("请先复制 deploy/.env.production.example 并填写真实值。");
    process.exit(1);
}

const parsed = dotenv.parse(fs.readFileSync(envPath));
const domain = parsed.CLASSWORKS_DOMAIN || "cs.newfires.top";
const environment = {
    ...parsed,
    NODE_ENV: "production",
    DATABASE_URL: `postgresql://${parsed.POSTGRES_USER || "classworks"}:${parsed.POSTGRES_PASSWORD || ""}@postgres:5432/${parsed.POSTGRES_DB || "classworks"}`,
    BASE_URL: `https://${domain}`,
    FRONTEND_URL: `https://${domain}`,
};

const errors = collectProductionConfigErrors(environment);
if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain)) {
    errors.push("CLASSWORKS_DOMAIN 不是有效的主机名");
}
if (!new Set(["standalone", "shared"]).has(parsed.DEPLOY_MODE || "standalone")) {
    errors.push("DEPLOY_MODE 只能是 standalone 或 shared");
}

const sharedPorts = [
    ["SHARED_BACKEND_PORT", parsed.SHARED_BACKEND_PORT || "13000"],
    ["SHARED_FRONTEND_PORT", parsed.SHARED_FRONTEND_PORT || "13080"],
];
for (const [key, raw] of sharedPorts) {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        errors.push(`${key} 必须是 1024 至 65535 之间的端口`);
    }
}
if (Number(sharedPorts[0][1]) === Number(sharedPorts[1][1])) {
    errors.push("SHARED_BACKEND_PORT 与 SHARED_FRONTEND_PORT 不能相同");
}
if (!parsed.POSTGRES_PASSWORD || parsed.POSTGRES_PASSWORD.startsWith("replace_")) {
    errors.push("POSTGRES_PASSWORD 尚未替换为真实随机值");
} else if (!/^[A-Za-z0-9_-]+$/.test(parsed.POSTGRES_PASSWORD)) {
    errors.push("POSTGRES_PASSWORD 只能使用 URL-safe 字母、数字、下划线和连字符");
}

if (errors.length > 0) {
    console.error("生产部署检查失败：");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
}

console.log(`生产环境检查通过：https://${domain}`);
