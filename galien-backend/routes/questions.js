const router = require('express').Router();
const pool = require('../config/database');
const requireActive = require('../middleware/requireActive');
const { requireAdminOrManager, requireAdminOrWorker, requireAdmin } = require('../middleware/roleMiddleware');
const { parseIntList, getPagination, parseGuidedBlocks, pushGuidedBlocksFilter, toIntOrNull } = require('../lib/helpers');
const { normalizeQuestionText, buildOptionSignature, questionSimilarity, optionsSimilarity, weightedSimilarity } = require('../lib/similarity');
const { invalidateMetadataCache } = require('../lib/cache');
const { ensurePendingQuestionsSchema } = require('../lib/schema');

const normalizeCorrectOptions = (value) => {
    if (Array.isArray(value)) {
        return value.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
    }
    if (typeof value === 'string') {
        const raw = value.trim().toUpperCase();
        if (!raw) return [];
        const mapDigit = (ch) => ({ '1': 'A', '2': 'B', '3': 'C', '4': 'D', '5': 'E' }[ch] || ch);
        const tokens = raw.split(/[^A-E1-5]+/).filter(Boolean);
        const build = (arr) => {
            const seen = new Set();
            return arr.filter((c) => {
                if (!'ABCDE'.includes(c) || seen.has(c)) return false;
                seen.add(c);
                return true;
            });
        };
        if (tokens.length > 1) {
            return build(tokens.flatMap((t) => t.split('')).map(mapDigit));
        }
        const compact = raw.replace(/[^A-E1-5]/g, '');
        return compact ? build(compact.split('').map(mapDigit)) : [];
    }
    return [];
};

// ----------------------
// GET QUESTIONS (training/exam)
// ----------------------
router.get('/questions', requireActive, async (req, res) => {
    try {
        const moduleIds = parseIntList(req.query.module);
        const sourceIds = parseIntList(req.query.source);
        const courseIds = parseIntList(req.query.course);
        const guidedBlocks = parseGuidedBlocks(req.query.guided_filters);
        const reviewMode = String(req.query.review_mode || '').trim();
        const unansweredOnly = req.query.unanswered_only === '1';
        const shouldPaginate = req.query.page !== undefined || req.query.page_size !== undefined || req.query.limit !== undefined;
        const { page, pageSize, offset } = getPagination(req, { page: 1, pageSize: 100, maxPageSize: 300 });
        const runQuery = async ({ withNotes, withReview }) => {
            let query = `
                SELECT q.*, m.name AS module_name, c.name AS course_name, s.name AS source_name,
                       ${withNotes ? 'qn.note AS user_note, qn.updated_at AS user_note_updated_at' : 'NULL::text AS user_note, NULL::timestamptz AS user_note_updated_at'}
                FROM questions q
                LEFT JOIN modules m ON q.module_id = m.id
                LEFT JOIN courses c ON q.course_id = c.id
                LEFT JOIN sources s ON q.source_id = s.id
                ${withNotes ? 'LEFT JOIN question_notes qn ON qn.question_id = q.id AND qn.user_id = $1' : ''}
            `;
            const params = withNotes ? [req.user.id] : [];
            const filters = [];

            if (guidedBlocks.length) {
                pushGuidedBlocksFilter({ filters, params, tableAlias: 'q', guidedBlocks });
            } else {
                if (moduleIds.length) {
                    filters.push(`q.module_id = ANY($${params.length + 1}::int[])`);
                    params.push(moduleIds);
                }
                if (sourceIds.length) {
                    filters.push(`q.source_id = ANY($${params.length + 1}::int[])`);
                    params.push(sourceIds);
                }
                if (courseIds.length) {
                    filters.push(`q.course_id = ANY($${params.length + 1}::int[])`);
                    params.push(courseIds);
                }
            }
            if (withReview && reviewMode === 'wrong_ever') {
                filters.push(`
                    EXISTS (
                        SELECT 1
                        FROM session_question_results sqr
                        JOIN results r ON r.id = sqr.session_id
                        WHERE r.user_id = $${params.length + 1}
                          AND sqr.question_id = q.id
                          AND sqr.score < 1
                    )
                `);
                params.push(req.user.id);
            } else if (withReview && reviewMode === 'wrong_last') {
                filters.push(`
                    EXISTS (
                        SELECT 1
                        FROM (
                            SELECT DISTINCT ON (sqr.question_id)
                                sqr.question_id,
                                sqr.score
                            FROM session_question_results sqr
                            JOIN results r ON r.id = sqr.session_id
                            WHERE r.user_id = $${params.length + 1}
                            ORDER BY sqr.question_id, r.created_at DESC, sqr.id DESC
                        ) last_q
                        WHERE last_q.question_id = q.id
                          AND last_q.score < 1
                    )
                `);
                params.push(req.user.id);
            } else if (withReview && reviewMode === 'unanswered') {
                filters.push(`
                    NOT EXISTS (
                        SELECT 1
                        FROM session_question_results sqr
                        JOIN results r ON r.id = sqr.session_id
                        WHERE r.user_id = $${params.length + 1}
                          AND sqr.question_id = q.id
                          AND COALESCE(NULLIF(BTRIM(sqr.user_answer), ''), '') <> ''
                    )
                `);
                params.push(req.user.id);
            }
            if (withReview && unansweredOnly) {
                filters.push(`
                    NOT EXISTS (
                        SELECT 1
                        FROM session_question_results sqr
                        JOIN results r ON r.id = sqr.session_id
                        WHERE r.user_id = $${params.length + 1}
                          AND sqr.question_id = q.id
                          AND COALESCE(NULLIF(BTRIM(sqr.user_answer), ''), '') <> ''
                    )
                `);
                params.push(req.user.id);
            }
            if (filters.length) query += ' WHERE ' + filters.join(' AND ');
            query += ' ORDER BY q.id ASC';
            if (shouldPaginate) {
                query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
                params.push(pageSize, offset);
            }

            let countQuery = 'SELECT COUNT(*)::int AS total FROM questions q';
            const countParams = [];
            const countFilters = [];
            if (guidedBlocks.length) {
                pushGuidedBlocksFilter({ filters: countFilters, params: countParams, tableAlias: 'q', guidedBlocks });
            } else {
                if (moduleIds.length) {
                    countFilters.push(`q.module_id = ANY($${countParams.length + 1}::int[])`);
                    countParams.push(moduleIds);
                }
                if (sourceIds.length) {
                    countFilters.push(`q.source_id = ANY($${countParams.length + 1}::int[])`);
                    countParams.push(sourceIds);
                }
                if (courseIds.length) {
                    countFilters.push(`q.course_id = ANY($${countParams.length + 1}::int[])`);
                    countParams.push(courseIds);
                }
            }
            if (withReview && reviewMode === 'wrong_ever') {
                countFilters.push(`
                    EXISTS (
                        SELECT 1
                        FROM session_question_results sqr
                        JOIN results r ON r.id = sqr.session_id
                        WHERE r.user_id = $${countParams.length + 1}
                          AND sqr.question_id = q.id
                          AND sqr.score < 1
                    )
                `);
                countParams.push(req.user.id);
            } else if (withReview && reviewMode === 'wrong_last') {
                countFilters.push(`
                    EXISTS (
                        SELECT 1
                        FROM (
                            SELECT DISTINCT ON (sqr.question_id)
                                sqr.question_id,
                                sqr.score
                            FROM session_question_results sqr
                            JOIN results r ON r.id = sqr.session_id
                            WHERE r.user_id = $${countParams.length + 1}
                            ORDER BY sqr.question_id, r.created_at DESC, sqr.id DESC
                        ) last_q
                        WHERE last_q.question_id = q.id
                          AND last_q.score < 1
                    )
                `);
                countParams.push(req.user.id);
            } else if (withReview && reviewMode === 'unanswered') {
                countFilters.push(`
                    NOT EXISTS (
                        SELECT 1
                        FROM session_question_results sqr
                        JOIN results r ON r.id = sqr.session_id
                        WHERE r.user_id = $${countParams.length + 1}
                          AND sqr.question_id = q.id
                          AND COALESCE(NULLIF(BTRIM(sqr.user_answer), ''), '') <> ''
                    )
                `);
                countParams.push(req.user.id);
            }
            if (withReview && unansweredOnly) {
                countFilters.push(`
                    NOT EXISTS (
                        SELECT 1
                        FROM session_question_results sqr
                        JOIN results r ON r.id = sqr.session_id
                        WHERE r.user_id = $${countParams.length + 1}
                          AND sqr.question_id = q.id
                          AND COALESCE(NULLIF(BTRIM(sqr.user_answer), ''), '') <> ''
                    )
                `);
                countParams.push(req.user.id);
            }
            if (countFilters.length) countQuery += ' WHERE ' + countFilters.join(' AND ');

            const [result, countRes] = shouldPaginate
                ? await Promise.all([pool.query(query, params), pool.query(countQuery, countParams)])
                : [await pool.query(query, params), null];
            return { result, countRes };
        };

        let runOpts = { withNotes: true, withReview: true };
        let queryResult;
        try {
            queryResult = await runQuery(runOpts);
        } catch (err) {
            if (err.code === '42P01') {
                const msg = String(err.message || '').toLowerCase();
                if (msg.includes('question_notes')) runOpts.withNotes = false;
                if (msg.includes('session_question_results') || msg.includes('results')) runOpts.withReview = false;
                queryResult = await runQuery(runOpts);
            } else {
                throw err;
            }
        }

        const { result, countRes } = queryResult;

        const questions = result.rows.map(q => {
            const merged = normalizeCorrectOptions(q.correct_options);

            return {
                ...q,
                correct_options: merged,
                // Keep legacy field for frontend/admin display
                correct_option: (q.correct_options || '').toString(),
                has_user_note: !!q.user_note
            };
        });

        if (!shouldPaginate) {
            return res.json({ questions });
        }
        const total = Number(countRes.rows[0]?.total || 0);

        return res.json({
            questions,
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

// Lightweight count endpoint for dashboard filters
router.get('/questions/count', async (req, res) => {
    try {
        const moduleIds = parseIntList(req.query.module);
        const sourceIds = parseIntList(req.query.source);
        const courseIds = parseIntList(req.query.course);
        const guidedBlocks = parseGuidedBlocks(req.query.guided_filters);
        const reviewMode = String(req.query.review_mode || '').trim();
        const unansweredOnly = req.query.unanswered_only === '1';
        const runCount = async (withReview) => {
            let query = 'SELECT COUNT(*)::int AS total FROM questions q';
            const params = [];
            const filters = [];

            if (guidedBlocks.length) {
                pushGuidedBlocksFilter({ filters, params, tableAlias: 'q', guidedBlocks });
            } else {
                if (moduleIds.length) {
                    filters.push(`q.module_id = ANY($${params.length + 1}::int[])`);
                    params.push(moduleIds);
                }
                if (sourceIds.length) {
                    filters.push(`q.source_id = ANY($${params.length + 1}::int[])`);
                    params.push(sourceIds);
                }
                if (courseIds.length) {
                    filters.push(`q.course_id = ANY($${params.length + 1}::int[])`);
                    params.push(courseIds);
                }
            }
            if (withReview && reviewMode === 'wrong_ever') {
                filters.push(`
                    EXISTS (
                        SELECT 1
                        FROM session_question_results sqr
                        JOIN results r ON r.id = sqr.session_id
                        WHERE r.user_id = $${params.length + 1}
                          AND sqr.question_id = q.id
                          AND sqr.score < 1
                    )
                `);
                params.push(req.user.id);
            } else if (withReview && reviewMode === 'wrong_last') {
                filters.push(`
                    EXISTS (
                        SELECT 1
                        FROM (
                            SELECT DISTINCT ON (sqr.question_id)
                                sqr.question_id,
                                sqr.score
                            FROM session_question_results sqr
                            JOIN results r ON r.id = sqr.session_id
                            WHERE r.user_id = $${params.length + 1}
                            ORDER BY sqr.question_id, r.created_at DESC, sqr.id DESC
                        ) last_q
                        WHERE last_q.question_id = q.id
                          AND last_q.score < 1
                    )
                `);
                params.push(req.user.id);
            } else if (withReview && reviewMode === 'unanswered') {
                filters.push(`
                    NOT EXISTS (
                        SELECT 1
                        FROM session_question_results sqr
                        JOIN results r ON r.id = sqr.session_id
                        WHERE r.user_id = $${params.length + 1}
                          AND sqr.question_id = q.id
                          AND COALESCE(NULLIF(BTRIM(sqr.user_answer), ''), '') <> ''
                    )
                `);
                params.push(req.user.id);
            }
            if (withReview && unansweredOnly) {
                filters.push(`
                    NOT EXISTS (
                        SELECT 1
                        FROM session_question_results sqr
                        JOIN results r ON r.id = sqr.session_id
                        WHERE r.user_id = $${params.length + 1}
                          AND sqr.question_id = q.id
                          AND COALESCE(NULLIF(BTRIM(sqr.user_answer), ''), '') <> ''
                    )
                `);
                params.push(req.user.id);
            }
            if (filters.length) query += ' WHERE ' + filters.join(' AND ');
            return pool.query(query, params);
        };

        let result;
        try {
            result = await runCount(true);
        } catch (err) {
            if (err.code === '42P01') {
                result = await runCount(false);
            } else {
                throw err;
            }
        }
        res.json({ total: result.rows[0]?.total || 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// SUBMIT ANSWERS
// ----------------------
router.post('/questions/submit', requireActive, async (req, res) => {
    const { answers } = req.body;
    let score = 0;
    const corrections = [];

    try {
        for (const ans of answers) {
            const result = await pool.query(
                'SELECT correct_options FROM questions WHERE id = $1',
                [ans.id]
            );

            if (!result.rows.length) continue;

            const correct = normalizeCorrectOptions(result.rows[0].correct_options).sort();

            const selected = (ans.selectedOptions || []).sort();

            const isCorrect =
                JSON.stringify(correct) === JSON.stringify(selected);

            if (isCorrect) score++;

            corrections.push({
                id: ans.id,
                correctOptions: correct,
                selectedOptions: selected
            });
        }

        res.json({
            score,
            total: answers.length,
            corrections
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// ADMIN: Add question
// ----------------------
router.post('/questions', requireAdminOrWorker, async (req, res) => {
    try {
        const {
            question,
            option_a,
            option_b,
            option_c,
            option_d,
            option_e,
            correct_option,
            module_id,
            course_id,
            source_id,
            explanation
        } = req.body;

        const normalizedQuestion = normalizeQuestionText(question);
        if (!normalizedQuestion) {
            return res.status(400).json({ message: 'Question required' });
        }
        const normalizedModuleId = toIntOrNull(module_id);
        const normalizedCourseId = toIntOrNull(course_id);
        const newSignature = buildOptionSignature({ option_a, option_b, option_c, option_d, option_e });

        const existing = await pool.query(
            `SELECT id, question, module_id, course_id, option_a, option_b, option_c, option_d, option_e
             FROM questions`
        );
        const duplicate = existing.rows.find(r =>
            normalizeQuestionText(r.question) === normalizedQuestion &&
            buildOptionSignature(r) === newSignature &&
            toIntOrNull(r.module_id) === normalizedModuleId &&
            toIntOrNull(r.course_id) === normalizedCourseId
        );
        if (duplicate) {
            return res.status(409).json({
                message: 'Question déjà existante',
                duplicate_id: duplicate.id
            });
        }

        const normalizedSourceId = toIntOrNull(source_id);

        if (req.user.role === 'worker') {
            await ensurePendingQuestionsSchema();
            const pending = await pool.query(
                `INSERT INTO pending_questions
                 (question, option_a, option_b, option_c, option_d, option_e, correct_options, module_id, course_id, source_id, explanation, submitted_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                 RETURNING id, status, created_at`,
                [
                    question,
                    option_a,
                    option_b,
                    option_c,
                    option_d,
                    option_e,
                    correct_option,
                    normalizedModuleId,
                    normalizedCourseId,
                    normalizedSourceId,
                    explanation,
                    req.user.id
                ]
            );
            return res.status(202).json({
                message: 'Question envoyée pour validation admin',
                pending_question: pending.rows[0]
            });
        }

        const result = await pool.query(
            `INSERT INTO questions
             (question, option_a, option_b, option_c, option_d, option_e, correct_options, module_id, course_id, source_id, explanation)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             RETURNING *;`,
            [
                question,
                option_a,
                option_b,
                option_c,
                option_d,
                option_e,
                correct_option,
                normalizedModuleId,
                normalizedCourseId,
                normalizedSourceId,
                explanation
            ]
        );
        if (normalizedModuleId && normalizedSourceId) {
            await pool.query(
                `INSERT INTO module_sources (module_id, source_id)
                 VALUES ($1, $2)
                 ON CONFLICT (module_id, source_id) DO NOTHING`,
                [normalizedModuleId, normalizedSourceId]
            );
        }
        invalidateMetadataCache();
        res.json(result.rows[0]);

    } catch (err) {
        console.error(err);
        if (err?.code === '23503') {
            return res.status(400).json({ message: 'Module, cours ou source invalide.' });
        }
        if (err?.code === '22P02') {
            return res.status(400).json({ message: 'Valeur invalide dans le formulaire.' });
        }
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// ADMIN: Supprimer question
// ----------------------
router.delete('/questions/:id', requireAdminOrManager, async (req, res) => {
    const id = req.params.id;
    try {
        await pool.query('DELETE FROM questions WHERE id=$1', [id]);
        res.json({ message: 'Question supprimée' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// ADMIN: Check duplicate/similar questions
// ----------------------
router.post('/questions/check-duplicate', requireAdminOrManager, async (req, res) => {
    try {
        const {
            question,
            option_a,
            option_b,
            option_c,
            option_d,
            option_e,
            module_id,
            course_id,
            source_id,
            exclude_id
        } = req.body;
        const normalized = normalizeQuestionText(question);
        const inputModuleId = toIntOrNull(module_id);
        const inputCourseId = toIntOrNull(course_id);
        const inputSourceId = toIntOrNull(source_id);
        const inputOptions = { option_a, option_b, option_c, option_d, option_e };
        const inputSignature = buildOptionSignature(inputOptions);
        if (!normalized) {
            return res.json({ exact_matches: [], similar_matches: [] });
        }

        const params = [];
        let query = `
            SELECT id, question, module_id, course_id, source_id,
                   option_a, option_b, option_c, option_d, option_e
            FROM questions
        `;
        const filters = [];
        if (exclude_id) {
            filters.push(`id <> $${params.length + 1}`);
            params.push(Number(exclude_id));
        }
        if (inputModuleId !== null) {
            filters.push(`module_id = $${params.length + 1}`);
            params.push(inputModuleId);
        }
        if (inputCourseId !== null) {
            filters.push(`course_id = $${params.length + 1}`);
            params.push(inputCourseId);
        }
        if (inputSourceId !== null) {
            filters.push(`source_id = $${params.length + 1}`);
            params.push(inputSourceId);
        }
        if (filters.length) {
            query += ` WHERE ${filters.join(' AND ')}`;
        }

        const normalizedTokens = normalized.split(' ').filter(Boolean);
        if (normalizedTokens.length) {
            const token = normalizedTokens[0];
            query += `${filters.length ? ' AND' : ' WHERE'} LOWER(question) LIKE $${params.length + 1}`;
            params.push(`%${token}%`);
        }

        query += ' ORDER BY id DESC LIMIT 1500';

        const result = await pool.query(query, params);
        const rows = result.rows || [];

        const exactMatches = rows.filter(r =>
            normalizeQuestionText(r.question) === normalized &&
            buildOptionSignature(r) === inputSignature &&
            toIntOrNull(r.module_id) === inputModuleId &&
            toIntOrNull(r.course_id) === inputCourseId &&
            toIntOrNull(r.source_id) === inputSourceId
        );
        const similarMatches = rows
            .map(r => ({
                id: r.id,
                question: r.question,
                module_id: r.module_id,
                course_id: r.course_id,
                source_id: r.source_id,
                score: Number(
                    weightedSimilarity([
                        { score: questionSimilarity(question, r.question), weight: 0.4 },
                        { score: optionsSimilarity(inputOptions, r), weight: 0.4 },
                        ...(inputModuleId !== null ? [{ score: toIntOrNull(r.module_id) === inputModuleId ? 1 : 0, weight: 0.1 }] : []),
                        ...(inputCourseId !== null ? [{ score: toIntOrNull(r.course_id) === inputCourseId ? 1 : 0, weight: 0.1 }] : []),
                        ...(inputSourceId !== null ? [{ score: toIntOrNull(r.source_id) === inputSourceId ? 1 : 0, weight: 0.1 }] : [])
                    ]).toFixed(3)
                )
            }))
            .filter(r => r.score >= 0.45 && r.score < 1)
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);

        res.json({
            exact_matches: exactMatches,
            similar_matches: similarMatches
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// ADMIN: Update question
// ----------------------
router.put('/questions/:id', requireAdminOrManager, async (req, res) => {
    try {
        const id = req.params.id;
        const {
            question,
            option_a,
            option_b,
            option_c,
            option_d,
            option_e,
            correct_option,
            module_id,
            course_id,
            source_id,
            explanation
        } = req.body;

        const toIntOrNullLocal = v => {
            if (v === undefined || v === null || v === '') return null;
            const n = Number(v);
            return Number.isNaN(n) ? null : n;
        };

        const query = `
            UPDATE questions
            SET question = $1,
                option_a = $2,
                option_b = $3,
                option_c = $4,
                option_d = $5,
                option_e = $6,
                correct_options = $7,
                module_id = $8,
                course_id = $9,
                source_id = $10,
                explanation = $11
            WHERE id = $12
            RETURNING *;
        `;

        const values = [
            question,
            option_a,
            option_b,
            option_c,
            option_d,
            option_e,
            correct_option,
            toIntOrNullLocal(module_id),
            toIntOrNullLocal(course_id),
            toIntOrNullLocal(source_id),
            explanation,
            id
        ];

        const result = await pool.query(query, values);
        const mId = toIntOrNullLocal(module_id);
        const sId = toIntOrNullLocal(source_id);
        if (mId && sId) {
            await pool.query(
                `INSERT INTO module_sources (module_id, source_id)
                 VALUES ($1, $2)
                 ON CONFLICT (module_id, source_id) DO NOTHING`,
                [mId, sId]
            );
        }
        invalidateMetadataCache();
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// USER: Question comments
// ----------------------
router.get('/questions/:id/comments', async (req, res) => {
    try {
        const questionId = req.params.id;
        const { pageSize, offset } = getPagination(req, { page: 1, pageSize: 50, maxPageSize: 200 });
        const { sanitizeProfilePhotoForResponse } = require('../lib/upload');
        const result = await pool.query(
            `SELECT c.id, c.body, c.created_at, c.user_id, u.display_name, u.email, u.profile_photo,
                    COALESCE(SUM(CASE WHEN r.value = 1 THEN 1 ELSE 0 END), 0) AS likes,
                    COALESCE(SUM(CASE WHEN r.value = -1 THEN 1 ELSE 0 END), 0) AS dislikes,
                    MAX(CASE WHEN r.user_id = $2 THEN r.value ELSE NULL END) AS my_reaction,
                    CASE WHEN c.user_id = $2 OR $3 = 'admin' THEN TRUE ELSE FALSE END AS can_edit
             FROM question_comments c
             LEFT JOIN users u ON u.id = c.user_id
             LEFT JOIN comment_reactions r ON r.comment_id = c.id
             WHERE c.question_id = $1
             GROUP BY c.id, u.display_name, u.email, u.profile_photo
             ORDER BY c.created_at DESC
             LIMIT $4 OFFSET $5`,
            [questionId, req.user.id, req.user.role, pageSize, offset]
        );
        const rows = (result.rows || []).map((row) => ({
            ...row,
            profile_photo: sanitizeProfilePhotoForResponse(row.profile_photo)
        }));
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/questions/:id/comments', async (req, res) => {
    try {
        const questionId = req.params.id;
        const { body } = req.body;
        if (!body || !body.trim()) {
            return res.status(400).json({ message: 'body required' });
        }
        const result = await pool.query(
            `INSERT INTO question_comments (question_id, user_id, body)
             VALUES ($1, $2, $3)
             RETURNING id, body, created_at`,
            [questionId, req.user.id, body.trim()]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/questions/:id/attempt-history', async (req, res) => {
    try {
        const questionId = Number(req.params.id);
        if (!Number.isInteger(questionId) || questionId <= 0) {
            return res.status(400).json({ message: 'invalid question id' });
        }

        const result = await pool.query(
            `SELECT sqr.user_answer, sqr.correct_answer, sqr.score, r.created_at, r.mode
             FROM session_question_results sqr
             JOIN results r ON r.id = sqr.session_id
             WHERE r.user_id = $1
               AND sqr.question_id = $2
             ORDER BY r.created_at DESC
             LIMIT 5`,
            [req.user.id, questionId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// ADMIN: Export CSV
// ----------------------
router.get('/admin/questions/export-csv', requireAdmin, async (req, res) => {
    try {
        const providedPass = String(req.query.pass || '');
        const expectedPass = String(process.env.ADMIN_EXPORT_PASS || '');
        if (!expectedPass) {
            return res.status(503).json({ message: 'Export CSV indisponible: mot de passe non configuré' });
        }
        if (providedPass !== expectedPass) {
            return res.status(403).json({ message: 'Mot de passe export invalide' });
        }

        const result = await pool.query(
            `SELECT q.id, q.question, q.option_a, q.option_b, q.option_c, q.option_d, q.option_e,
                    q.correct_options, q.module_id, q.course_id, q.source_id, q.explanation,
                    m.name AS module_name, c.name AS course_name, s.name AS source_name
             FROM questions q
             LEFT JOIN modules m ON m.id = q.module_id
             LEFT JOIN courses c ON c.id = q.course_id
             LEFT JOIN sources s ON s.id = q.source_id
             ORDER BY q.id ASC`
        );

        const escape = (v) => {
            const raw = v === null || v === undefined ? '' : String(v);
            return `"${raw.replace(/"/g, '""')}"`;
        };

        const header = [
            'id', 'question', 'option_a', 'option_b', 'option_c', 'option_d', 'option_e',
            'correct_option', 'module_id', 'module_name', 'course_id', 'course_name',
            'source_id', 'source_name', 'explanation'
        ];

        const lines = [header.join(',')];
        result.rows.forEach((r) => {
            lines.push([
                r.id, r.question, r.option_a, r.option_b, r.option_c, r.option_d, r.option_e,
                r.correct_options, r.module_id, r.module_name, r.course_id, r.course_name,
                r.source_id, r.source_name, r.explanation
            ].map(escape).join(','));
        });

        const csv = '\uFEFF' + lines.join('\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="questions_export.csv"');
        return res.send(csv);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// ADMIN: Bulk import questions (CSV -> JSON rows)
// ----------------------
router.post('/questions/import', requireAdminOrManager, async (req, res) => {
    const { rows } = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: 'Rows array is required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const existingRes = await client.query(
            `SELECT id, question, option_a, option_b, option_c, option_d, option_e,
                    module_id, course_id, source_id
             FROM questions`
        );
        const duplicateKeys = new Set();
        existingRes.rows.forEach((q) => {
            const key = [
                normalizeQuestionText(q.question),
                buildOptionSignature(q),
                String(toIntOrNull(q.module_id) ?? ''),
                String(toIntOrNull(q.course_id) ?? ''),
                String(toIntOrNull(q.source_id) ?? '')
            ].join('::');
            duplicateKeys.add(key);
        });

        let inserted = 0;
        const skipped = [];

        for (const [idx, row] of rows.entries()) {
            const question = (row.question || '').trim();
            const option_a = (row.option_a || '').trim();
            const option_b = (row.option_b || '').trim();
            const option_c = (row.option_c || '').trim();
            const option_d = (row.option_d || '').trim();
            const option_e = (row.option_e || '').trim();
            const correct_option = (row.correct_option || row.correct_options || '').toString().toUpperCase().trim();
            const explanation = row.explanation ? row.explanation.toString() : null;

            if (!question || !option_a || !option_b || !option_c || !option_d || !option_e || !correct_option) {
                throw new Error('Missing required fields in one of the rows');
            }

            const toIntOrNullLocal = v => {
                if (v === undefined || v === null || v === '') return null;
                const n = Number(v);
                return Number.isNaN(n) ? null : n;
            };

            const module_id = toIntOrNullLocal(row.module_id);
            let course_id = toIntOrNullLocal(row.course_id);
            let source_id = toIntOrNullLocal(row.source_id);

            const course_name = row.course_name ? row.course_name.toString().trim() : '';
            // Backward/CSV safety: if someone puts an ID in course_name, treat it as course_id
            if (!course_id && course_name) {
                const numericCourse = toIntOrNullLocal(course_name);
                if (numericCourse) {
                    course_id = numericCourse;
                }
            }
            if (!course_id && course_name) {
                if (!module_id) {
                    throw new Error('course_name provided without module_id');
                }
                const courseRes = await client.query(
                    'SELECT id FROM courses WHERE name = $1 AND module_id = $2',
                    [course_name, module_id]
                );
                if (courseRes.rows.length) {
                    course_id = courseRes.rows[0].id;
                } else {
                    const insertCourse = await client.query(
                        'INSERT INTO courses (name, module_id) VALUES ($1, $2) RETURNING id',
                        [course_name, module_id]
                    );
                    course_id = insertCourse.rows[0].id;
                }
            }

            const source_name = row.source_name ? row.source_name.toString().trim() : '';
            // Backward/CSV safety: if someone puts an ID in source_name, treat it as source_id
            if (!source_id && source_name) {
                const numericSource = toIntOrNullLocal(source_name);
                if (numericSource) {
                    source_id = numericSource;
                }
            }
            if (!source_id && source_name) {
                const sourceRes = await client.query(
                    `INSERT INTO sources (name)
                     VALUES ($1)
                     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
                     RETURNING id`,
                    [source_name]
                );
                source_id = sourceRes.rows[0].id;
            }

            if (module_id && source_id) {
                await client.query(
                    `INSERT INTO module_sources (module_id, source_id)
                     VALUES ($1, $2)
                     ON CONFLICT (module_id, source_id) DO NOTHING`,
                    [module_id, source_id]
                );
            }

            const importKey = [
                normalizeQuestionText(question),
                buildOptionSignature({ option_a, option_b, option_c, option_d, option_e }),
                String(module_id ?? ''),
                String(course_id ?? ''),
                String(source_id ?? '')
            ].join('::');
            if (duplicateKeys.has(importKey)) {
                skipped.push({
                    row: idx + 1,
                    question,
                    reason: 'duplicate'
                });
                continue;
            }

            const insertQuery = `
                INSERT INTO questions
                (question, option_a, option_b, option_c, option_d, option_e, correct_options, module_id, course_id, source_id, explanation)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            `;

            const values = [
                question,
                option_a,
                option_b,
                option_c,
                option_d,
                option_e,
                correct_option,
                module_id,
                course_id,
                source_id,
                explanation
            ];

            await client.query(insertQuery, values);
            duplicateKeys.add(importKey);
            inserted += 1;
        }

        await client.query('COMMIT');
        invalidateMetadataCache();
        res.json({
            inserted,
            skipped_duplicates: skipped.length,
            skipped
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

module.exports = router;
