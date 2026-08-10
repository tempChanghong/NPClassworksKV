const PLACEHOLDER_VALUES = new Set([
    "your-secret-key-change-this-in-production",
    "your-access-token-secret-change-this-in-production",
    "your-refresh-token-secret-change-this-in-production",
    "replace_with_a_one_time_setup_key_at_least_32_chars",
]);

const OAUTH_PROVIDERS = [
    {name: "GitHub", clientId: "GITHUB_CLIENT_ID", clientSecret: "GITHUB_CLIENT_SECRET"},
    {name: "ZeroCat", clientId: "ZEROCAT_CLIENT_ID", clientSecret: "ZEROCAT_CLIENT_SECRET"},
    {name: "智教联盟", clientId: "STCN_CLIENT_ID", clientSecret: "STCN_CLIENT_SECRET"},
    {name: "厚浪云", clientId: "HLY_CLIENT_ID", clientSecret: "HLY_CLIENT_SECRET", secretOptional: true},
    {name: "Dlass", clientId: "DLASS_CLIENT_ID", clientSecret: "DLASS_CLIENT_SECRET"},
];

function isConfigured(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function validateHttpsUrl(errors, env, key) {
    const raw = env[key];
    if (!isConfigured(raw)) {
        errors.push(`${key} 未设置`);
        return;
    }
    try {
        const url = new URL(raw);
        if (url.protocol !== "https:") errors.push(`${key} 在生产环境必须使用 HTTPS`);
        if (url.pathname !== "/" || url.search || url.hash) {
            errors.push(`${key} 必须是纯站点根地址，不能包含路径、查询参数或锚点`);
        }
    } catch {
        errors.push(`${key} 不是有效 URL`);
    }
}

function validateSecret(errors, env, key) {
    const value = env[key];
    if (!isConfigured(value)) {
        errors.push(`${key} 未设置`);
    } else if (value.length < 32) {
        errors.push(`${key} 至少需要 32 个字符`);
    } else if (PLACEHOLDER_VALUES.has(value) || value.startsWith("replace_")) {
        errors.push(`${key} 仍是示例默认值`);
    }
}

export function collectProductionConfigErrors(env = process.env) {
    if (env.NODE_ENV !== "production") return [];

    const errors = [];
    const databaseUrl = env.DATABASE_URL || "";
    if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
        errors.push("DATABASE_URL 必须是 PostgreSQL 连接地址");
    }

    validateHttpsUrl(errors, env, "BASE_URL");
    validateHttpsUrl(errors, env, "FRONTEND_URL");
    validateSecret(errors, env, "METRICS_TOKEN");
    validateSecret(errors, env, "BOOTSTRAP_SETUP_KEY");

    const algorithm = (env.JWT_ALG || "HS256").toUpperCase();
    if (algorithm === "HS256") {
        validateSecret(errors, env, "JWT_SECRET");
        validateSecret(errors, env, "REFRESH_TOKEN_SECRET");
        if (env.JWT_SECRET && env.JWT_SECRET === env.REFRESH_TOKEN_SECRET) {
            errors.push("JWT_SECRET 与 REFRESH_TOKEN_SECRET 必须使用不同值");
        }
    } else if (algorithm === "RS256") {
        for (const key of [
            "JWT_PRIVATE_KEY",
            "JWT_PUBLIC_KEY",
            "ACCESS_TOKEN_PRIVATE_KEY",
            "ACCESS_TOKEN_PUBLIC_KEY",
            "REFRESH_TOKEN_PRIVATE_KEY",
            "REFRESH_TOKEN_PUBLIC_KEY",
        ]) {
            if (!isConfigured(env[key])) errors.push(`${key} 未设置`);
        }
    } else {
        errors.push(`JWT_ALG 不支持 ${algorithm}，只能使用 HS256 或 RS256`);
    }

    for (const provider of OAUTH_PROVIDERS) {
        const hasClientId = isConfigured(env[provider.clientId]);
        const hasSecret = isConfigured(env[provider.clientSecret]);
        if (!provider.secretOptional && hasClientId !== hasSecret) {
            errors.push(`${provider.name} OAuth 的 Client ID 与 Client Secret 必须成对设置`);
        }
    }
    // OAuth 现在是学校初始化时可选的兼容登录方式，不再是生产启动前提。

    return errors;
}

export function assertProductionConfig(env = process.env) {
    const errors = collectProductionConfigErrors(env);
    if (errors.length > 0) {
        throw new Error(`生产环境配置不完整：\n- ${errors.join("\n- ")}`);
    }
}
