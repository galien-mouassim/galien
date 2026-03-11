const router = require('express').Router();
const pool = require('../config/database');
const authMiddleware = require('../middleware/authMiddleware');
const { requireAdminOrManager } = require('../middleware/roleMiddleware');
const { cacheGet, cacheSet, invalidateMetadataCache } = require('../lib/cache');
const { parseIntList } = require('../lib/helpers');

router.get('/sources', async (req, res) => {
    try {
        const moduleIds = parseIntList(req.query.module_id || req.query.module);
        const cacheKey = moduleIds.length
            ? `sources:modules:${moduleIds.slice().sort((a, b) => a - b).join(',')}`
            : 'sources:all';
        const cached = cacheGet(cacheKey);
        if (cached) {
            res.set('Cache-Control', 'public, max-age=30');
            return res.json(cached);
        }

        let result;
        if (moduleIds.length) {
            result = await pool.query(
                `SELECT s.id, s.name
                 FROM sources s
                 JOIN module_sources ms ON ms.source_id = s.id
                 WHERE ms.module_id = ANY($1::int[])
                 GROUP BY s.id, s.name
                 ORDER BY s.name`,
                [moduleIds]
            );
        } else {
            result = await pool.query(
                'SELECT id, name FROM sources ORDER BY name'
            );
        }
        cacheSet(cacheKey, result.rows);
        res.set('Cache-Control', 'public, max-age=30');
        return res.json(result.rows);
    } catch (err) {
        const msg = err?.message || String(err) || 'Failed to load sources';
        console.error('[SOURCES_ERROR]', msg, err?.code || '');
        res.status(500).json({ error: msg });
    }
});

router.post('/sources', authMiddleware, requireAdminOrManager, async (req, res) => {
    try {
        const { name, module_id } = req.body || {};
        if (!name || !String(name).trim()) {
            return res.status(400).json({ message: 'Source name required' });
        }
        const result = await pool.query(
            `INSERT INTO sources (name)
             VALUES ($1)
             ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
             RETURNING id, name`,
            [String(name).trim()]
        );
        const source = result.rows[0];
        const moduleIds = parseIntList(module_id);
        if (moduleIds.length) {
            for (const mid of moduleIds) {
                await pool.query(
                    `INSERT INTO module_sources (module_id, source_id)
                     VALUES ($1, $2)
                     ON CONFLICT (module_id, source_id) DO NOTHING`,
                    [mid, source.id]
                );
            }
        }
        invalidateMetadataCache();
        res.json(source);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/sources/:id', authMiddleware, requireAdminOrManager, async (req, res) => {
    try {
        const sourceId = Number(req.params.id);
        if (!Number.isInteger(sourceId) || sourceId <= 0) {
            return res.status(400).json({ message: 'Invalid source id' });
        }

        const usage = await pool.query(
            'SELECT COUNT(*)::int AS total FROM questions WHERE source_id = $1',
            [sourceId]
        );
        const usedCount = Number(usage.rows[0]?.total || 0);
        if (usedCount > 0) {
            return res.status(409).json({
                message: `Impossible de supprimer: cette source est utilisée dans ${usedCount} question(s).`
            });
        }

        const result = await pool.query(
            'DELETE FROM sources WHERE id = $1 RETURNING id, name',
            [sourceId]
        );
        if (!result.rows.length) {
            return res.status(404).json({ message: 'Source not found' });
        }
        invalidateMetadataCache();
        res.json({ deleted: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
