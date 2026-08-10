import {Router} from "express";
import {jwtAuth} from "../../middleware/jwt-auth.js";
import errors from "../../utils/errors.js";
import {listMyWorkspaces} from "../../services/workspaceMembershipService.js";
import {listMySchools} from "../../services/schoolMembershipService.js";

const router = Router();

router.use(jwtAuth);

router.get("/schools", errors.catchAsync(async (req, res) => {
    const schools = await listMySchools(res.locals.account.id);
    return res.json(errors.createSuccessResponse(schools));
}));

router.get("/workspaces", errors.catchAsync(async (req, res) => {
    const workspaces = await listMyWorkspaces({
        accountId: res.locals.account.id,
        termId: req.query.termId,
    });
    return res.json(errors.createSuccessResponse(workspaces));
}));

export default router;
