export function withoutCorrection(metadata) {
    if (!metadata || !Object.hasOwn(metadata, "correctionReason")) return metadata;
    const result = {...metadata};
    delete result.correctionReason;
    return Object.keys(result).length ? result : null;
}

export function validateSubmission(metadata, type, errors) {
    const text = metadata?.submission;
    if (text == null) return;
    if (type !== "ASSIGNMENT" || typeof text !== "string" || text.length > 500 || (metadata.kind === "NO_HOMEWORK" && text.trim())) {
        errors.push({path: "contentJson.submission", code: "INVALID_HOMEWORK_SUBMISSION", message: "提交说明仅适用于有作业的记录，不能超过500字"});
    }
}

// A reason belongs to this teacher edit, never to copied/restored content.
export function withCorrection(metadata, reason, eligible) {
    if (reason !== undefined && (typeof reason !== "string" || reason.length > 300)) {
        throw Object.assign(new Error("更正原因不能超过300字"), {statusCode: 422, code: "INVALID_CORRECTION_REASON"});
    }
    if (reason?.trim() && !eligible) {
        throw Object.assign(new Error("仅修改已发布作业时可填写更正原因"), {statusCode: 422, code: "INVALID_CORRECTION_REASON"});
    }
    const result = withoutCorrection(metadata);
    return reason?.trim() ? {...result, correctionReason: reason.trim()} : result;
}
