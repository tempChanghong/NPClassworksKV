import {jwtAuth} from "../middleware/jwt-auth.js";
import {prisma} from "../utils/prisma.js";
import {assertCanReadPublication, getReadableWorkspaceIds, loadPublicationWorkspaces, publicationWorkspaceInclude} from "./publicationAuthorizationService.js";
import {authenticateClassroomScreen, isClassroomScreenWorkspaceAllowed} from "./classroomScreenService.js";

export function socketCredentials(value) {
    const limited = token => typeof token === "string" && token.length <= 8192 ? token : "";
    return {accessToken: limited(value?.accessToken), screenToken: limited(value?.screenToken)};
}

async function currentAccount(token) {
    if (!token) return null;
    const response = {locals: {}, set() {}};
    let failure;
    await jwtAuth({headers: {authorization: `Bearer ${token}`}}, response, error => {failure = error;});
    return failure ? null : response.locals.account;
}

// Recheck authorization for each delivery, including expiry, logout and membership changes.
export async function canReceiveWorkspaceEvent(credentials, workspaceIds, type, content) {
    try {
        if (!credentials.accessToken && !credentials.screenToken) return false;
        const publication = type.startsWith("publication.") && content?.publicationId
            ? await prisma.publication.findUnique({where: {id: content.publicationId},
                include: {targets: {include: {workspace: {include: publicationWorkspaceInclude}}}}}) : null;
        if (type.startsWith("publication.") && (!publication || publication.revision !== content.revision)) return false;
        const account = await currentAccount(credentials.accessToken);
        if (account) {
            if (publication) {await assertCanReadPublication(account.id, publication); return true;}
            if ((await getReadableWorkspaceIds(account.id, workspaceIds)).length) return true;
        }
        if (credentials.screenToken) {
            const binding = await authenticateClassroomScreen(credentials.screenToken);
            if (publication && (publication.type !== "ASSIGNMENT" || publication.status !== "PUBLISHED")) return false;
            const workspaces = await loadPublicationWorkspaces(publication
                ? publication.targets.map(target => target.workspaceId) : workspaceIds);
            return workspaces.some(workspace => isClassroomScreenWorkspaceAllowed(binding, workspace));
        }
    } catch {return false;}
    return false;
}
