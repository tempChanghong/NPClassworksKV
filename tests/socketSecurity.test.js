import assert from "node:assert/strict";
import test from "node:test";
import {createServer} from "node:http";
import {prisma} from "../utils/prisma.js";
import {initSocket, broadcastWorkspaceEvent} from "../utils/socket.js";
import {generateAccessToken} from "../utils/tokenManager.js";
import {canReceiveWorkspaceEvent} from "../services/socketEventAuthorization.js";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test("real sockets keep public refresh usable, hide draft metadata and recheck active credentials", async t => {
    const account = {id: "author", provider: "stcn", tokenVersion: 1};
    let version = 1, revoked = false;
    let publication = {id: "publication", authorAccountId: "author", status: "DRAFT", type: "ASSIGNMENT", revision: 1, targets: []};
    const workspace = {id: "workspace", isActive: true, type: "ADMIN_CLASS", termId: "term", gradeId: "grade", subjectRules: [], term: {status: "ACTIVE"}};
    const oldWorkspace = prisma.workspace.findMany, oldPublication = prisma.publication.findUnique;
    const oldAccount = prisma.account.findUnique, oldSession = prisma.accountSession.findUnique;
    const oldScreen = prisma.classroomScreenBinding.findUnique;
    prisma.workspace.findMany = async () => [workspace];
    prisma.publication.findUnique = async () => publication;
    prisma.account.findUnique = async () => ({...account, tokenVersion: version});
    prisma.accountSession.findUnique = async () => ({id: "session", accountId: account.id, revokedAt: revoked ? new Date() : null, expiresAt: new Date(Date.now() + 60000)});
    prisma.classroomScreenBinding.findUnique = async () => ({isActive: true, administrativeClass: workspace, lastUsedAt: new Date()});
    const server = createServer(); const socketServer = initSocket(server);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const clients = [];
    t.after(async () => {
        clients.forEach(client => client.close());
        await new Promise(resolve => socketServer.close(resolve));
        prisma.workspace.findMany = oldWorkspace; prisma.publication.findUnique = oldPublication;
        prisma.account.findUnique = oldAccount; prisma.accountSession.findUnique = oldSession;
        prisma.classroomScreenBinding.findUnique = oldScreen;
    });
    async function client(credentials = {}) {
        const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/socket.io/?EIO=4&transport=websocket`);
        clients.push(socket);
        const events = [];
        let connected, joined;
        const connection = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("socket connection timed out")), 5000);
            connected = () => {clearTimeout(timeout); resolve();};
            socket.addEventListener("error", reject, {once: true});
        });
        socket.addEventListener("message", event => {
            const data = String(event.data);
            if (data.startsWith("0")) socket.send("40" + JSON.stringify(credentials));
            if (data === "2") socket.send("3");
            if (data.startsWith("40")) connected();
            if (data.startsWith("42")) {
                const [event, payload] = JSON.parse(data.slice(2));
                if (event === "workspaces-joined") joined?.();
                if (event.startsWith("publication.") || event.startsWith("classroom.")) events.push({event, payload});
            }
        });
        await connection;
        const membership = new Promise(resolve => {joined = resolve;});
        socket.send("42" + JSON.stringify(["join-workspaces", {workspaceIds: [workspace.id], credentials}])); await membership;
        return {socket, events};
    }
    const anonymous = await client();
    const teacher = await client({accessToken: generateAccessToken(account, "session")});
    const screen = await client({screenToken: "screen-token"});
    async function send(wasPublished = false) {
        await broadcastWorkspaceEvent([workspace.id], "publication.updated", {publicationId: publication.id,
            revision: publication.revision, status: publication.status, publicationType: publication.type}, {wasPublished});
        await wait(15);
    }
    await send();
    assert.equal(anonymous.events.length, 0); assert.equal(screen.events.length, 0);
    assert.equal(teacher.events.at(-1).payload.content.status, "DRAFT");
    publication = {...publication, status: "PUBLISHED", targets: [{workspaceId: workspace.id, workspace}]};
    await send();
    assert.deepEqual(anonymous.events.at(-1), {event: "publication.feed.changed", payload: {}});
    assert.equal(screen.events.at(-1).payload.content.publicationId, publication.id);
    revoked = true; const count = teacher.events.length;
    publication = {...publication, status: "DRAFT"}; await send(true);
    assert.equal(teacher.events.length, count + 1);
    assert.deepEqual(teacher.events.at(-1), {event: "publication.feed.changed", payload: {}});
    assert.deepEqual(anonymous.events.at(-1), {event: "publication.feed.changed", payload: {}});
    await send(); assert.equal(teacher.events.length, count + 1);
    version = 2; revoked = false;
    await send(); assert.equal(teacher.events.length, count + 1);
    publication = {...publication, status: "PUBLISHED", type: "NOTICE"};
    await send(); assert.equal(screen.events.at(-1).event, "publication.feed.changed");
    await broadcastWorkspaceEvent([workspace.id], "classroom.roster.updated", {administrativeClassId: workspace.id});
    await wait(15); assert(anonymous.events.every(event => !event.event.startsWith("classroom.")));
});

test("non-author OAuth teachers receive authorized drafts, membership removal and school policy changes stop delivery", async t => {
    const restorations = [];
    const stub = (object, key, value) => {const old = object[key]; object[key] = value; restorations.push(() => {object[key] = old;});};
    t.after(() => restorations.reverse().forEach(restore => restore()));
    const account = {id: "other-teacher", provider: "stcn", tokenVersion: 1};
    let membership = true, oauthAllowed = true;
    const workspace = {id: "workspace", type: "ADMIN_CLASS", isActive: true, termId: "term", gradeId: "grade",
        term: {schoolId: "school", status: "ACTIVE"}, sourceClasses: [], subjectRules: []};
    const school = () => ({teacherAuthMode: oauthAllowed ? "OAUTH_EMAIL" : "LOCAL_PIN", allowOAuthTeacherLogin: false});
    stub(prisma.account, "findUnique", async () => account);
    stub(prisma.accountSession, "findUnique", async () => ({accountId: account.id, expiresAt: new Date(Date.now() + 60000)}));
    stub(prisma.workspaceMember, "findMany", async () => membership ? [{workspaceId: workspace.id, role: "TEACHER"}] : []);
    for (const object of [prisma.schoolMember, prisma.gradeLeadership, prisma.administrativeClassLeadership]) stub(object, "findMany", async () => []);
    stub(prisma.workspace, "findMany", async () => [{...workspace, term: {...workspace.term, school: school()}}]);
    stub(prisma.publication, "findUnique", async ({include}) => ({id: "draft", authorAccountId: "author", type: "ASSIGNMENT", status: "DRAFT", revision: 1,
        targets: [{workspaceId: workspace.id, workspace: {...workspace, term: {...workspace.term,
            ...(include.targets.include.workspace.include.term.include?.school ? {school: school()} : {})}}}]}));
    const credentials = {accessToken: generateAccessToken(account, "session")};
    const receives = () => canReceiveWorkspaceEvent(credentials, [workspace.id], "publication.updated", {publicationId: "draft", revision: 1});
    assert.equal(await receives(), true);
    membership = false; assert.equal(await receives(), false);
    membership = true; oauthAllowed = false; assert.equal(await receives(), false);
});
