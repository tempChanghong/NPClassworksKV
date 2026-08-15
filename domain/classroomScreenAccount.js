export function normalizeScreenLoginCode(value) {
    return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export function validateScreenLoginCode(value) {
    return /^[A-Z0-9][A-Z0-9._-]{2,31}$/.test(normalizeScreenLoginCode(value));
}

export function validateScreenPin(value) {
    return typeof value === "string" && /^\d{4,8}$/.test(value);
}

export function validateDeviceFingerprint(value) {
    const fingerprint = typeof value === "string" ? value.trim() : "";
    return Boolean(fingerprint && fingerprint !== "unknown" && fingerprint.length <= 191);
}
