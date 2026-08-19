function normalizeText(value) {
    return typeof value === "string"
        ? value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\p{P}\p{S}\s]+/gu, "")
        : "";
}

export function assignmentDuplicateReason(input, candidate) {
    const content = normalizeText(input?.content);
    const candidateContent = normalizeText(candidate?.content);
    if (content && content === candidateContent) return "CONTENT_MATCH";

    const title = normalizeText(input?.title);
    const candidateTitle = normalizeText(candidate?.title);
    if (!content && !candidateContent && title && title === candidateTitle) return "TITLE_MATCH";
    return null;
}

export function findDuplicateAssignmentCandidates(input, candidates = []) {
    return candidates.map((candidate) => ({
        candidate,
        reason: assignmentDuplicateReason(input, candidate),
    })).filter((item) => item.reason);
}
