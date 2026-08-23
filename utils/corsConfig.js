const DEVELOPMENT_ORIGINS = [
    "http://localhost:3031",
    "http://127.0.0.1:3031",
];

function normalizeOrigin(value) {
    try {
        return new URL(String(value || "").trim()).origin;
    } catch {
        return "";
    }
}

export function getAllowedOrigins(env = process.env) {
    const configured = String(env.CORS_ALLOWED_ORIGINS || env.FRONTEND_URL || "")
        .split(",")
        .map(normalizeOrigin)
        .filter(Boolean);
    const development = env.NODE_ENV === "production" ? [] : DEVELOPMENT_ORIGINS;
    return [...new Set([...configured, ...development])];
}

export function isOriginAllowed(origin, env = process.env) {
    if (!origin) return true;
    const normalized = normalizeOrigin(origin);
    return Boolean(normalized) && getAllowedOrigins(env).includes(normalized);
}

export function createHttpCorsOptions(env = process.env) {
    return {
        origin(origin, callback) {
            callback(null, isOriginAllowed(origin, env));
        },
        exposedHeaders: ["ratelimit-policy", "retry-after", "ratelimit", "X-New-Access-Token", "X-Token-Refreshed", "ETag"],
        maxAge: 86400,
        credentials: true,
        allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "X-Classworks-Screen-Token", "X-Classworks-Setup-Token", "If-Match"],
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    };
}
