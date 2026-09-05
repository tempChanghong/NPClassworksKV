import {execFileSync} from "node:child_process";
import {writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

function git(root, args) {
    return execFileSync("git", ["-C", root, ...args], {encoding: "utf8", env: {...process.env, GIT_TERMINAL_PROMPT: "0"}}).trim();
}

function resolveComponent(root, ref, component) {
    const commit = git(root, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"]);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(component + " commit 无效");
    let contract;
    try { contract = JSON.parse(git(root, ["show", commit + ":deploy/compatibility.json"])); }
    catch { throw new Error(component + " 缺少有效的 deploy/compatibility.json；拒绝部署未经声明的版本组合"); }
    if (contract.schemaVersion !== 1 || contract.component !== component
        || !Number.isSafeInteger(contract.compatibilityEpoch) || contract.compatibilityEpoch < 1) {
        throw new Error(component + " 部署兼容性声明无效");
    }
    if (contract.requiresPeerCommit !== undefined && !/^[a-f0-9]{40}$/.test(contract.requiresPeerCommit)) {
        throw new Error(component + " requiresPeerCommit 必须是完整提交 SHA");
    }
    return {commit, contract};
}

export function resolveRelease({backendRoot, frontendRoot, backendRef = "HEAD", frontendRef = "HEAD"}) {
    const backend = resolveComponent(backendRoot, backendRef, "backend");
    const frontend = resolveComponent(frontendRoot, frontendRef, "frontend");
    if (backend.contract.compatibilityEpoch !== frontend.contract.compatibilityEpoch) {
        throw new Error("前后端 compatibilityEpoch 不一致，配套提交尚未齐备；保留当前部署");
    }
    for (const [component, peerRoot, peer] of [[backend, frontendRoot, frontend], [frontend, backendRoot, backend]]) {
        if (component.contract.requiresPeerCommit) {
            try { git(peerRoot, ["merge-base", "--is-ancestor", component.contract.requiresPeerCommit, peer.commit]); }
            catch { throw new Error(component.contract.component + " 所需的配套提交尚未包含在另一端版本中"); }
        }
    }
    return {schemaVersion: 1, resolvedAt: new Date().toISOString(), backend, frontend};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const [backendRoot, frontendRoot, backendRef, frontendRef, output] = process.argv.slice(2);
        if (!backendRoot || !frontendRoot || !output) throw new Error("缺少仓库路径、引用或计划输出路径");
        const plan = resolveRelease({backendRoot, frontendRoot, backendRef, frontendRef});
        writeFileSync(output, JSON.stringify(plan, null, 2) + "\n", {mode: 0o600});
        console.log("部署版本已固定：backend=" + plan.backend.commit + " frontend=" + plan.frontend.commit);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
