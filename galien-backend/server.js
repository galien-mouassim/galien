require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const sharp = require('sharp');
const pool = require('./config/database');
const initAdmin = require('./config/initAdmin');
const authMiddleware = require('./middleware/authMiddleware');


const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
const uploadsDir = process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : (process.env.RENDER ? path.join('/tmp', 'galien-uploads') : path.join(__dirname, 'uploads'));
const frontendDir = path.join(__dirname, '..', 'galien-frontend');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));
if (fs.existsSync(frontendDir)) {
    app.use(express.static(frontendDir));
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `u${req.user.id}_${Date.now()}_${safeName}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }
});

function createRateLimiter({ windowMs, max, keyFn }) {
    const hits = new Map();

    setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits.entries()) {
            if (entry.resetAt <= now) hits.delete(key);
        }
    }, Math.max(30000, Math.floor(windowMs / 2))).unref();

    return (req, res, next) => {
        const now = Date.now();
        const key = keyFn(req);
        if (!key) return next();

        let entry = hits.get(key);
        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + windowMs };
        }

        entry.count += 1;
        hits.set(key, entry);

        if (entry.count > max) {
            const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
            res.setHeader('Retry-After', String(retryAfterSec));
            return res.status(429).json({ message: 'Too many requests, please retry later.' });
        }

        return next();
    };
}

const apiLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 300,
    keyFn: (req) => req.ip || req.socket?.remoteAddress || 'unknown'
});
app.use('/api', apiLimiter);

const loginLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 15,
    keyFn: (req) => {
        const ip = req.ip || req.socket?.remoteAddress || 'unknown';
        const email = String(req.body?.email || '').toLowerCase().trim();
        return `${ip}:${email || 'no-email'}`;
    }
});

// Health check
app.get('/health', (req, res) => {
    res.send('Galien backend running OK');
});

// DB test (disabled in production)
if (process.env.NODE_ENV !== 'production') {
    app.get('/db-test', async (req, res) => {
        try {
            const result = await pool.query('SELECT NOW()');
            res.json({ dbTime: result.rows[0] });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
}

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

let loginAlertTransport = null;

function parseEmailList(value) {
    return String(value || '')
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
}

function getLoginAlertRecipients() {
    return parseEmailList(process.env.LOGIN_ALERT_TO || process.env.ALERT_EMAIL_TO);
}

function buildLoginAlertTransport() {
    if (loginAlertTransport) return loginAlertTransport;
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) return null;
    loginAlertTransport = nodemailer.createTransport({
        host,
        port: Number.isFinite(port) ? port : 587,
        secure: Number(port) === 465,
        auth: { user, pass }
    });
    return loginAlertTransport;
}

function getLoginAlertConfigIssue() {
    const recipients = getLoginAlertRecipients();
    if (!recipients.length) return 'LOGIN_ALERT_TO is empty';
    if (!process.env.SMTP_HOST) return 'SMTP_HOST missing';
    if (!process.env.SMTP_USER) return 'SMTP_USER missing';
    if (!process.env.SMTP_PASS) return 'SMTP_PASS missing';
    return null;
}

async function sendNonAdminLoginAlert({ user, req }) {
    if (!user || user.role === 'admin') return;
    const recipients = getLoginAlertRecipients();
    if (!recipients.length) {
        console.warn('Login alert skipped: LOGIN_ALERT_TO is empty');
        return;
    }
    const transporter = buildLoginAlertTransport();
    if (!transporter) {
        const issue = getLoginAlertConfigIssue() || 'SMTP transport not configured';
        console.warn(`Login alert skipped: ${issue}`);
        return;
    }

    const sender = process.env.SMTP_FROM || process.env.SMTP_USER;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const ua = req.get('user-agent') || 'unknown';
    const timestamp = new Date().toISOString();

    try {
        await transporter.sendMail({
            from: sender,
            to: recipients.join(','),
            subject: '[Galien] Login non-admin detecte',
            text: [
                'Connexion non-admin detectee.',
                `Email: ${user.email}`,
                `Role: ${user.role}`,
                `User ID: ${user.id}`,
                `Date (UTC): ${timestamp}`,
                `IP: ${ip}`,
                `User-Agent: ${ua}`
            ].join('\n')
        });
        console.info(`Login alert email sent for non-admin user ${user.email}`);
    } catch (e) {
        console.error('Failed to send non-admin login alert:', e.message);
    }
}

function requireAdmin(req, res, next) {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ message: 'Forbidden' });
    }
    return next();
}

async function ensureAuthSchema() {
    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS session_id TEXT
    `);
}

async function ensureCoreSchema() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            display_name TEXT,
            profile_photo TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS modules (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            module_class TEXT
        )
    `);

    await pool.query(`
        ALTER TABLE modules
        ADD COLUMN IF NOT EXISTS module_class TEXT
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS sources (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL UNIQUE
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS module_sources (
            module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
            source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (module_id, source_id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS courses (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL,
            UNIQUE(name, module_id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS questions (
            id SERIAL PRIMARY KEY,
            question TEXT NOT NULL,
            option_a TEXT NOT NULL,
            option_b TEXT NOT NULL,
            option_c TEXT NOT NULL,
            option_d TEXT NOT NULL,
            option_e TEXT NOT NULL,
            correct_options TEXT NOT NULL,
            explanation TEXT,
            module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL,
            course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
            source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS results (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            score NUMERIC(10,4) NOT NULL DEFAULT 0,
            total NUMERIC(10,4) NOT NULL DEFAULT 0,
            mode TEXT NOT NULL DEFAULT 'training',
            elapsed_seconds INTEGER NOT NULL DEFAULT 0,
            correction_system TEXT NOT NULL DEFAULT 'tout_ou_rien',
            time_limit_seconds INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_question_flags (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
            flag_type TEXT NOT NULL,
            tags TEXT[] NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(user_id, question_id, flag_type)
        )
    `);

    // Main flags table used by API routes
    await pool.query(`
        CREATE TABLE IF NOT EXISTS question_flags (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
            flag_type TEXT NOT NULL,
            tags TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(user_id, question_id, flag_type)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS question_reports (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
            reason TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            resolved BOOLEAN NOT NULL DEFAULT FALSE,
            resolved_at TIMESTAMPTZ,
            resolved_by INTEGER REFERENCES users(id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS question_comments (
            id SERIAL PRIMARY KEY,
            question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            body TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS comment_reactions (
            id SERIAL PRIMARY KEY,
            comment_id INTEGER NOT NULL REFERENCES question_comments(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            value INTEGER NOT NULL CHECK (value IN (1, -1)),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(comment_id, user_id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_messages (
            id SERIAL PRIMARY KEY,
            sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            body TEXT NOT NULL,
            is_read BOOLEAN NOT NULL DEFAULT FALSE,
            read_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        ALTER TABLE user_messages
        ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ
    `);
}

async function ensurePerformanceIndexes() {
    const queries = [
        'CREATE INDEX IF NOT EXISTS idx_questions_module_id ON questions(module_id)',
        'CREATE INDEX IF NOT EXISTS idx_questions_course_id ON questions(course_id)',
        'CREATE INDEX IF NOT EXISTS idx_questions_source_id ON questions(source_id)',
        'CREATE INDEX IF NOT EXISTS idx_questions_created_at ON questions(created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_question_notes_q_u ON question_notes(question_id, user_id)',
        'CREATE INDEX IF NOT EXISTS idx_results_user_created ON results(user_id, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_sqr_session_qnum ON session_question_results(session_id, question_num)',
        'CREATE INDEX IF NOT EXISTS idx_sqr_question_session ON session_question_results(question_id, session_id)',
        'CREATE INDEX IF NOT EXISTS idx_reports_resolved_created ON question_reports(resolved, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_reports_user_created ON question_reports(user_id, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_comments_question_created ON question_comments(question_id, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_comments_user_created ON question_comments(user_id, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_reactions_comment_user ON comment_reactions(comment_id, user_id)',
        'CREATE INDEX IF NOT EXISTS idx_messages_recipient_created ON user_messages(recipient_id, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_messages_recipient_read_at ON user_messages(recipient_id, read_at)',
        'CREATE INDEX IF NOT EXISTS idx_courses_module_name ON courses(module_id, name)',
        'CREATE INDEX IF NOT EXISTS idx_module_sources_module ON module_sources(module_id)',
        'CREATE INDEX IF NOT EXISTS idx_module_sources_source ON module_sources(source_id)'
    ];

    for (const q of queries) {
        await pool.query(q);
    }

    // Flags table can be either legacy or current depending on historical migrations.
    await pool.query(`
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name='question_flags'
            ) THEN
                EXECUTE 'CREATE INDEX IF NOT EXISTS idx_question_flags_user_type_created ON question_flags(user_id, flag_type, created_at DESC)';
                EXECUTE 'CREATE INDEX IF NOT EXISTS idx_question_flags_question ON question_flags(question_id)';
            END IF;
            IF EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name='user_question_flags'
            ) THEN
                EXECUTE 'CREATE INDEX IF NOT EXISTS idx_user_question_flags_user_type_created ON user_question_flags(user_id, flag_type, created_at DESC)';
                EXECUTE 'CREATE INDEX IF NOT EXISTS idx_user_question_flags_question ON user_question_flags(question_id)';
            END IF;
        END
        $$;
    `);
}

async function ensureModuleSourceBackfill() {
    await pool.query(`
        INSERT INTO module_sources (module_id, source_id)
        SELECT DISTINCT q.module_id, q.source_id
        FROM questions q
        WHERE q.module_id IS NOT NULL
          AND q.source_id IS NOT NULL
        ON CONFLICT (module_id, source_id) DO NOTHING
    `);
}

async function ensureQuestionNotesSchema() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS question_notes (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
            note TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, question_id),
            CONSTRAINT question_notes_note_len CHECK (char_length(note) <= 1000)
        )
    `);
}

async function ensureSessionResultsSchema() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS session_question_results (
            id SERIAL PRIMARY KEY,
            session_id INTEGER NOT NULL REFERENCES results(id) ON DELETE CASCADE,
            question_id INTEGER,
            question_num INTEGER NOT NULL,
            question_text TEXT,
            user_answer TEXT,
            correct_answer TEXT,
            score NUMERIC(5,4) NOT NULL DEFAULT 0,
            option_a TEXT, option_b TEXT, option_c TEXT, option_d TEXT, option_e TEXT,
            explanation TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query(`
        ALTER TABLE question_reports
        ADD COLUMN IF NOT EXISTS resolved BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS resolved_by INTEGER REFERENCES users(id)
    `);
}

async function ensureUserPreferencesSchema() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_preferences (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            default_exam_minutes INTEGER,
            correction_system TEXT NOT NULL DEFAULT 'tout_ou_rien',
            auto_next_enabled BOOLEAN NOT NULL DEFAULT FALSE,
            auto_next_delay_sec INTEGER NOT NULL DEFAULT 2,
            show_explanation_auto BOOLEAN NOT NULL DEFAULT TRUE,
            show_notes_inline BOOLEAN NOT NULL DEFAULT FALSE,
            theme_preference TEXT NOT NULL DEFAULT 'system',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        ALTER TABLE user_preferences
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS auto_next_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS auto_next_delay_sec INTEGER NOT NULL DEFAULT 2,
        ADD COLUMN IF NOT EXISTS show_explanation_auto BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS show_notes_inline BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS theme_preference TEXT NOT NULL DEFAULT 'system'
    `);
}

function normalizeQuestionText(value) {
    return (value || '')
        .toString()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function questionSimilarity(a, b) {
    const na = normalizeQuestionText(a);
    const nb = normalizeQuestionText(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    if (na.includes(nb) || nb.includes(na)) return 0.92;

    const sa = new Set(na.split(' ').filter(Boolean));
    const sb = new Set(nb.split(' ').filter(Boolean));
    if (!sa.size || !sb.size) return 0;

    let intersection = 0;
    sa.forEach(token => {
        if (sb.has(token)) intersection += 1;
    });
    const union = new Set([...sa, ...sb]).size;
    return union ? intersection / union : 0;
}

function normalizeOptionText(value) {
    return normalizeQuestionText(value);
}

function buildOptionSignature(data) {
    const opts = ['option_a', 'option_b', 'option_c', 'option_d', 'option_e']
        .map(key => normalizeOptionText(data[key]))
        .join('||');
    return opts;
}

function optionsSimilarity(a, b) {
    const keys = ['option_a', 'option_b', 'option_c', 'option_d', 'option_e'];
    let same = 0;
    keys.forEach(key => {
        if (normalizeOptionText(a[key]) === normalizeOptionText(b[key])) {
            same += 1;
        }
    });
    return same / keys.length;
}

function toIntOrNull(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
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

function weightedSimilarity(parts) {
    const valid = parts.filter(p => typeof p.score === 'number' && typeof p.weight === 'number' && p.weight > 0);
    if (!valid.length) return 0;
    const weightSum = valid.reduce((acc, p) => acc + p.weight, 0);
    const weighted = valid.reduce((acc, p) => acc + (p.score * p.weight), 0);
    return weightSum > 0 ? weighted / weightSum : 0;
}

app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body;

    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ message: 'Utilisateur introuvable' });
        }

        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password);

        if (!valid) {
            return res.status(400).json({ message: 'Mot de passe incorrect' });
        }

        const sessionId = crypto.randomUUID();
        await pool.query(
            'UPDATE users SET session_id = $1 WHERE id = $2',
            [sessionId, user.id]
        );

        const token = jwt.sign(
            { id: user.id, role: user.role, sid: sessionId },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );

        // Fire-and-forget alert when a non-admin account logs in.
        setImmediate(() => {
            sendNonAdminLoginAlert({ user, req }).catch(() => {});
        });

        res.json({
            token,
            role: user.role
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// GET QUESTIONS (training/exam)
// ----------------------
app.get('/api/questions', authMiddleware, async (req, res) => {
    try {
        const moduleIds = parseIntList(req.query.module);
        const sourceIds = parseIntList(req.query.source);
        const courseIds = parseIntList(req.query.course);
        const shouldPaginate = req.query.page !== undefined || req.query.page_size !== undefined || req.query.limit !== undefined;
        const { page, pageSize, offset } = getPagination(req, { page: 1, pageSize: 100, maxPageSize: 300 });

        let query = `
            SELECT q.*, m.name AS module_name, c.name AS course_name, s.name AS source_name,
                   qn.note AS user_note,
                   qn.updated_at AS user_note_updated_at
            FROM questions q
            LEFT JOIN modules m ON q.module_id = m.id
            LEFT JOIN courses c ON q.course_id = c.id
            LEFT JOIN sources s ON q.source_id = s.id
            LEFT JOIN question_notes qn ON qn.question_id = q.id AND qn.user_id = $1
        `;

        const params = [req.user.id];

        const filters = [];
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
        if (filters.length) {
            query += ' WHERE ' + filters.join(' AND ');
        }
        query += ' ORDER BY q.id ASC';
        if (shouldPaginate) {
            query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
            params.push(pageSize, offset);
        }

        const result = await pool.query(query, params);

        const questions = result.rows.map(q => {
            const fromArray =
                Array.isArray(q.correct_options)
                    ? q.correct_options
                    : (typeof q.correct_options === 'string'
                        ? q.correct_options.split(',')
                        : null);

            const merged = (fromArray && fromArray.length ? fromArray : [])
                .map(s => s.trim().toUpperCase())
                .filter(Boolean);

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

        let countQuery = 'SELECT COUNT(*)::int AS total FROM questions q';
        const countParams = [];
        const countFilters = [];
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
        if (countFilters.length) {
            countQuery += ' WHERE ' + countFilters.join(' AND ');
        }
        const countRes = await pool.query(countQuery, countParams);
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
app.get('/api/questions/count', authMiddleware, async (req, res) => {
    try {
        const moduleIds = parseIntList(req.query.module);
        const sourceIds = parseIntList(req.query.source);
        const courseIds = parseIntList(req.query.course);

        let query = 'SELECT COUNT(*)::int AS total FROM questions q';
        const params = [];
        const filters = [];

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
        if (filters.length) {
            query += ' WHERE ' + filters.join(' AND ');
        }

        const result = await pool.query(query, params);
        res.json({ total: result.rows[0]?.total || 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ----------------------
// SUBMIT ANSWERS
// ----------------------
app.post('/api/questions/submit', async (req, res) => {
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

            const correct = result.rows[0].correct_options
                .split(',')
                .map(a => a.trim())
                .sort();

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
app.post('/api/questions', authMiddleware, requireAdmin, async (req, res) => {
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

        const query = `
            INSERT INTO questions
            (question, option_a, option_b, option_c, option_d, option_e, correct_options, module_id, course_id, source_id, explanation)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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
            normalizedModuleId,
            normalizedCourseId,
            toIntOrNull(source_id),
            explanation
        ];

        const result = await pool.query(query, values);
        if (normalizedModuleId && toIntOrNull(source_id)) {
            await pool.query(
                `INSERT INTO module_sources (module_id, source_id)
                 VALUES ($1, $2)
                 ON CONFLICT (module_id, source_id) DO NOTHING`,
                [normalizedModuleId, toIntOrNull(source_id)]
            );
        }
        res.json(result.rows[0]);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});


// ----------------------
// ADMIN: Supprimer question
// ----------------------
app.delete('/api/questions/:id', authMiddleware, requireAdmin, async (req, res) => {
    const id = req.params.id;
    try {
        await pool.query('DELETE FROM questions WHERE id=$1', [id]);
        res.json({ message: 'Question supprimée' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/modules', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, name, module_class FROM modules ORDER BY name'
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/modules', authMiddleware, requireAdmin, async (req, res) => {
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
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// ADMIN: Check duplicate/similar questions
// ----------------------
app.post('/api/questions/check-duplicate', authMiddleware, requireAdmin, async (req, res) => {
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
        if (exclude_id) {
            query += ' WHERE id <> $1';
            params.push(Number(exclude_id));
        }

        const result = await pool.query(query, params);
        const rows = (result.rows || []).filter(r => {
            if (inputModuleId !== null && toIntOrNull(r.module_id) !== inputModuleId) return false;
            if (inputCourseId !== null && toIntOrNull(r.course_id) !== inputCourseId) return false;
            if (inputSourceId !== null && toIntOrNull(r.source_id) !== inputSourceId) return false;
            return true;
        });

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

app.get('/api/sources', async (req, res) => {
    try {
        const moduleIds = parseIntList(req.query.module_id || req.query.module);
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
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sources', authMiddleware, requireAdmin, async (req, res) => {
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
        res.json(source);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/sources/:id', authMiddleware, requireAdmin, async (req, res) => {
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
        res.json({ deleted: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// USER: Profile
// ----------------------
app.get('/api/users/me', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, email, role, display_name, profile_photo FROM users WHERE id = $1',
            [req.user.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/users/me', authMiddleware, async (req, res) => {
    try {
        const { display_name } = req.body;
        const result = await pool.query(
            'UPDATE users SET display_name = $1 WHERE id = $2 RETURNING id, email, role, display_name, profile_photo',
            [display_name || null, req.user.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/users/me/photo', authMiddleware, upload.single('photo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
        const originalPath = path.join(uploadsDir, req.file.filename);
        const compressedName = req.file.filename.replace(/\.[^.]+$/, '') + '.jpg';
        const compressedPath = path.join(uploadsDir, compressedName);

        await sharp(originalPath)
            .rotate()
            .resize(320, 320, { fit: 'cover' })
            .jpeg({ quality: 82, mozjpeg: true })
            .toFile(compressedPath);

        if (compressedPath !== originalPath && fs.existsSync(originalPath)) {
            fs.unlinkSync(originalPath);
        }

        const photoUrl = `/uploads/${compressedName}`;
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
app.get('/api/users/preferences', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT default_exam_minutes, correction_system,
                    auto_next_enabled, auto_next_delay_sec,
                    show_explanation_auto, show_notes_inline,
                    theme_preference
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
            theme_preference: 'system'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/users/preferences', authMiddleware, async (req, res) => {
    try {
        const {
            default_exam_minutes,
            correction_system,
            auto_next_enabled,
            auto_next_delay_sec,
            show_explanation_auto,
            show_notes_inline,
            theme_preference
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
                 theme_preference, updated_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
             ON CONFLICT (user_id)
             DO UPDATE SET default_exam_minutes = EXCLUDED.default_exam_minutes,
                           correction_system = EXCLUDED.correction_system,
                           auto_next_enabled = EXCLUDED.auto_next_enabled,
                           auto_next_delay_sec = EXCLUDED.auto_next_delay_sec,
                           show_explanation_auto = EXCLUDED.show_explanation_auto,
                           show_notes_inline = EXCLUDED.show_notes_inline,
                           theme_preference = EXCLUDED.theme_preference,
                           updated_at = NOW()
             RETURNING default_exam_minutes, correction_system,
                       auto_next_enabled, auto_next_delay_sec,
                       show_explanation_auto, show_notes_inline,
                       theme_preference`,
            [
                req.user.id,
                default_exam_minutes || null,
                correction_system || 'tout_ou_rien',
                !!auto_next_enabled,
                safeDelay,
                show_explanation_auto !== false,
                !!show_notes_inline,
                safeTheme
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
app.post('/api/results', authMiddleware, async (req, res) => {
    const client = await pool.connect();
    try {
        const { score, total, mode, elapsed_seconds, correction_system, time_limit_seconds, question_results } = req.body;
        await client.query('BEGIN');
        const sessionRes = await client.query(
            `INSERT INTO results (user_id, score, total, mode, elapsed_seconds, correction_system, time_limit_seconds)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [req.user.id, score, total, mode, elapsed_seconds || null, correction_system || null, time_limit_seconds || null]
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
        res.json(session);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.get('/api/results/:id/questions', authMiddleware, async (req, res) => {
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

app.get('/api/results/:sessionId/question-history/:questionId', authMiddleware, async (req, res) => {
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

app.get('/api/questions/:id/attempt-history', authMiddleware, async (req, res) => {
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

app.get('/api/users/results', authMiddleware, async (req, res) => {
    try {
        const { pageSize, offset } = getPagination(req, { page: 1, pageSize: 20, maxPageSize: 100 });
        const result = await pool.query(
            `SELECT id, score, total, mode, elapsed_seconds, correction_system, time_limit_seconds, created_at
             FROM results
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            [req.user.id, pageSize, offset]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/users/stats', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT
                COUNT(*)::int AS total_exams,
                AVG(CASE WHEN total > 0 THEN (score / total) * 100 ELSE NULL END) AS avg_percent,
                MAX(created_at) AS last_exam_at
             FROM results
             WHERE user_id = $1`,
            [req.user.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/users/analytics', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;

        const sessionsRes = await pool.query(
            `SELECT mode, created_at, COALESCE(elapsed_seconds, 0) AS elapsed_seconds,
                    score, total
             FROM results
             WHERE user_id = $1
             ORDER BY created_at ASC`,
            [userId]
        );
        const sessions = sessionsRes.rows || [];

        const modeBuckets = { training: 0, exam: 0, other: 0 };
        let totalRevisionSeconds = 0;
        sessions.forEach((s) => {
            const mode = String(s.mode || '').toLowerCase();
            if (mode.includes('train') || mode.includes('entrain')) modeBuckets.training += 1;
            else if (mode.includes('exam')) modeBuckets.exam += 1;
            else modeBuckets.other += 1;
            totalRevisionSeconds += Number(s.elapsed_seconds || 0);
        });

        const streakDatesRes = await pool.query(
            `SELECT DISTINCT DATE(created_at) AS day
             FROM results
             WHERE user_id = $1
             ORDER BY day DESC`,
            [userId]
        );
        const streakDates = (streakDatesRes.rows || []).map((r) => new Date(r.day));
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

        const moduleScoresRes = await pool.query(
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
        );

        const courseScoresRes = await pool.query(
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
        );
        const courseRows = courseScoresRes.rows || [];
        const strongestCourse = courseRows.length ? courseRows[0] : null;
        const weakestCourse = courseRows.length ? courseRows[courseRows.length - 1] : null;

        const questionsProgressRes = await pool.query(
            `SELECT
                COUNT(DISTINCT sqr.question_id)::int AS unique_questions_done,
                COUNT(sqr.question_id)::int AS total_questions_done_with_duplicates
             FROM session_question_results sqr
             JOIN results r ON r.id = sqr.session_id
             WHERE r.user_id = $1
               AND sqr.question_id IS NOT NULL`,
            [userId]
        );
        const totalQuestionsRes = await pool.query(`SELECT COUNT(*)::int AS total_questions FROM questions`);

        const favoritesRes = await pool.query(
            `SELECT COUNT(*)::int AS favorites_count
             FROM question_flags
             WHERE user_id = $1 AND flag_type = 'favorite'`,
            [userId]
        );

        const mostFailedRes = await pool.query(
            `SELECT q.id AS question_id, q.question,
                    COUNT(*)::int AS attempts,
                    SUM(CASE WHEN sqr.score < 1 THEN 1 ELSE 0 END)::int AS fail_count,
                    ROUND((SUM(CASE WHEN sqr.score < 1 THEN 1 ELSE 0 END)::numeric / COUNT(*)) * 100.0, 2) AS fail_rate_percent
             FROM session_question_results sqr
             JOIN results r ON r.id = sqr.session_id
             JOIN questions q ON q.id = sqr.question_id
             WHERE r.user_id = $1
             GROUP BY q.id, q.question
             HAVING COUNT(*) >= 2
             ORDER BY fail_rate_percent DESC, attempts DESC
             LIMIT 10`,
            [userId]
        );

        const timelineRes = await pool.query(
            `SELECT DATE(created_at) AS day,
                    ROUND(AVG(CASE WHEN total > 0 THEN (score::numeric / total::numeric) * 100 ELSE NULL END), 2) AS avg_percent,
                    COUNT(*)::int AS sessions
             FROM results
             WHERE user_id = $1
             GROUP BY DATE(created_at)
             ORDER BY day ASC`,
            [userId]
        );
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

        res.json({
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
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// USER: Favorites / Flags
// ----------------------
app.post('/api/users/questions/:id/flag', authMiddleware, async (req, res) => {
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
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/users/questions/:id/flag', authMiddleware, async (req, res) => {
    try {
        const questionId = req.params.id;
        const flagType = req.query.type;
        await pool.query(
            `DELETE FROM question_flags
             WHERE user_id = $1 AND question_id = $2 AND flag_type = $3`,
            [req.user.id, questionId, flagType]
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/users/flags', authMiddleware, async (req, res) => {
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

app.get('/api/users/questions/:id/detail', authMiddleware, async (req, res) => {
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
app.get('/api/users/questions/:id/note', authMiddleware, async (req, res) => {
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

app.put('/api/users/questions/:id/note', authMiddleware, async (req, res) => {
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

app.delete('/api/users/questions/:id/note', authMiddleware, async (req, res) => {
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
app.post('/api/users/questions/:id/report', authMiddleware, async (req, res) => {
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

// ----------------------
// ADMIN: Reports list
// ----------------------
app.get('/api/admin/reports', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
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

app.put('/api/admin/reports/:id/resolve', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
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

app.get('/api/users/reports', authMiddleware, async (req, res) => {
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

app.delete('/api/users/reports/:id', authMiddleware, async (req, res) => {
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
// USER: Question comments
// ----------------------
app.get('/api/questions/:id/comments', authMiddleware, async (req, res) => {
    try {
        const questionId = req.params.id;
        const { pageSize, offset } = getPagination(req, { page: 1, pageSize: 50, maxPageSize: 200 });
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
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/questions/:id/comments', authMiddleware, async (req, res) => {
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

app.post('/api/comments/:id/reaction', authMiddleware, async (req, res) => {
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

app.put('/api/comments/:id', authMiddleware, async (req, res) => {
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

app.delete('/api/comments/:id', authMiddleware, async (req, res) => {
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

// ----------------------
// USER: Messages (admin -> user)
// ----------------------
app.get('/api/messages', authMiddleware, async (req, res) => {
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

app.get('/api/messages/unread-count', authMiddleware, async (req, res) => {
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

app.post('/api/messages/mark-read', authMiddleware, async (req, res) => {
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
// ADMIN: Send message
// ----------------------
app.get('/api/admin/users', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Forbidden' });
        }
        const { pageSize, offset } = getPagination(req, { page: 1, pageSize: 200, maxPageSize: 500 });
        const result = await pool.query(
            `SELECT id, email, display_name, role
             FROM users
             ORDER BY email
             LIMIT $1 OFFSET $2`,
            [pageSize, offset]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/users', authMiddleware, requireAdmin, async (req, res) => {
    try {
        const email = String(req.body?.email || '').trim().toLowerCase();
        const password = String(req.body?.password || '');
        const displayName = String(req.body?.display_name || '').trim() || null;
        const roleRaw = String(req.body?.role || 'user').trim().toLowerCase();
        const role = roleRaw === 'admin' ? 'admin' : 'user';

        if (!email || !password) {
            return res.status(400).json({ message: 'email and password are required' });
        }

        const hash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            `INSERT INTO users (email, password, role, display_name)
             VALUES ($1, $2, $3, $4)
             RETURNING id, email, display_name, role, created_at`,
            [email, hash, role, displayName]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ message: 'email already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/users/:id', authMiddleware, requireAdmin, async (req, res) => {
    try {
        const targetId = Number(req.params.id);
        if (!Number.isInteger(targetId) || targetId <= 0) {
            return res.status(400).json({ message: 'invalid user id' });
        }

        const current = await pool.query('SELECT id, role FROM users WHERE id = $1', [targetId]);
        if (!current.rows.length) return res.status(404).json({ message: 'user not found' });

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
            const role = requestedRole === 'admin' ? 'admin' : 'user';
            if (req.user.id === targetId && role !== 'admin') {
                return res.status(400).json({ message: 'you cannot remove your own admin role' });
            }
            params.push(role);
            updates.push(`role = $${params.length}`);
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
             RETURNING id, email, display_name, role, created_at`,
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

app.delete('/api/admin/users/:id', authMiddleware, requireAdmin, async (req, res) => {
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

app.post('/api/admin/messages', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
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

app.post('/api/admin/test-login-alert', authMiddleware, requireAdmin, async (req, res) => {
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

// ----------------------
// ADMIN: Update question
// ----------------------
app.put('/api/questions/:id', authMiddleware, requireAdmin, async (req, res) => {
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

        const toIntOrNull = v => {
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
            toIntOrNull(module_id),
            toIntOrNull(course_id),
            toIntOrNull(source_id),
            explanation,
            id
        ];

        const result = await pool.query(query, values);
        const mId = toIntOrNull(module_id);
        const sId = toIntOrNull(source_id);
        if (mId && sId) {
            await pool.query(
                `INSERT INTO module_sources (module_id, source_id)
                 VALUES ($1, $2)
                 ON CONFLICT (module_id, source_id) DO NOTHING`,
                [mId, sId]
            );
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/courses', async (req, res) => {
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

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/courses', authMiddleware, requireAdmin, async (req, res) => {
    try {
        const { name, module_id } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Course name required' });
        }

        const result = await pool.query(
            'INSERT INTO courses (name, module_id) VALUES ($1, $2) RETURNING *',
            [name.trim(), module_id || null]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/courses/:id', authMiddleware, requireAdmin, async (req, res) => {
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
        res.json({ deleted: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------
// ADMIN: Bulk import questions (CSV -> JSON rows)
// ----------------------
app.post('/api/questions/import', authMiddleware, requireAdmin, async (req, res) => {
    const { rows } = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: 'Rows array is required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        for (const row of rows) {
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

            const toIntOrNull = v => {
                if (v === undefined || v === null || v === '') return null;
                const n = Number(v);
                return Number.isNaN(n) ? null : n;
            };

            const module_id = toIntOrNull(row.module_id);
            let course_id = toIntOrNull(row.course_id);
            let source_id = toIntOrNull(row.source_id);

            const course_name = row.course_name ? row.course_name.toString().trim() : '';
            // Backward/CSV safety: if someone puts an ID in course_name, treat it as course_id
            if (!course_id && course_name) {
                const numericCourse = toIntOrNull(course_name);
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
                const numericSource = toIntOrNull(source_name);
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
        }

        await client.query('COMMIT');
        res.json({ inserted: rows.length });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});


const PORT = process.env.PORT || 5000;
ensureCoreSchema()
    .then(() => ensureModuleSourceBackfill())
    .then(() => ensurePerformanceIndexes())
    .then(() => ensureAuthSchema())
    .then(() => ensureQuestionNotesSchema())
    .then(() => ensureSessionResultsSchema())
    .then(() => ensureUserPreferencesSchema())
    .then(() => initAdmin())
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    })
    .catch((err) => {
        console.error('Failed to initialize schema:', err.message);
        process.exit(1);
    });
