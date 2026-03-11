const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const { requireAdmin, requireAdminOrManager } = require('../middleware/roleMiddleware');
const { getPagination, parseIntList, toTimestampOrNull, emptyPendingStats } = require('../lib/helpers');
const { getLoginAlertConfigIssue, buildLoginAlertTransport, getLoginAlertRecipients, getAppSettingBoolean } = require('../lib/notifications');
const { ensurePendingQuestionsSchema, ensureAppSettingsSchema } = require('../lib/schema');
const { invalidateMetadataCache } = require('../lib/cache');

// ----------------------
// ADMIN: Users management
// ----------------------
router.get('/admin/users', async (req, res) => {
    try {
        if (!['admin', 'manager'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Forbidden' });
        }
        const { pageSize, offset } = getPagination(req, { page: 1, pageSize: 200, maxPageSize: 500 });
        const isManager = req.user.role === 'manager';
        let result;
        try {
            if (isManager) {
                result = await pool.query(
                    `SELECT id, email, display_name, role, is_active, active_until
                     FROM users
                     WHERE role NOT IN ('admin', 'manager')
                     ORDER BY email
                     LIMIT $1 OFFSET $2`,
                    [pageSize, offset]
                );
            } else {
                result = await pool.query(
                    `SELECT id, email, display_name, role, is_active, active_until
                     FROM users
                     ORDER BY email
                     LIMIT $1 OFFSET $2`,
                    [pageSize, offset]
                );
            }
        } catch (err) {
            // Backward compatibility for older DB schemas.
            if (err && err.code === '42703') {
                const legacy = isManager
                    ? await pool.query(
                        `SELECT id, email, display_name, role
                         FROM users
                         WHERE role NOT IN ('admin', 'manager')
                         ORDER BY email
                         LIMIT $1 OFFSET $2`,
                        [pageSize, offset]
                    )
                    : await pool.query(
                        `SELECT id, email, display_name, role
                         FROM users
                         ORDER BY email
                         LIMIT $1 OFFSET $2`,
                        [pageSize, offset]
                    );
                result = {
                    rows: (legacy.rows || []).map((r) => ({
                        ...r,
                        is_active: true,
                        active_until: null
                    }))
                };
            } else {
                throw err;
            }
        }
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/admin/users', requireAdminOrManager, async (req, res) => {
    try {
        const email = String(req.body?.email || '').trim().toLowerCase();
        const password = String(req.body?.password || '');
        const displayName = String(req.body?.display_name || '').trim() || null;
        const roleRaw = String(req.body?.role || 'user').trim().toLowerCase();
        const allowedRoles = req.user.role === 'admin'
            ? ['admin', 'manager', 'worker', 'user']
            : ['worker', 'user'];
        const role = allowedRoles.includes(roleRaw) ? roleRaw : 'user';
        const activeUntil = req.body?.active_until ? toTimestampOrNull(req.body.active_until) : null;

        if (req.body?.active_until && !activeUntil) {
            return res.status(400).json({ message: 'active_until invalid datetime' });
        }

        if (!email || !password) {
            return res.status(400).json({ message: 'email and password are required' });
        }

        const hash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            `INSERT INTO users (email, password, role, display_name, is_active, active_until)
             VALUES ($1, $2, $3, $4, TRUE, $5)
             RETURNING id, email, display_name, role, is_active, active_until`,
            [email, hash, role, displayName, activeUntil]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ message: 'email already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

router.put('/admin/users/:id', requireAdminOrManager, async (req, res) => {
    try {
        const targetId = Number(req.params.id);
        if (!Number.isInteger(targetId) || targetId <= 0) {
            return res.status(400).json({ message: 'invalid user id' });
        }

        const current = await pool.query('SELECT id, role FROM users WHERE id = $1', [targetId]);
        if (!current.rows.length) return res.status(404).json({ message: 'user not found' });
        const targetRole = current.rows[0].role;
        const isManager = req.user.role === 'manager';
        if (isManager && (targetRole === 'admin' || targetRole === 'manager')) {
            return res.status(403).json({ message: 'forbidden for this account' });
        }

        const updates = [];
        const params = [];

        if (req.body.email !== undefined) {
            const email = String(req.body.email || '').trim().toLowerCase();
            if (!email) return res.status(400).json({ message: 'email cannot be empty' });
            params.push(email);
            updates.push(`email = $${params.length}`);
        }

        if (req.body.display_name !== undefined) {
            const displayName = String(req.body.display_name || '').trim() || null;
            params.push(displayName);
            updates.push(`display_name = $${params.length}`);
        }

        if (req.body.role !== undefined) {
            const requestedRole = String(req.body.role || '').trim().toLowerCase();
            const allowedRoles = req.user.role === 'admin'
                ? ['admin', 'manager', 'worker', 'user']
                : ['worker', 'user'];
            const role = allowedRoles.includes(requestedRole) ? requestedRole : 'user';
            if (req.user.id === targetId && role !== 'admin') {
                return res.status(400).json({ message: 'you cannot remove your own admin role' });
            }
            params.push(role);
            updates.push(`role = $${params.length}`);
        }

        if (req.body.is_active !== undefined) {
            const isActive = !!req.body.is_active;
            if (isManager && targetRole === 'admin') {
                return res.status(403).json({ message: 'forbidden for this account' });
            }
            if (req.user.id === targetId && !isActive) {
                return res.status(400).json({ message: 'you cannot deactivate your own account' });
            }
            params.push(isActive);
            updates.push(`is_active = $${params.length}`);
        }

        if (req.body.active_until !== undefined) {
            if (req.body.active_until === null || req.body.active_until === '') {
                updates.push('active_until = NULL');
            } else {
                const activeUntil = toTimestampOrNull(req.body.active_until);
                if (!activeUntil) {
                    return res.status(400).json({ message: 'active_until invalid datetime' });
                }
                params.push(activeUntil);
                updates.push(`active_until = $${params.length}`);
            }
        }

        if (req.body.password !== undefined) {
            const plain = String(req.body.password || '');
            if (plain.length < 4) {
                return res.status(400).json({ message: 'password must have at least 4 characters' });
            }
            const hash = await bcrypt.hash(plain, 10);
            params.push(hash);
            updates.push(`password = $${params.length}`);
        }

        if (!updates.length) {
            return res.status(400).json({ message: 'no changes provided' });
        }

        params.push(targetId);
        const result = await pool.query(
            `UPDATE users
             SET ${updates.join(', ')}
             WHERE id = $${params.length}
             RETURNING id, email, display_name, role, is_active, active_until`,
            params
        );
        res.json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ message: 'email already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

router.delete('/admin/users/:id', requireAdmin, async (req, res) => {
    try {
        const targetId = Number(req.params.id);
        if (!Number.isInteger(targetId) || targetId <= 0) {
            return res.status(400).json({ message: 'invalid user id' });
        }
        if (req.user.id === targetId) {
            return res.status(400).json({ message: 'you cannot delete your own account' });
        }

        const result = await pool.query(
            'DELETE FROM users WHERE id = $1 RETURNING id, email, role',
            [targetId]
        );
        if (!result.rows.length) return res.status(404).json({ message: 'user not found' });
        res.json({ deleted: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// ADMIN: Send message
// ----------------------
router.post('/admin/messages', async (req, res) => {
    try {
        if (!['admin', 'manager'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Forbidden' });
        }
        const { recipient_id, body } = req.body;
        if (!recipient_id || !body || !body.trim()) {
            return res.status(400).json({ message: 'recipient_id and body required' });
        }
        const result = await pool.query(
            `INSERT INTO user_messages (sender_id, recipient_id, body)
             VALUES ($1, $2, $3)
             RETURNING id, body, created_at`,
            [req.user.id, recipient_id, body.trim()]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// ADMIN: Login alert settings
// ----------------------
router.post('/admin/test-login-alert', requireAdmin, async (req, res) => {
    try {
        const issue = getLoginAlertConfigIssue();
        if (issue) {
            return res.status(400).json({ ok: false, message: issue });
        }

        const transporter = buildLoginAlertTransport();
        if (!transporter) {
            return res.status(500).json({ ok: false, message: 'SMTP transport init failed' });
        }

        const to = getLoginAlertRecipients();
        const from = process.env.SMTP_FROM || process.env.SMTP_USER;
        await transporter.sendMail({
            from,
            to: to.join(','),
            subject: '[Galien] Test login alert',
            text: `Test email from Galien at ${new Date().toISOString()}`
        });

        return res.json({ ok: true, sent_to: to });
    } catch (err) {
        return res.status(500).json({ ok: false, message: err.message });
    }
});

router.get('/admin/login-alert-settings', requireAdmin, async (req, res) => {
    try {
        await ensureAppSettingsSchema();
        const enabled = await getAppSettingBoolean('non_admin_login_alert_enabled', true);
        res.json({ enabled });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/admin/login-alert-settings', requireAdmin, async (req, res) => {
    try {
        const enabled = !!req.body?.enabled;
        await ensureAppSettingsSchema();
        await pool.query(
            `INSERT INTO app_settings (key, value)
             VALUES ('non_admin_login_alert_enabled', $1)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [enabled ? 'true' : 'false']
        );
        res.json({ enabled });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// ADMIN: Pending questions
// ----------------------
router.get('/admin/pending-questions', requireAdminOrManager, async (req, res) => {
    try {
        await ensurePendingQuestionsSchema();
        const status = String(req.query.status || 'pending').trim().toLowerCase();
        const pageCfg = getPagination(req, { page: 1, pageSize: 25, maxPageSize: 100 });
        const validStatus = ['pending', 'approved', 'rejected'].includes(status) ? status : 'pending';
        const moduleIds = parseIntList(req.query.module);
        const courseIds = parseIntList(req.query.course);
        const sourceIds = parseIntList(req.query.source);
        const filters = ['pq.status = $1'];
        const params = [validStatus];
        if (moduleIds.length) {
            params.push(moduleIds);
            filters.push(`pq.module_id = ANY($${params.length}::int[])`);
        }
        if (courseIds.length) {
            params.push(courseIds);
            filters.push(`pq.course_id = ANY($${params.length}::int[])`);
        }
        if (sourceIds.length) {
            params.push(sourceIds);
            filters.push(`pq.source_id = ANY($${params.length}::int[])`);
        }
        const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

        const [rowsRes, countRes] = await Promise.all([
            pool.query(
                `SELECT pq.*,
                        m.name AS module_name,
                        c.name AS course_name,
                        s.name AS source_name,
                        u.email AS submitted_by_email
                 FROM pending_questions pq
                 LEFT JOIN modules m ON m.id = pq.module_id
                 LEFT JOIN courses c ON c.id = pq.course_id
                 LEFT JOIN sources s ON s.id = pq.source_id
                 LEFT JOIN users u ON u.id = pq.submitted_by
                 ${where}
                 ORDER BY pq.created_at DESC
                 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
                [...params, pageCfg.pageSize, pageCfg.offset]
            ),
            pool.query(
                `SELECT COUNT(*)::int AS total FROM pending_questions pq ${where}`,
                params
            )
        ]);

        res.json({
            data: rowsRes.rows,
            pagination: {
                page: pageCfg.page,
                page_size: pageCfg.pageSize,
                total: Number(countRes.rows[0]?.total || 0)
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/admin/pending-questions/stats', requireAdminOrManager, async (req, res) => {
    try {
        await ensurePendingQuestionsSchema();

        const role = String(req.query.role || 'worker').trim().toLowerCase();
        const roleFilter = ['worker', 'admin', 'manager'].includes(role) ? role : 'worker';

        const q = await pool.query(
            `SELECT
                u.id AS user_id,
                u.email,
                u.display_name,
                u.role,
                COALESCE(COUNT(pq.id) FILTER (WHERE pq.status = 'pending'), 0)::int AS pending,
                COALESCE(COUNT(pq.id) FILTER (WHERE pq.status = 'approved'), 0)::int AS approved,
                COALESCE(COUNT(pq.id) FILTER (WHERE pq.status = 'rejected'), 0)::int AS rejected,
                COALESCE(COUNT(pq.id), 0)::int AS total,
                MAX(pq.created_at) AS last_submitted_at
             FROM users u
             LEFT JOIN pending_questions pq ON pq.submitted_by = u.id
             WHERE u.role = $1
             GROUP BY u.id, u.email, u.display_name, u.role
             ORDER BY total DESC, last_submitted_at DESC NULLS LAST, u.email ASC`,
            [roleFilter]
        );

        const totals = emptyPendingStats();
        q.rows.forEach((r) => {
            totals.pending += Number(r.pending || 0);
            totals.approved += Number(r.approved || 0);
            totals.rejected += Number(r.rejected || 0);
        });
        totals.total = totals.pending + totals.approved + totals.rejected;

        return res.json({ role: roleFilter, totals, by_user: q.rows });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.post('/admin/pending-questions/:id/approve', requireAdminOrManager, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid id' });

    const client = await pool.connect();
    try {
        await ensurePendingQuestionsSchema();
        await client.query('BEGIN');
        const qRes = await client.query(
            'SELECT * FROM pending_questions WHERE id = $1 AND status = $2 FOR UPDATE',
            [id, 'pending']
        );
        if (!qRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Pending question not found' });
        }
        const pq = qRes.rows[0];
        const inserted = await client.query(
            `INSERT INTO questions
             (question, option_a, option_b, option_c, option_d, option_e, correct_options, module_id, course_id, source_id, explanation)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             RETURNING *`,
            [pq.question, pq.option_a, pq.option_b, pq.option_c, pq.option_d, pq.option_e, pq.correct_options, pq.module_id, pq.course_id, pq.source_id, pq.explanation]
        );

        if (pq.module_id && pq.source_id) {
            await client.query(
                `INSERT INTO module_sources (module_id, source_id)
                 VALUES ($1, $2)
                 ON CONFLICT (module_id, source_id) DO NOTHING`,
                [pq.module_id, pq.source_id]
            );
        }

        await client.query(
            `UPDATE pending_questions
             SET status = 'approved', admin_id = $1, reviewed_at = NOW()
             WHERE id = $2`,
            [req.user.id, id]
        );
        await client.query('COMMIT');
        invalidateMetadataCache();
        res.json({ message: 'Question approuvée', question: inserted.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

router.post('/admin/pending-questions/:id/reject', requireAdminOrManager, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid id' });
    try {
        await ensurePendingQuestionsSchema();
        const result = await pool.query(
            `UPDATE pending_questions
             SET status = 'rejected', admin_id = $1, reviewed_at = NOW()
             WHERE id = $2 AND status = 'pending'
             RETURNING id`,
            [req.user.id, id]
        );
        if (!result.rows.length) return res.status(404).json({ message: 'Pending question not found' });
        res.json({ message: 'Question rejetée' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// ADMIN: Reports
// ----------------------
router.get('/admin/reports', async (req, res) => {
    try {
        if (!['admin', 'manager'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Forbidden' });
        }
        const showResolved = req.query.resolved === '1';
        const { pageSize, offset } = getPagination(req, { page: 1, pageSize: 100, maxPageSize: 200 });
        const result = await pool.query(
            `SELECT r.id, r.reason, r.created_at, r.resolved, r.resolved_at,
                    u.email AS user_email,
                    q.id AS question_id, q.question,
                    ru.email AS resolved_by_email
             FROM question_reports r
             LEFT JOIN users u ON u.id = r.user_id
             JOIN questions q ON q.id = r.question_id
             LEFT JOIN users ru ON ru.id = r.resolved_by
             WHERE r.resolved = $1
             ORDER BY r.created_at DESC
             LIMIT $2 OFFSET $3`,
            [showResolved, pageSize, offset]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/admin/reports/:id/resolve', async (req, res) => {
    try {
        if (!['admin', 'manager'].includes(req.user.role)) return res.status(403).json({ message: 'Forbidden' });
        const reportId = Number.parseInt(req.params.id, 10);
        if (!Number.isInteger(reportId) || reportId <= 0) {
            return res.status(400).json({ message: 'Invalid report id' });
        }
        const { resolved } = req.body || {};
        const resolvedFlag = !!resolved;
        const adminId = Number.parseInt(String(req.user.id), 10);
        if (!Number.isInteger(adminId) || adminId <= 0) {
            return res.status(401).json({ message: 'Invalid admin session' });
        }
        const result = await pool.query(
            `UPDATE question_reports
             SET resolved = $1::boolean,
                 resolved_at = CASE WHEN $1::boolean THEN NOW() ELSE NULL END,
                 resolved_by = CASE WHEN $1::boolean THEN $2::int ELSE NULL END
             WHERE id = $3::int
             RETURNING *`,
            [resolvedFlag, adminId, reportId]
        );
        if (!result.rows.length) return res.status(404).json({ message: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Report resolve error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
