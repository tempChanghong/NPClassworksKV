export function isLegacyClassworksEnabled(env = process.env) {
    const configured = String(env.ENABLE_LEGACY_CLASSWORKS_API || "").trim().toLowerCase();
    if (configured === "true") return true;
    if (configured === "false") return false;
    return env.NODE_ENV !== "production";
}
