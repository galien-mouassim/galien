const router = require('express').Router();
const pool = require('../config/database');
const { requireAdminOrManager } = require('../middleware/roleMiddleware');
const { cacheGet, cacheSet, invalidateMetadataCache } = require('../lib/cache');

router.get('/modules', async (req, res) => {
    try {
        const cacheKey = 'modules:all';
        const cached = cacheKey ? cacheGet(cacheKey) : null;
        if (cached) {
            res.set('Cache-Control', 'public, max-age=30');
            return res.json(cached);
        }

        const result = await pool.query('SELECT id, name, module_class FROM modules ORDER BY name');
        cacheSet(cacheKey, result.rows);
        res.set('Cache-Control', 'public, max-age=30');
        return res.json(result.rows);
    } catch (err) {
        const msg = err?.message || String(err) || 'Failed to load modules';
        console.error('[MODULES_ERROR]', msg, err?.code || '');
        res.status(500).json({ error: msg });
    }
});

router.post('/modules', requireAdminOrManager, async (req, res) => {
    try {
        const { name } = req.body || {};
        if (!name || !String(name).trim()) {
            return res.status(400).json({ message: 'Module name required' });
        }
        const result = await pool.query(
            `INSERT INTO modules (name)
             VALUES ($1)
             RETURNING id, name`,
            [String(name).trim()]
        );
        invalidateMetadataCache();
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
