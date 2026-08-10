import {Router} from "express";
import errors from "../../utils/errors.js";
import {
    findCurrentTerm,
    getAdministrativeClassCourseOptions,
    listGrades,
    listSchools,
    listSubjects,
    listWorkspaces,
} from "../../services/academicCatalogService.js";
import {WORKSPACE_TYPES} from "../../domain/academicCatalog.js";

const router = Router();

router.get("/schools", errors.catchAsync(async (req, res) => {
    const schools = await listSchools();
    res.json(errors.createSuccessResponse(schools));
}));

router.get("/terms/current", errors.catchAsync(async (req, res, next) => {
    const {schoolId, schoolCode} = req.query;
    if (!schoolId && !schoolCode) {
        return next(errors.createError(400, "需要提供 schoolId 或 schoolCode", null, "SCHOOL_REQUIRED"));
    }

    const term = await findCurrentTerm({schoolId, schoolCode});
    if (!term) {
        return next(errors.createError(404, "未找到当前启用的学期", null, "ACTIVE_TERM_NOT_FOUND"));
    }
    return res.json(errors.createSuccessResponse(term));
}));

router.get("/grades", errors.catchAsync(async (req, res, next) => {
    const {termId} = req.query;
    if (!termId) {
        return next(errors.createError(400, "需要提供 termId", null, "TERM_REQUIRED"));
    }
    return res.json(errors.createSuccessResponse(await listGrades(termId)));
}));

router.get("/subjects", errors.catchAsync(async (req, res, next) => {
    const {schoolId} = req.query;
    if (!schoolId) {
        return next(errors.createError(400, "需要提供 schoolId", null, "SCHOOL_REQUIRED"));
    }
    return res.json(errors.createSuccessResponse(await listSubjects(schoolId)));
}));

router.get("/workspaces", errors.catchAsync(async (req, res, next) => {
    const {termId, gradeId, type} = req.query;
    if (!termId) {
        return next(errors.createError(400, "需要提供 termId", null, "TERM_REQUIRED"));
    }
    if (type && !Object.values(WORKSPACE_TYPES).includes(type)) {
        return next(errors.createError(400, "无效的教学空间类型", {type}, "INVALID_WORKSPACE_TYPE"));
    }
    const workspaces = await listWorkspaces({termId, gradeId, type});
    return res.json(errors.createSuccessResponse(workspaces));
}));

router.get(
    "/administrative-classes/:id/course-options",
    errors.catchAsync(async (req, res, next) => {
        try {
            const catalog = await getAdministrativeClassCourseOptions(req.params.id);
            if (!catalog) {
                return next(errors.createError(404, "行政班不存在", null, "ADMIN_CLASS_NOT_FOUND"));
            }
            return res.json(errors.createSuccessResponse(catalog));
        } catch (error) {
            if (error.code === "NOT_ADMINISTRATIVE_CLASS") {
                return next(errors.createError(400, error.message, null, error.code));
            }
            throw error;
        }
    }),
);

export default router;
