import {Router} from "express";
import {jwtAuth} from "../../middleware/jwt-auth.js";
import errors from "../../utils/errors.js";
import {listMyWorkspaces} from "../../services/workspaceMembershipService.js";
import {listMySchools} from "../../services/schoolMembershipService.js";

const router = Router();

router.use(jwtAuth);

// 这些响应描述当前账号的实时权限，禁止浏览器、反向代理和共享缓存
// 保存；跨域前后端部署时尤其不能让不同账号复用同一份权限上下文。
router.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    res.vary("Authorization");
    next();
});

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
