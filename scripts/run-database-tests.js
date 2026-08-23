import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const projectName = `npclassworks-integration-${process.pid}`;
const composeFile = fileURLToPath(new URL("../docker-compose.integration.yml", import.meta.url));
const prismaCli = fileURLToPath(new URL("../node_modules/prisma/build/index.js", import.meta.url));
const port = process.env.INTEGRATION_POSTGRES_PORT || "55433";
const user = process.env.INTEGRATION_POSTGRES_USER || "npclassworks_test";
const password = process.env.INTEGRATION_POSTGRES_PASSWORD || "npclassworks_test_only";
const database = process.env.INTEGRATION_POSTGRES_DB || "npclassworks_test";
const databaseUrl = `postgresql://${user}:${password}@127.0.0.1:${port}/${database}?schema=public`;
const composeArgs = ["compose", "--project-name", projectName, "-f", composeFile];

function run(command, args, env = process.env, {allowFailure = false} = {}) {
    const result = spawnSync(command, args, {stdio: "inherit", env});
    if (result.error && !allowFailure) throw result.error;
    if ((result.status ?? 1) !== 0 && !allowFailure) {
        throw new Error(`${command} ${args.join(" ")} 执行失败（${result.status}）`);
    }
    return result.status ?? 1;
}

const testEnv = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    RUN_DATABASE_TESTS: "true",
    BOOTSTRAP_SETUP_KEY: "integration-bootstrap-key-at-least-32-characters",
};

try {
    run("docker", [...composeArgs, "up", "-d", "--wait", "--wait-timeout", "60"]);
    run(process.execPath, [prismaCli, "migrate", "deploy"], testEnv);
    run(process.execPath, [
        "--test",
        "tests/operationalDatabase.integration.test.js",
        "tests/workspaceAssignmentDatabase.integration.test.js",
    ], testEnv);
    console.log("真实 PostgreSQL 集成测试通过。");
} finally {
    run("docker", [...composeArgs, "down", "--volumes", "--remove-orphans"], process.env, {allowFailure: true});
}
