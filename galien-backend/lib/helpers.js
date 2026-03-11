function parseCsv(value) {
    return String(value || '')
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
}

function parseEmailList(value) {
    return String(value || '')
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
}

function toIntOrNull(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
}

function toTimestampOrNull(v) {
    if (v === undefined || v === null || v === '') return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
}

function parseIntList(v) {
    return String(v || '')
        .split(',')
        .map(x => String(x).trim())
        .filter(x => x !== '')
        .map(x => Number(x))
        .filter(n => Number.isInteger(n) && n > 0);
}

function toPositiveInt(value, fallback) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) return fallback;
    return n;
}

function getPagination(req, defaults = { page: 1, pageSize: 50, maxPageSize: 200 }) {
    const page = toPositiveInt(req.query.page, defaults.page);
    const pageSizeRaw = toPositiveInt(req.query.page_size || req.query.limit, defaults.pageSize);
    const pageSize = Math.min(pageSizeRaw, defaults.maxPageSize);
    const offset = (page - 1) * pageSize;
    return { page, pageSize, offset };
}

function parseGuidedBlocks(rawValue) {
    if (!rawValue) return [];
    try {
        const raw = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
        if (!Array.isArray(raw)) return [];
        return raw
            .map((b) => ({
                moduleId: toIntOrNull(b?.moduleId || b?.module_id),
                courseIds: parseIntList(Array.isArray(b?.courseIds) ? b.courseIds.join(',') : (Array.isArray(b?.course_ids) ? b.course_ids.join(',') : '')),
                sourceIds: parseIntList(Array.isArray(b?.sourceIds) ? b.sourceIds.join(',') : (Array.isArray(b?.source_ids) ? b.source_ids.join(',') : ''))
            }))
            .filter((b) => Number.isInteger(b.moduleId) && b.moduleId > 0);
    } catch (_) {
        return [];
    }
}

function pushGuidedBlocksFilter({ filters, params, tableAlias, guidedBlocks }) {
    if (!Array.isArray(guidedBlocks) || !guidedBlocks.length) return;
    const orClauses = [];
    guidedBlocks.forEach((b) => {
        const andClauses = [];
        andClauses.push(`${tableAlias}.module_id = $${params.length + 1}`);
        params.push(b.moduleId);
        if (Array.isArray(b.courseIds) && b.courseIds.length) {
            andClauses.push(`${tableAlias}.course_id = ANY($${params.length + 1}::int[])`);
            params.push(b.courseIds);
        }
        if (Array.isArray(b.sourceIds) && b.sourceIds.length) {
            andClauses.push(`${tableAlias}.source_id = ANY($${params.length + 1}::int[])`);
            params.push(b.sourceIds);
        }
        orClauses.push(`(${andClauses.join(' AND ')})`);
    });
    if (orClauses.length) {
        filters.push(`(${orClauses.join(' OR ')})`);
    }
}

function emptyPendingStats() {
    return { pending: 0, approved: 0, rejected: 0, total: 0 };
}

module.exports = {
    parseCsv,
    parseEmailList,
    toIntOrNull,
    toTimestampOrNull,
    parseIntList,
    toPositiveInt,
    getPagination,
    parseGuidedBlocks,
    pushGuidedBlocksFilter,
    emptyPendingStats
};
