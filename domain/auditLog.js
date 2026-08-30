const SENSITIVE_KEYS = /(?:password|passphrase|pin|token|secret|authorization|cookie|hash|setupKey)/i;

export function sanitizeAuditValue(value, depth = 0) {
    if (depth > 5) return "[TRUNCATED]";
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeAuditValue(item, depth + 1));
    if (!value || typeof value !== "object") {
        return typeof value === "string" && value.length > 500 ? `${value.slice(0, 500)}…` : value;
    }
    return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [
        key,
        SENSITIVE_KEYS.test(key) ? "[REDACTED]" : sanitizeAuditValue(item, depth + 1),
    ]));
}
