// Only the student-visible fields from two consecutive, actually published revisions.
export function publicHomeworkCorrection(previous, current, workspaceIds) {
    if (!previous || previous.revision + 1 !== current.revision || previous.purgedAt || current.purgedAt) return null;
    const visible = row => row.snapshot?.type === "ASSIGNMENT" && row.snapshot.status === "PUBLISHED"
        && Number.isFinite(Date.parse(row.snapshot.publishAt)) && Date.parse(row.snapshot.publishAt) <= new Date(current.createdAt).getTime();
    if (!visible(previous) || !visible(current)) return null;
    const shared = workspaceIds.filter(id => previous.snapshot.targetWorkspaceIds?.includes(id) && current.snapshot.targetWorkspaceIds?.includes(id));
    if (!shared.length) return null;
    const view = row => {
        const s = row.snapshot, metadata = s.contentJson || {};
        return {title: s.title || "", content: s.content || "", dueAt: s.dueAt || "",
            submission: typeof metadata.submission === "string" ? metadata.submission : "",
            optionalContent: typeof metadata.optionalContent === "string" ? metadata.optionalContent : "",
            materials: typeof metadata.preparation?.text === "string" ? metadata.preparation.text : "",
            materialsDate: typeof metadata.preparation?.date === "string" ? metadata.preparation.date : "",
            correctionReason: typeof metadata.correctionReason === "string" ? metadata.correctionReason : ""};
    };
    const before = view(previous), after = view(current);
    if (!Object.keys(before).some(key => key !== "correctionReason" && before[key] !== after[key])) return null;
    return {revision: current.revision, changedAt: current.createdAt, before, after};
}
