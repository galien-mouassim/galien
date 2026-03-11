const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const requireActive = require('../middleware/requireActive');
const { upload, saveProfilePhoto, sanitizeProfilePhotoForResponse } = require('../lib/upload');
const { getPagination, parseIntList, emptyPendingStats } = require('../lib/helpers');
const { cacheGet, cacheSet, invalidateUserAnalyticsCache, USER_ANALYTICS_CACHE_TTL_MS } = require('../lib/cache');
const { ensureResultsSavedSchema, ensurePendingQuestionsSchema } = require('../lib/schema');

// ----------------------
// USER: Profile
// ----------------------
router.get('/users/me', async (req, res) => {
    try {
        let result;
        try {
            result = await pool.query(
                'SELECT id, email, role, display_name, profile_photo, active_until, is_active FROM users WHERE id = $1',
                [req.user.id]
            );
        } catch (err) {
            if (err && err.code === '42703') {
                const legacy = await pool.query(
                    'SELECT id, email, role, display_name, profile_photo FROM users WHERE id = $1',
                    [req.user.id]
                );
                result = {
                    rows: (legacy.rows || []).map((r) => ({ ...r, active_until: null, is_active: true }))
                };
            } else {
                throw err;
            }
        }
        if (!result.rows.length) return res.status(404).json({ message: 'User not found' });
        const row = result.rows[0];
        row.profile_photo = sanitizeProfilePhotoForResponse(row.profile_photo);
        row.is_active = row.is_active !== false;
        res.json(row);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/users/me', async (req, res) => {
    try {
        const { display_name } = req.body;
        let result;
        try {
            result = await pool.query(
                'UPDATE users SET display_name = $1 WHERE id = $2 RETURNING id, email, role, display_name, profile_photo, active_until',
                [display_name || null, req.user.id]
            );
        } catch (err) {
            if (err && err.code === '42703') {
                const legacy = await pool.query(
                    'UPDATE users SET display_name = $1 WHERE id = $2 RETURNING id, email, role, display_name, profile_photo',
                    [display_name || null, req.user.id]
                );
                result = {
                    rows: (legacy.rows || []).map((r) => ({ ...r, active_until: null }))
                };
            } else {
                throw err;
            }
        }
        if (!result.rows.length) return res.status(404).json({ message: 'User not found' });
        const row = result.rows[0];
        row.profile_photo = sanitizeProfilePhotoForResponse(row.profile_photo);
        res.json(row);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/users/password', async (req, res) => {
    try {
        const { current_password, new_password } = req.body || {};
        if (!current_password || !new_password) return res.status(400).json({ message: 'Champs requis' });
        if (new_password.length < 6) return res.status(400).json({ message: 'Le nouveau mot de passe doit faire au moins 6 caractères' });
        const result = await pool.query('SELECT password FROM users WHERE id = $1', [req.user.id]);
        if (!result.rows.length) return res.status(404).json({ message: 'Utilisateur non trouvé' });
        const valid = await bcrypt.compare(current_password, result.rows[0].password);
        if (!valid) return res.status(400).json({ message: 'Mot de passe actuel incorrect' });
        const hashed = await bcrypt.hash(new_password, 10);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, req.user.id]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/users/me/photo', upload.single('photo'), async (req, res) => {
    try {
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const photoUrl = await saveProfilePhoto(req.file.buffer, req.user.id);
        const result = await pool.query(
            'UPDATE users SET profile_photo = $1 WHERE id = $2 RETURNING profile_photo',
            [photoUrl, req.user.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Photo upload error:', err);
        res.status(500).json({ error: err.message || 'Photo upload failed' });
    }
});

// ----------------------
// USER: Preferences
// ----------------------
router.get('/users/preferences', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT default_exam_minutes, correction_system,
                    auto_next_enabled, auto_next_delay_sec,
                    show_explanation_auto, show_notes_inline,
                    theme_preference, question_limit, hide_question_meta
             FROM user_preferences
             WHERE user_id = $1`,
            [req.user.id]
        );
        res.json(result.rows[0] || {
            default_exam_minutes: null,
            correction_system: 'tout_ou_rien',
            auto_next_enabled: false,
            auto_next_delay_sec: 2,
            show_explanation_auto: true,
            show_notes_inline: false,
            theme_preference: 'system',
            question_limit: null,
            hide_question_meta: false
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/users/preferences', async (req, res) => {
    try {
        const {
            default_exam_minutes,
            correction_system,
            auto_next_enabled,
            auto_next_delay_sec,
            show_explanation_auto,
            show_notes_inline,
            theme_preference,
            question_limit,
            hide_question_meta
        } = req.body || {};

        const safeDelay = Number.isFinite(Number(auto_next_delay_sec))
            ? Math.min(60, Math.max(1, Number(auto_next_delay_sec)))
            : 2;
        const safeTheme = ['system', 'light', 'dark'].includes(String(theme_preference))
            ? String(theme_preference)
            : 'system';

        const result = await pool.query(
            `INSERT INTO user_preferences (
                 user_id, default_exam_minutes, correction_system,
                 auto_next_enabled, auto_next_delay_sec,
                 show_explanation_auto, show_notes_inline,
                 theme_preference, question_limit, hide_question_meta, updated_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
             ON CONFLICT (user_id)
             DO UPDATE SET default_exam_minutes = EXCLUDED.default_exam_minutes,
                           correction_system = EXCLUDED.correction_system,
                           auto_next_enabled = EXCLUDED.auto_next_enabled,
                           auto_next_delay_sec = EXCLUDED.auto_next_delay_sec,
                           show_explanation_auto = EXCLUDED.show_explanation_auto,
                           show_notes_inline = EXCLUDED.show_notes_inline,
                           theme_preference = EXCLUDED.theme_preference,
                           question_limit = EXCLUDED.question_limit,
                           hide_question_meta = EXCLUDED.hide_question_meta,
                           updated_at = NOW()
             RETURNING default_exam_minutes, correction_system,
                       auto_next_enabled, auto_next_delay_sec,
                       show_explanation_auto, show_notes_inline,
                       theme_preference, question_limit, hide_question_meta`,
            [
                req.user.id,
                default_exam_minutes || null,
                correction_system || 'tout_ou_rien',
                !!auto_next_enabled,
                safeDelay,
                show_explanation_auto !== false,
                !!show_notes_inline,
                safeTheme,
                Number.isFinite(Number(question_limit)) && Number(question_limit) > 0 ? Number(question_limit) : null,
                !!hide_question_meta
            ]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// USER: Results + Stats
// ----------------------
router.post('/results', requireActive, async (req, res) => {
    const client = await pool.connect();
    try {
        await ensureResultsSavedSchema();
        const { score, total, mode, elapsed_seconds, correction_system, time_limit_seconds, question_results, is_saved, session_name } = req.body;
        await client.query('BEGIN');
        const sessionRes = await client.query(
            `INSERT INTO results (user_id, score, total, mode, elapsed_seconds, correction_system, time_limit_seconds, is_saved, session_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [
                req.user.id,
                score,
                total,
                mode,
                elapsed_seconds || null,
                correction_system || null,
                time_limit_seconds || null,
                !!is_saved,
                (session_name || '').toString().trim() || null
            ]
        );
        const session = sessionRes.rows[0];

        if (Array.isArray(question_results) && question_results.length > 0) {
            for (const qr of question_results) {
                await client.query(
                    `INSERT INTO session_question_results
                     (session_id, question_id, question_num, question_text, user_answer, correct_answer, score, option_a, option_b, option_c, option_d, option_e, explanation)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                    [
                        session.id, qr.question_id || null, qr.question_num,
                        qr.question_text || null, qr.user_answer || null, qr.correct_answer || null,
                        qr.score || 0, qr.option_a || null, qr.option_b || null,
                        qr.option_c || null, qr.option_d || null, qr.option_e || null,
                        qr.explanation || null
                    ]
                );
            }
        }
        await client.query('COMMIT');
        invalidateUserAnalyticsCache(req.user.id);
        res.json(session);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

router.get('/results/:id/questions', async (req, res) => {
    try {
        const sessionId = req.params.id;
        const sessionCheck = await pool.query(
            `SELECT id FROM results WHERE id = $1 AND user_id = $2`,
            [sessionId, req.user.id]
        );
        if (!sessionCheck.rows.length) return res.status(403).json({ message: 'Forbidden' });
        const result = await pool.query(
            `SELECT * FROM session_question_results WHERE session_id = $1 ORDER BY question_num`,
            [sessionId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/results/:sessionId/question-history/:questionId', async (req, res) => {
    try {
        const sessionId = Number(req.params.sessionId);
        const questionId = Number(req.params.questionId);
        if (!Number.isInteger(sessionId) || !Number.isInteger(questionId)) {
            return res.status(400).json({ message: 'invalid params' });
        }

        const ownSession = await pool.query(
            `SELECT id FROM results WHERE id = $1 AND user_id = $2`,
            [sessionId, req.user.id]
        );
        if (!ownSession.rows.length) return res.status(403).json({ message: 'Forbidden' });

        const result = await pool.query(
            `SELECT sqr.user_answer, sqr.correct_answer, sqr.score, r.created_at, r.mode
             FROM session_question_results sqr
             JOIN results r ON r.id = sqr.session_id
             WHERE r.user_id = $1
               AND sqr.question_id = $2
               AND sqr.session_id <> $3
             ORDER BY r.created_at DESC
             LIMIT 5`,
            [req.user.id, questionId, sessionId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/users/results', async (req, res) => {
    try {
        await ensureResultsSavedSchema();
        const { pageSize, offset } = getPagination(req, { page: 1, pageSize: 20, maxPageSize: 100 });
        const savedFilter = String(req.query.saved || 'all').trim();
        const where = ['user_id = $1'];
        const params = [req.user.id];
        if (savedFilter === '1') {
            where.push(`is_saved = TRUE`);
        } else if (savedFilter === '0') {
            where.push(`COALESCE(is_saved, FALSE) = FALSE`);
        }
        params.push(pageSize, offset);
        const result = await pool.query(
            `SELECT id, score, total, mode, elapsed_seconds, correction_system, time_limit_seconds, is_saved, session_name, created_at
             FROM results
             WHERE ${where.join(' AND ')}
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            params
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.patch('/results/:id/meta', async (req, res) => {
    try {
        await ensureResultsSavedSchema();
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'invalid id' });
        const sessionName = (req.body?.session_name || '').toString().trim();
        const isSaved = req.body?.is_saved;
        const updates = [];
        const params = [];

        if (sessionName.length) {
            updates.push(`session_name = $${params.length + 1}`);
            params.push(sessionName.slice(0, 120));
        } else if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'session_name')) {
            updates.push(`session_name = NULL`);
        }
        if (typeof isSaved === 'boolean') {
            updates.push(`is_saved = $${params.length + 1}`);
            params.push(isSaved);
        }
        if (!updates.length) return res.status(400).json({ message: 'no updates provided' });

        params.push(id, req.user.id);
        const result = await pool.query(
            `UPDATE results
             SET ${updates.join(', ')}
             WHERE id = $${params.length - 1} AND user_id = $${params.length}
             RETURNING id, is_saved, session_name`,
            params
        );
        if (!result.rows.length) return res.status(404).json({ message: 'session not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/users/stats', async (req, res) => {
    try {
        const cacheKey = `user:stats:${req.user.id}`;
        const cached = cacheGet(cacheKey);
        if (cached) {
            res.set('Cache-Control', 'private, max-age=15');
            return res.json(cached);
        }

        const result = await pool.query(
            `SELECT
                COUNT(*)::int AS total_exams,
                AVG(CASE WHEN total > 0 THEN (score / total) * 100 ELSE NULL END) AS avg_percent,
                MAX(created_at) AS last_exam_at
             FROM results
             WHERE user_id = $1`,
            [req.user.id]
        );
        const payload = result.rows[0];
        cacheSet(cacheKey, payload, USER_ANALYTICS_CACHE_TTL_MS);
        res.set('Cache-Control', 'private, max-age=15');
        return res.json(payload);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/users/analytics', async (req, res) => {
    try {
        const userId = req.user.id;
        const moduleIds = parseIntList(req.query.module_id || req.query.module);
        const courseIds = parseIntList(req.query.course_id || req.query.course);
        const sourceIds = parseIntList(req.query.source_id || req.query.source);
        const hasScopedFilters = moduleIds.length || courseIds.length || sourceIds.length;
        const cacheKey = hasScopedFilters
            ? null
            : `user:analytics:${userId}`;
        const cached = cacheGet(cacheKey);
        if (cached) {
            res.set('Cache-Control', 'private, max-age=15');
            return res.json(cached);
        }
        const failFilters = [];
        const failParams = [userId];
        if (moduleIds.length) {
            failFilters.push(`q.module_id = ANY($${failParams.length + 1}::int[])`);
            failParams.push(moduleIds);
        }
        if (courseIds.length) {
            failFilters.push(`q.course_id = ANY($${failParams.length + 1}::int[])`);
            failParams.push(courseIds);
        }
        if (sourceIds.length) {
            failFilters.push(`q.source_id = ANY($${failParams.length + 1}::int[])`);
            failParams.push(sourceIds);
        }
        const failWhere = failFilters.length ? ` AND ${failFilters.join(' AND ')}` : '';

        const [
            sessionsRes,
            moduleScoresRes,
            courseScoresRes,
            questionsProgressRes,
            totalQuestionsRes,
            favoritesRes,
            mostFailedRes,
            timelineRes
        ] = await Promise.all([
            pool.query(
                `SELECT mode, created_at, COALESCE(elapsed_seconds, 0) AS elapsed_seconds,
                        score, total
                 FROM results
                 WHERE user_id = $1
                 ORDER BY created_at ASC`,
                [userId]
            ),
            pool.query(
                `SELECT q.module_id, COALESCE(m.name, 'Sans module') AS module_name,
                        ROUND(AVG(sqr.score) * 100.0, 2) AS avg_percent,
                        COUNT(*)::int AS attempts
                 FROM session_question_results sqr
                 JOIN results r ON r.id = sqr.session_id
                 LEFT JOIN questions q ON q.id = sqr.question_id
                 LEFT JOIN modules m ON m.id = q.module_id
                 WHERE r.user_id = $1 AND sqr.question_id IS NOT NULL
                 GROUP BY q.module_id, m.name
                 ORDER BY avg_percent DESC NULLS LAST`,
                [userId]
            ),
            pool.query(
                `SELECT q.module_id, q.course_id, COALESCE(c.name, 'Sans cours') AS course_name,
                        ROUND(AVG(sqr.score) * 100.0, 2) AS avg_percent,
                        COUNT(*)::int AS attempts
                 FROM session_question_results sqr
                 JOIN results r ON r.id = sqr.session_id
                 LEFT JOIN questions q ON q.id = sqr.question_id
                 LEFT JOIN courses c ON c.id = q.course_id
                 WHERE r.user_id = $1 AND sqr.question_id IS NOT NULL
                 GROUP BY q.module_id, q.course_id, c.name
                 ORDER BY avg_percent DESC NULLS LAST`,
                [userId]
            ),
            pool.query(
                `SELECT
                    COUNT(DISTINCT sqr.question_id)::int AS unique_questions_done,
                    COUNT(sqr.question_id)::int AS total_questions_done_with_duplicates
                 FROM session_question_results sqr
                 JOIN results r ON r.id = sqr.session_id
                 WHERE r.user_id = $1
                   AND sqr.question_id IS NOT NULL`,
                [userId]
            ),
            pool.query(`SELECT COUNT(*)::int AS total_questions FROM questions`),
            pool.query(
                `SELECT COUNT(*)::int AS favorites_count
                 FROM question_flags
                 WHERE user_id = $1 AND flag_type = 'favorite'`,
                [userId]
            ),
            pool.query(
                `SELECT q.id AS question_id, q.question,
                        q.module_id, q.course_id, q.source_id,
                        COALESCE(m.name, 'Sans module') AS module_name,
                        COALESCE(c.name, 'Sans cours') AS course_name,
                        COALESCE(s.name, 'Sans source') AS source_name,
                        q.option_a, q.option_b, q.option_c, q.option_d, q.option_e, q.correct_options, q.explanation,
                        COUNT(*)::int AS attempts,
                        SUM(CASE WHEN sqr.score < 1 THEN 1 ELSE 0 END)::int AS fail_count,
                        ROUND((SUM(CASE WHEN sqr.score < 1 THEN 1 ELSE 0 END)::numeric / COUNT(*)) * 100.0, 2) AS fail_rate_percent
                 FROM session_question_results sqr
                 JOIN results r ON r.id = sqr.session_id
                 JOIN questions q ON q.id = sqr.question_id
                 LEFT JOIN modules m ON m.id = q.module_id
                 LEFT JOIN courses c ON c.id = q.course_id
                 LEFT JOIN sources s ON s.id = q.source_id
                 WHERE r.user_id = $1
                 ${failWhere}
                 GROUP BY q.id, q.question, q.module_id, q.course_id, q.source_id, m.name, c.name, s.name,
                          q.option_a, q.option_b, q.option_c, q.option_d, q.option_e, q.correct_options, q.explanation
                 HAVING COUNT(*) >= 2
                 ORDER BY fail_rate_percent DESC, attempts DESC
                 LIMIT 10`,
                failParams
            ),
            pool.query(
                `SELECT DATE(created_at) AS day,
                        ROUND(AVG(CASE WHEN total > 0 THEN (score::numeric / total::numeric) * 100 ELSE NULL END), 2) AS avg_percent,
                        COUNT(*)::int AS sessions
                 FROM results
                 WHERE user_id = $1
                 GROUP BY DATE(created_at)
                 ORDER BY day ASC`,
                [userId]
            )
        ]);

        const sessions = sessionsRes.rows || [];

        const modeBuckets = { training: 0, exam: 0, other: 0 };
        let totalRevisionSeconds = 0;
        const distinctDaysAsc = [];
        let prevDay = '';
        sessions.forEach((s) => {
            const mode = String(s.mode || '').toLowerCase();
            if (mode.includes('train') || mode.includes('entrain')) modeBuckets.training += 1;
            else if (mode.includes('exam')) modeBuckets.exam += 1;
            else modeBuckets.other += 1;
            totalRevisionSeconds += Number(s.elapsed_seconds || 0);

            const day = new Date(s.created_at).toISOString().slice(0, 10);
            if (day !== prevDay) {
                distinctDaysAsc.push(day);
                prevDay = day;
            }
        });

        const streakDates = distinctDaysAsc
            .slice()
            .reverse()
            .map((d) => new Date(d));
        let streakDays = 0;
        if (streakDates.length) {
            let expected = new Date(streakDates[0]);
            expected.setHours(0, 0, 0, 0);
            for (const d of streakDates) {
                const current = new Date(d);
                current.setHours(0, 0, 0, 0);
                if (current.getTime() === expected.getTime()) {
                    streakDays += 1;
                    expected.setDate(expected.getDate() - 1);
                } else if (current.getTime() < expected.getTime()) {
                    break;
                }
            }
        }

        const courseRows = courseScoresRes.rows || [];
        const strongestCourse = courseRows.length ? courseRows[0] : null;
        const weakestCourse = courseRows.length ? courseRows[courseRows.length - 1] : null;

        const timeline = timelineRes.rows || [];
        const firstHalf = timeline.slice(0, Math.max(1, Math.floor(timeline.length / 2)));
        const secondHalf = timeline.slice(Math.floor(timeline.length / 2));
        const avg = (arr) => {
            if (!arr.length) return null;
            const sum = arr.reduce((acc, r) => acc + Number(r.avg_percent || 0), 0);
            return sum / arr.length;
        };
        const firstAvg = avg(firstHalf);
        const secondAvg = avg(secondHalf);
        const trendDelta = (firstAvg == null || secondAvg == null) ? null : Number((secondAvg - firstAvg).toFixed(2));

        const payload = {
            sessions: {
                total: sessions.length,
                training: modeBuckets.training,
                exam: modeBuckets.exam,
                other: modeBuckets.other
            },
            total_revision_seconds: totalRevisionSeconds,
            streak_days: streakDays,
            avg_score_by_module: moduleScoresRes.rows || [],
            avg_score_by_course: courseRows,
            strongest_course: strongestCourse,
            weakest_course: weakestCourse,
            questions_progress: {
                unique_done: Number(questionsProgressRes.rows[0]?.unique_questions_done || 0),
                done_with_duplicates: Number(questionsProgressRes.rows[0]?.total_questions_done_with_duplicates || 0),
                total_questions: Number(totalQuestionsRes.rows[0]?.total_questions || 0)
            },
            favorites_count: Number(favoritesRes.rows[0]?.favorites_count || 0),
            most_failed_questions_top10: mostFailedRes.rows || [],
            progression_timeline: {
                by_day: timeline,
                trend_delta_percent: trendDelta,
                improving: trendDelta == null ? null : trendDelta > 0
            }
        };

        if (cacheKey) {
            cacheSet(cacheKey, payload, USER_ANALYTICS_CACHE_TTL_MS);
        }
        res.set('Cache-Control', 'private, max-age=15');
        return res.json(payload);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// USER: Favorites / Flags
// ----------------------
router.post('/users/questions/:id/flag', async (req, res) => {
    try {
        const questionId = req.params.id;
        const { flag_type, tags } = req.body;
        if (!flag_type) return res.status(400).json({ message: 'flag_type required' });

        await pool.query(
            `INSERT INTO question_flags (user_id, question_id, flag_type, tags)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (user_id, question_id, flag_type)
              DO UPDATE SET tags = EXCLUDED.tags`,
            [req.user.id, questionId, flag_type, tags || null]
        );
        invalidateUserAnalyticsCache(req.user.id);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/users/questions/:id/flag', async (req, res) => {
    try {
        const questionId = req.params.id;
        const flagType = req.query.type;
        await pool.query(
            `DELETE FROM question_flags
             WHERE user_id = $1 AND question_id = $2 AND flag_type = $3`,
            [req.user.id, questionId, flagType]
        );
        invalidateUserAnalyticsCache(req.user.id);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/users/flags', async (req, res) => {
    try {
        const type = req.query.type;
        const { pageSize, offset } = getPagination(req, { page: 1, pageSize: 20, maxPageSize: 100 });
        const hasType = !!type;
        const result = await pool.query(
            `SELECT q.id, q.question, f.flag_type, f.created_at, f.tags
             FROM question_flags f
             JOIN questions q ON q.id = f.question_id
             WHERE f.user_id = $1 ${hasType ? 'AND f.flag_type = $2' : ''}
             ORDER BY f.created_at DESC
             LIMIT $${hasType ? 3 : 2} OFFSET $${hasType ? 4 : 3}`,
            hasType ? [req.user.id, type, pageSize, offset] : [req.user.id, pageSize, offset]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/users/questions/:id/detail', async (req, res) => {
    try {
        const questionId = Number(req.params.id);
        if (!Number.isInteger(questionId) || questionId <= 0) {
            return res.status(400).json({ message: 'invalid question id' });
        }

        const qRes = await pool.query(
            `SELECT q.id, q.question, q.option_a, q.option_b, q.option_c, q.option_d, q.option_e,
                    q.correct_options, q.explanation,
                    m.name AS module_name, c.name AS course_name, s.name AS source_name,
                    qn.note AS user_note, qn.updated_at AS user_note_updated_at
             FROM questions q
             LEFT JOIN modules m ON m.id = q.module_id
             LEFT JOIN courses c ON c.id = q.course_id
             LEFT JOIN sources s ON s.id = q.source_id
             LEFT JOIN question_notes qn ON qn.user_id = $2 AND qn.question_id = q.id
             WHERE q.id = $1`,
            [questionId, req.user.id]
        );

        if (!qRes.rows.length) return res.status(404).json({ message: 'question not found' });
        const q = qRes.rows[0];

        const commentsRes = await pool.query(
            `SELECT qc.id, qc.body, qc.created_at, u.display_name, u.email
             FROM question_comments qc
             LEFT JOIN users u ON u.id = qc.user_id
             WHERE qc.question_id = $1
             ORDER BY qc.created_at DESC
             LIMIT 30`,
            [questionId]
        );

        const fromArray = Array.isArray(q.correct_options)
            ? q.correct_options
            : (typeof q.correct_options === 'string' ? q.correct_options.split(',') : []);

        res.json({
            ...q,
            correct_options: fromArray.map((s) => s.trim().toUpperCase()).filter(Boolean),
            comments: commentsRes.rows || []
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// USER: Personal notes per question
// ----------------------
router.get('/users/notes', async (req, res) => {
    try {
        const moduleId = Number(req.query.module_id || 0);
        const courseId = Number(req.query.course_id || 0);
        const sourceId = Number(req.query.source_id || 0);
        const favTag = String(req.query.fav_tag || '').trim().toLowerCase();
        const search = String(req.query.search || '').trim().toLowerCase();
        const sort = String(req.query.sort || 'recent').toLowerCase() === 'oldest' ? 'ASC' : 'DESC';
        const { page, pageSize, offset } = getPagination(req, { page: 1, pageSize: 12, maxPageSize: 100 });

        const params = [req.user.id];
        const where = ['qn.user_id = $1'];

        if (Number.isInteger(moduleId) && moduleId > 0) {
            params.push(moduleId);
            where.push(`q.module_id = $${params.length}`);
        }
        if (Number.isInteger(courseId) && courseId > 0) {
            params.push(courseId);
            where.push(`q.course_id = $${params.length}`);
        }
        if (Number.isInteger(sourceId) && sourceId > 0) {
            params.push(sourceId);
            where.push(`q.source_id = $${params.length}`);
        }
        if (search) {
            params.push(`%${search}%`);
            where.push(`(LOWER(q.question) LIKE $${params.length} OR LOWER(qn.note) LIKE $${params.length})`);
        }
        if (favTag) {
            params.push(favTag);
            where.push(`EXISTS (
                SELECT 1
                FROM question_flags f
                WHERE f.user_id = qn.user_id
                  AND f.question_id = qn.question_id
                  AND f.flag_type = 'favorite'
                  AND EXISTS (
                    SELECT 1
                    FROM unnest(string_to_array(lower(coalesce(f.tags, '')), ',')) AS t(tag)
                    WHERE btrim(t.tag) = $${params.length}
                  )
            )`);
        }

        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const countRes = await pool.query(
            `SELECT COUNT(*)::int AS total
             FROM question_notes qn
             JOIN questions q ON q.id = qn.question_id
             ${whereSql}`,
            params
        );
        const total = Number(countRes.rows[0]?.total || 0);

        params.push(pageSize, offset);
        const rowsRes = await pool.query(
            `SELECT qn.question_id, qn.note, qn.created_at, qn.updated_at,
                    q.question, q.option_a, q.option_b, q.option_c, q.option_d, q.option_e,
                    q.correct_options, q.explanation,
                    q.module_id, q.course_id, q.source_id,
                    m.name AS module_name, c.name AS course_name, s.name AS source_name,
                    f.tags AS favorite_tags
             FROM question_notes qn
             JOIN questions q ON q.id = qn.question_id
             LEFT JOIN modules m ON m.id = q.module_id
             LEFT JOIN courses c ON c.id = q.course_id
             LEFT JOIN sources s ON s.id = q.source_id
             LEFT JOIN question_flags f
                ON f.user_id = qn.user_id
               AND f.question_id = qn.question_id
               AND f.flag_type = 'favorite'
             ${whereSql}
             ORDER BY qn.updated_at ${sort}
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        res.json({
            data: rowsRes.rows || [],
            pagination: {
                page,
                page_size: pageSize,
                total,
                total_pages: Math.max(1, Math.ceil(total / pageSize))
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/users/questions/:id/note', async (req, res) => {
    try {
        const questionId = Number(req.params.id);
        if (!Number.isInteger(questionId) || questionId <= 0) {
            return res.status(400).json({ message: 'invalid question id' });
        }

        const result = await pool.query(
            `SELECT note, created_at, updated_at
             FROM question_notes
             WHERE user_id = $1 AND question_id = $2`,
            [req.user.id, questionId]
        );

        if (!result.rows.length) {
            return res.json({ exists: false, note: '', created_at: null, updated_at: null });
        }

        const row = result.rows[0];
        return res.json({ exists: true, note: row.note, created_at: row.created_at, updated_at: row.updated_at });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/users/questions/:id/note', async (req, res) => {
    try {
        const questionId = Number(req.params.id);
        const note = (req.body.note || '').toString().trim();

        if (!Number.isInteger(questionId) || questionId <= 0) {
            return res.status(400).json({ message: 'invalid question id' });
        }
        if (!note) {
            return res.status(400).json({ message: 'note is required' });
        }
        if (note.length > 1000) {
            return res.status(400).json({ message: 'note exceeds 1000 characters' });
        }

        const result = await pool.query(
            `INSERT INTO question_notes (user_id, question_id, note)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, question_id)
             DO UPDATE SET note = EXCLUDED.note, updated_at = NOW()
             RETURNING note, created_at, updated_at`,
            [req.user.id, questionId, note]
        );

        const row = result.rows[0];
        res.json({ exists: true, note: row.note, created_at: row.created_at, updated_at: row.updated_at });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/users/questions/:id/note', async (req, res) => {
    try {
        const questionId = Number(req.params.id);
        if (!Number.isInteger(questionId) || questionId <= 0) {
            return res.status(400).json({ message: 'invalid question id' });
        }

        await pool.query(
            `DELETE FROM question_notes
             WHERE user_id = $1 AND question_id = $2`,
            [req.user.id, questionId]
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// USER: Report question
// ----------------------
router.post('/users/questions/:id/report', async (req, res) => {
    try {
        const questionId = req.params.id;
        const { reason } = req.body;
        if (!reason || !reason.trim()) {
            return res.status(400).json({ message: 'reason required' });
        }

        const result = await pool.query(
            `INSERT INTO question_reports (user_id, question_id, reason)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [req.user.id, questionId, reason.trim()]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/users/reports', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT r.id, r.reason, r.created_at, r.resolved, r.resolved_at,
                    q.id AS question_id, q.question
             FROM question_reports r
             JOIN questions q ON q.id = r.question_id
             WHERE r.user_id = $1
             ORDER BY r.created_at DESC`,
            [req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/users/reports/:id', async (req, res) => {
    try {
        const existing = await pool.query(
            `SELECT id FROM question_reports WHERE id = $1 AND user_id = $2`,
            [req.params.id, req.user.id]
        );
        if (!existing.rows.length) return res.status(404).json({ message: 'Not found' });
        await pool.query(`DELETE FROM question_reports WHERE id = $1`, [req.params.id]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// USER: Messages (admin -> user)
// ----------------------
router.get('/messages', async (req, res) => {
    try {
        const { pageSize, offset } = getPagination(req, { page: 1, pageSize: 100, maxPageSize: 300 });
        const result = await pool.query(
            `SELECT m.id, m.body, m.created_at, m.read_at,
                    u.email AS sender_email, u.display_name AS sender_name
             FROM user_messages m
             LEFT JOIN users u ON u.id = m.sender_id
             WHERE m.recipient_id = $1
             ORDER BY m.created_at DESC
             LIMIT $2 OFFSET $3`,
            [req.user.id, pageSize, offset]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/messages/unread-count', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT COUNT(*)::int AS unread
             FROM user_messages
             WHERE recipient_id = $1 AND read_at IS NULL`,
            [req.user.id]
        );
        res.json(result.rows[0] || { unread: 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/messages/mark-read', async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.json({ ok: true });
        }
        await pool.query(
            `UPDATE user_messages
             SET read_at = NOW()
             WHERE recipient_id = $1 AND id = ANY($2::int[])`,
            [req.user.id, ids]
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// USER: Pending questions stats
// ----------------------
router.get('/users/pending-questions/stats', async (req, res) => {
    try {
        await ensurePendingQuestionsSchema();
        const stats = emptyPendingStats();
        const q = await pool.query(
            `SELECT status, COUNT(*)::int AS count
             FROM pending_questions
             WHERE submitted_by = $1
             GROUP BY status`,
            [req.user.id]
        );
        q.rows.forEach((r) => {
            const key = String(r.status || '').toLowerCase();
            const count = Number(r.count || 0);
            if (key === 'pending' || key === 'approved' || key === 'rejected') stats[key] = count;
        });
        stats.total = stats.pending + stats.approved + stats.rejected;
        return res.json({ stats });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ----------------------
// WORKER: Pending questions
// ----------------------
router.get('/worker/pending-questions', async (req, res) => {
    try {
        if (req.user?.role !== 'worker') return res.status(403).json({ message: 'Forbidden' });
        await ensurePendingQuestionsSchema();
        const status = String(req.query.status || 'pending').trim().toLowerCase();
        const pageCfg = getPagination(req, { page: 1, pageSize: 25, maxPageSize: 100 });
        const validStatus = ['pending', 'approved', 'rejected'].includes(status) ? status : 'pending';
        const moduleIds = parseIntList(req.query.module);
        const courseIds = parseIntList(req.query.course);
        const sourceIds = parseIntList(req.query.source);
        const filters = ['pq.submitted_by = $1', 'pq.status = $2'];
        const params = [req.user.id, validStatus];
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
        const where = `WHERE ${filters.join(' AND ')}`;

        const [rowsRes, countRes] = await Promise.all([
            pool.query(
                `SELECT pq.*, m.name AS module_name, c.name AS course_name, s.name AS source_name
                 FROM pending_questions pq
                 LEFT JOIN modules m ON m.id = pq.module_id
                 LEFT JOIN courses c ON c.id = pq.course_id
                 LEFT JOIN sources s ON s.id = pq.source_id
                 ${where}
                 ORDER BY pq.created_at DESC
                 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
                [...params, pageCfg.pageSize, pageCfg.offset]
            ),
            pool.query(
                `SELECT COUNT(*)::int AS total
                 FROM pending_questions pq
                 ${where}`,
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

// ----------------------
// Comments (edit/delete/react)
// ----------------------
router.put('/comments/:id', async (req, res) => {
    try {
        const commentId = req.params.id;
        const { body } = req.body;
        if (!body || !body.trim()) {
            return res.status(400).json({ message: 'body required' });
        }

        const existing = await pool.query(
            `SELECT user_id FROM question_comments WHERE id = $1`,
            [commentId]
        );
        if (!existing.rows.length) {
            return res.status(404).json({ message: 'comment not found' });
        }
        const ownerId = existing.rows[0].user_id;
        const isAdmin = req.user.role === 'admin';
        if (!isAdmin && ownerId !== req.user.id) {
            return res.status(403).json({ message: 'forbidden' });
        }

        const result = await pool.query(
            `UPDATE question_comments
             SET body = $1
             WHERE id = $2
             RETURNING id, body, created_at`,
            [body.trim(), commentId]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/comments/:id', async (req, res) => {
    try {
        const commentId = req.params.id;
        const existing = await pool.query(
            `SELECT user_id FROM question_comments WHERE id = $1`,
            [commentId]
        );
        if (!existing.rows.length) {
            return res.status(404).json({ message: 'comment not found' });
        }
        const ownerId = existing.rows[0].user_id;
        const isAdmin = req.user.role === 'admin';
        if (!isAdmin && ownerId !== req.user.id) {
            return res.status(403).json({ message: 'forbidden' });
        }
        await pool.query(`DELETE FROM question_comments WHERE id = $1`, [commentId]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/comments/:id/reaction', async (req, res) => {
    try {
        const commentId = req.params.id;
        const { value } = req.body;
        const intValue = Number(value);
        if (![1, -1].includes(intValue)) {
            return res.status(400).json({ message: 'value must be 1 or -1' });
        }

        const existing = await pool.query(
            `SELECT value FROM comment_reactions WHERE comment_id = $1 AND user_id = $2`,
            [commentId, req.user.id]
        );

        if (existing.rows.length && existing.rows[0].value === intValue) {
            await pool.query(
                `DELETE FROM comment_reactions WHERE comment_id = $1 AND user_id = $2`,
                [commentId, req.user.id]
            );
            return res.json({ ok: true, cleared: true });
        }

        await pool.query(
            `INSERT INTO comment_reactions (comment_id, user_id, value)
             VALUES ($1, $2, $3)
             ON CONFLICT (comment_id, user_id)
             DO UPDATE SET value = EXCLUDED.value`,
            [commentId, req.user.id, intValue]
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
