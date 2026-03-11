const router = require('express').Router();
const pool = require('../config/database');
const authMiddleware = require('../middleware/authMiddleware');
const { requireAdminOrManager } = require('../middleware/roleMiddleware');
const { cacheGet, cacheSet, invalidateMetadataCache } = require('../lib/cache');
const { getPagination } = require('../lib/helpers');

router.get('/courses', async (req, res) => {
    try {
        const moduleId = req.query.module_id;
        const { pageSize, offset } = getPagination(req, { page: 1, pageSize: 500, maxPageSize: 1000 });
        const shouldPaginate = req.query.page !== undefined || req.query.page_size !== undefined || req.query.limit !== undefined;

        let query = 'SELECT id, name, module_id FROM courses';
        const params = [];

        if (moduleId) {
            query += ' WHERE module_id = $1';
            params.push(moduleId);
        }

        query += ' ORDER BY name';
        if (shouldPaginate) {
            query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
            params.push(pageSize, offset);
        }

        if (!shouldPaginate) {
            const cacheKey = moduleId ? `courses:module:${moduleId}` : 'courses:all';
            const cached = cacheGet(cacheKey);
            if (cached) {
                res.set('Cache-Control', 'public, max-age=30');
                return res.json(cached);
            }
            const result = await pool.query(query, params);
            cacheSet(cacheKey, result.rows);
            res.set('Cache-Control', 'public, max-age=30');
            return res.json(result.rows);
        }

        const result = await pool.query(query, params);
        return res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/courses', authMiddleware, requireAdminOrManager, async (req, res) => {
    try {
        const { name, module_id } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Course name required' });
        }

        const result = await pool.query(
            'INSERT INTO courses (name, module_id) VALUES ($1, $2) RETURNING *',
            [name.trim(), module_id || null]
        );
        invalidateMetadataCache();
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/courses/:id', authMiddleware, requireAdminOrManager, async (req, res) => {
    try {
        const courseId = Number(req.params.id);
        if (!Number.isInteger(courseId) || courseId <= 0) {
            return res.status(400).json({ message: 'Invalid course id' });
        }

        const usage = await pool.query(
            'SELECT COUNT(*)::int AS total FROM questions WHERE course_id = $1',
            [courseId]
        );
        const usedCount = Number(usage.rows[0]?.total || 0);
        if (usedCount > 0) {
            return res.status(409).json({
                message: `Impossible de supprimer: ce cours est utilisé dans ${usedCount} question(s).`
            });
        }

        const result = await pool.query(
            'DELETE FROM courses WHERE id = $1 RETURNING id, name',
            [courseId]
        );
        if (!result.rows.length) {
            return res.status(404).json({ message: 'Course not found' });
        }
        invalidateMetadataCache();
        res.json({ deleted: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
