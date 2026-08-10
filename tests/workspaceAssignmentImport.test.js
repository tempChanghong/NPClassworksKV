import assert from "node:assert/strict";
import test from "node:test";
import {
    normalizeAssignmentEmail,
    validateWorkspaceAssignmentImport,
} from "../domain/workspaceAssignmentImport.js";

test("teacher assignment import normalizes email and workspace codes", () => {
    const result = validateWorkspaceAssignmentImport({
        assignments: [{
            email: " Teacher@Example.COM ",
            role: "teacher",
            workspaceCodes: ["g2-c1", "G2-PHY-A1", "g2-c1"],
        }],
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.normalized.assignments[0], {
        email: "teacher@example.com",
        role: "TEACHER",
        workspaceCodes: ["G2-C1", "G2-PHY-A1"],
    });
    assert.deepEqual(result.summary, {teachers: 1, memberships: 2});
});

test("teacher assignment import rejects conflicting roles for one workspace", () => {
    const result = validateWorkspaceAssignmentImport({
        assignments: [
            {email: "teacher@example.com", role: "TEACHER", workspaceCodes: ["G2-C1"]},
            {email: "teacher@example.com", role: "VIEWER", workspaceCodes: ["G2-C1"]},
        ],
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === "CONFLICTING_ASSIGNMENT_ROLE"));
});

test("assignment email matching is case insensitive", () => {
    assert.equal(normalizeAssignmentEmail(" A.B@School.EDU "), "a.b@school.edu");
});

test("duplicate rows with the same role collapse into one assignment", () => {
    const result = validateWorkspaceAssignmentImport({
        assignments: [
            {email: "teacher@example.com", role: "TEACHER", workspaceCodes: ["G2-C1"]},
            {email: "TEACHER@example.com", role: "TEACHER", workspaceCodes: ["G2-C1", "G2-C2"]},
        ],
    });
    assert.equal(result.valid, true);
    assert.equal(result.normalized.assignments.length, 1);
    assert.deepEqual(result.normalized.assignments[0].workspaceCodes, ["G2-C1", "G2-C2"]);
    assert.equal(result.summary.memberships, 2);
});
