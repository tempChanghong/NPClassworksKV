import {authorizationError} from "./academicAuthorizationService.js";

export async function lockClassroomScreenWrite(tx, binding) {
    // Hold this row until the business write commits. Disabling or rotating
    // the binding must either commit before this check, or wait for this write.
    const [current] = await tx.$queryRaw`SELECT "id", "isActive", "tokenHash", "credentialVersion", "administrativeClassId"
        FROM "ClassroomScreenBinding" WHERE "id" = ${binding.id} FOR SHARE`;
    if (!current?.isActive || !binding.tokenHash || current.tokenHash !== binding.tokenHash
        || current.credentialVersion !== binding.credentialVersion
        || current.administrativeClassId !== binding.administrativeClassId) {
        throw authorizationError("大屏绑定已失效，请联系管理员重新绑定", "SCREEN_TOKEN_INVALID", 401);
    }
}

