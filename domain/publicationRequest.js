import {createHash} from "node:crypto";

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
}

export function screenPublicationRequest(input) {
    const id = input?.clientRequestId;
    if (id === undefined) return null; // Existing clients remain supported.
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) {
        throw Object.assign(new Error("无效的作业提交标识"), {code: "INVALID_PUBLICATION_REQUEST_ID", statusCode: 422});
    }
    // allowDuplicate only confirms an earlier rejected attempt; it does not change content.
    const {clientRequestId, allowDuplicate, ...payload} = input;
    void clientRequestId;
    void allowDuplicate;
    return {id, hash: createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex")};
}
