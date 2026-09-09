import assert from "node:assert/strict";
import test from "node:test";
import {getAccountPublicationCertification} from "../services/publicationAuthorizationService.js";

const workspace = {id: "class", type: "ADMIN_CLASS", term: {schoolId: "school", school: {teacherAuthMode: "LOCAL_PIN"}}};
function client(role = "TEACHER") {
    return {
        account: {findUnique: async () => ({provider: "school-local"})},
        workspaceMember: {findMany: async () => [{workspaceId: workspace.id, role}]},
        schoolMember: {findMany: async () => []},
        administrativeClassLeadership: {findMany: async () => []},
        teachingAssignment: {findMany: async () => [{workspaceId: workspace.id, subjectId: "math"}]},
    };
}
const snapshot = (type, subjectId = null) => ({type, subjectId, targetWorkspaceIds: [workspace.id]});

test("authorized classroom teacher notices are confirmed without a subject or management role", async () => {
    const result = await getAccountPublicationCertification("teacher", snapshot("NOTICE"), [workspace], client());
    assert.equal(result.isCertified, true);
    assert.equal(result.certifiedByAccountId, "teacher");
    assert.ok(result.certifiedAt instanceof Date);
});

test("notice confirmation still requires write access to every target", async () => {
    await assert.rejects(getAccountPublicationCertification("viewer", snapshot("NOTICE"), [workspace], client("VIEWER")),
        {code: "WORKSPACE_WRITE_FORBIDDEN"});
    const other = {...workspace, id: "other"};
    await assert.rejects(getAccountPublicationCertification("teacher", {type: "NOTICE", targetWorkspaceIds: [workspace.id, other.id]},
        [workspace, other], client()), {code: "WORKSPACE_WRITE_FORBIDDEN"});
});

test("homework confirmation continues to distinguish own subject from another subject", async () => {
    assert.equal((await getAccountPublicationCertification("teacher", snapshot("ASSIGNMENT", "math"), [workspace], client())).isCertified, true);
    assert.deepEqual(await getAccountPublicationCertification("teacher", snapshot("ASSIGNMENT", "physics"), [workspace], client()),
        {isCertified: false, certifiedByAccountId: null, certifiedAt: null});
});
