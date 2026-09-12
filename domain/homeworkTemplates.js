export function templateError(message, statusCode = 422) {
    return Object.assign(new Error(message), {statusCode, code: "HOMEWORK_TEMPLATE_ERROR"});
}

export function validateHomeworkTemplate(input) {
    const result = {};
    for (const [key, max] of [["name", 60], ["title", 191], ["content", 6000]]) {
        if (typeof input?.[key] !== "string" || input[key].length > max) throw templateError(`模板${key}格式不正确或过长`);
        result[key] = input[key].trim();
    }
    if (!result.name || (!result.title && !result.content)) throw templateError("请填写模板名称及标题或正文");
    const text = `${result.title}\n${result.content}`;
    const fields = [...text.matchAll(/〔([^〔〕\n]{1,32})〕/gu)].map(match => match[1]);
    if (/[〔〕]/u.test(text.replace(/〔([^〔〕\n]{1,32})〕/gu, "")) || fields.some(field => !field.trim()) || new Set(fields).size > 10) {
        throw templateError("填空项请写成〔页码〕，每个名称不超过32字，最多10项");
    }
    return result;
}
