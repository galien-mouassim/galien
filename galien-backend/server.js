require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const fs = require('fs');
const path = require('path');
const pool = require('./config/database');
const initAdmin = require('./config/initAdmin');
const authMiddleware = require('./middleware/authMiddleware');
const { apiLimiter } = require('./middleware/rateLimiter');
const { uploadsDir } = require('./lib/upload');
const { parseCsv } = require('./lib/helpers');
const {
    ensureCoreSchema,
    ensureResultsSavedSchema,
    ensurePendingQuestionsSchema,
    ensureAppSettingsSchema,
    ensurePerformanceIndexes,
    ensureModuleSourceBackfill,
    ensureQuestionNotesSchema,
    ensureSessionResultsSchema,
    ensureUserPreferencesSchema,
    ensureAuthSchema,
    ensureRequestedCourses
} = require('./lib/schema');

const app = express();
app.set('trust proxy', 1);

const SLOW_QUERY_MS = Number(process.env.DB_SLOW_QUERY_MS || 250);

function compactSql(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

// Slow query monitoring wrapper
const basePoolQuery = pool.query.bind(pool);
pool.query = async (...args) => {
    const startedAt = Date.now();
    try {
        return await basePoolQuery(...args);
    } finally {
        const durationMs = Date.now() - startedAt;
        if (durationMs >= SLOW_QUERY_MS) {
            const text = args[0] && typeof args[0] === 'object' ? args[0].text : args[0];
            console.warn(`[db-slow] ${durationMs}ms ${compactSql(text).slice(0, 220)}`);
        }
    }
};

// CORS
const corsOrigins = parseCsv(process.env.CORS_ORIGINS);
const allowAllCors = corsOrigins.length === 0;

const corsOptions = allowAllCors
    ? undefined
    : {
        origin(origin, cb) {
            // Allow server-to-server / curl requests without Origin.
            if (!origin) return cb(null, true);
            const originLc = String(origin).toLowerCase();
            let parsed = null;
            try { parsed = new URL(originLc); } catch {}

            // Always allow localhost + Vercel frontend origins.
            if (parsed) {
                const host = parsed.hostname || '';
                if (
                    host === 'localhost' ||
                    host === '127.0.0.1' ||
                    host.endsWith('.vercel.app')
                ) {
                    return cb(null, true);
                }
            }

            const ok = corsOrigins.some((allowed) => {
                const a = allowed.toLowerCase();
                if (a === originLc) return true;
                if (a === '*.vercel.app') {
                    try {
                        const u = new URL(originLc);
                        return u.hostname.endsWith('.vercel.app');
                    } catch {
                        return false;
                    }
                }
                return false;
            });
            return cb(ok ? null : new Error('Not allowed by CORS'), ok);
        }
    };

app.use(cors(corsOptions));
app.use(express.json());
app.use(compression({ threshold: 1024 }));

// Static files
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));
const frontendDir = path.join(__dirname, '..', 'galien-frontend');
if (fs.existsSync(frontendDir)) {
    app.use(express.static(frontendDir));
}

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

// Mount routers
app.use('/api/auth', require('./routes/auth'));
// Public GET routes must be mounted before auth-gated routers
app.use('/api', apiLimiter, require('./routes/modules'));
app.use('/api', apiLimiter, require('./routes/sources'));
app.use('/api', apiLimiter, require('./routes/courses'));
app.use('/api', authMiddleware, apiLimiter, require('./routes/questions'));
app.use('/api', authMiddleware, apiLimiter, require('./routes/users'));
app.use('/api', authMiddleware, apiLimiter, require('./routes/admin'));

let initPromise = null;

function initApp() {
    if (!initPromise) {
        const isVercelRuntime = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
        const shouldSkipSchemaInit =
            process.env.SKIP_SCHEMA_INIT === 'true' ||
            (isVercelRuntime && process.env.SKIP_SCHEMA_INIT !== 'false');

        initPromise = shouldSkipSchemaInit
            ? Promise.resolve()
            : ensureCoreSchema()
                .then(() => Promise.all([
                    ensureModuleSourceBackfill(),
                    ensurePerformanceIndexes(),
                    ensureAuthSchema(),
                    ensureQuestionNotesSchema(),
                    ensureSessionResultsSchema(),
                    ensureUserPreferencesSchema(),
                    ensureRequestedCourses()
                ]))
                .then(() => initAdmin());
    }
    return initPromise;
}

if (require.main === module) {
    const PORT = process.env.PORT || 5000;
    initApp()
        .then(() => {
            app.listen(PORT, () => {
                console.log(`Server running on port ${PORT}`);
            });
        })
        .catch((err) => {
            console.error('Failed to initialize schema:', err.message);
            process.exit(1);
        });
} else {
    initApp().catch((err) => {
        console.error('Failed to initialize schema:', err.message);
    });
}

module.exports = { app, initApp };
