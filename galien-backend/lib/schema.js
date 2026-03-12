const pool = require('../config/database');
const { normalizeQuestionText } = require('./similarity');

let ensureResultsSavedSchemaPromise = null;
let ensurePendingQuestionsSchemaPromise = null;
let ensureAppSettingsSchemaPromise = null;

async function ensureResultsSavedSchema() {
    if (ensureResultsSavedSchemaPromise) return ensureResultsSavedSchemaPromise;
    ensureResultsSavedSchemaPromise = (async () => {
        await pool.query(`
            ALTER TABLE results
            ADD COLUMN IF NOT EXISTS is_saved BOOLEAN NOT NULL DEFAULT FALSE
        `);
        await pool.query(`
            ALTER TABLE results
            ADD COLUMN IF NOT EXISTS session_name TEXT
        `);
    })().catch((err) => {
        ensureResultsSavedSchemaPromise = null;
        throw err;
    });
    return ensureResultsSavedSchemaPromise;
}

async function ensurePendingQuestionsSchema() {
    if (ensurePendingQuestionsSchemaPromise) return ensurePendingQuestionsSchemaPromise;
    ensurePendingQuestionsSchemaPromise = (async () => {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS pending_questions (
                id SERIAL PRIMARY KEY,
                question TEXT NOT NULL,
                option_a TEXT NOT NULL,
                option_b TEXT NOT NULL,
                option_c TEXT NOT NULL,
                option_d TEXT NOT NULL,
                option_e TEXT NOT NULL,
                correct_options TEXT NOT NULL,
                module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL,
                course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
                source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
                explanation TEXT,
                submitted_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                status TEXT NOT NULL DEFAULT 'pending',
                admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                reviewed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await pool.query(`
            ALTER TABLE pending_questions
            ADD COLUMN IF NOT EXISTS option_a TEXT,
            ADD COLUMN IF NOT EXISTS option_b TEXT,
            ADD COLUMN IF NOT EXISTS option_c TEXT,
            ADD COLUMN IF NOT EXISTS option_d TEXT,
            ADD COLUMN IF NOT EXISTS option_e TEXT,
            ADD COLUMN IF NOT EXISTS correct_options TEXT,
            ADD COLUMN IF NOT EXISTS module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS explanation TEXT,
            ADD COLUMN IF NOT EXISTS submitted_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
            ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending',
            ADD COLUMN IF NOT EXISTS admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        `);
        await pool.query(`
            ALTER TABLE pending_questions
            DROP CONSTRAINT IF EXISTS pending_questions_status_check
        `);
        await pool.query(`
            ALTER TABLE pending_questions
            ADD CONSTRAINT pending_questions_status_check
            CHECK (status IN ('pending', 'approved', 'rejected'))
        `);
    })().catch((err) => {
        ensurePendingQuestionsSchemaPromise = null;
        throw err;
    });
    return ensurePendingQuestionsSchemaPromise;
}

async function ensureAppSettingsSchema() {
    if (ensureAppSettingsSchemaPromise) return ensureAppSettingsSchemaPromise;
    ensureAppSettingsSchemaPromise = (async () => {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        `);
        await pool.query(`
            INSERT INTO app_settings (key, value)
            VALUES ('non_admin_login_alert_enabled', 'true')
            ON CONFLICT (key) DO NOTHING
        `);
    })().catch((err) => {
        ensureAppSettingsSchemaPromise = null;
        throw err;
    });
    return ensureAppSettingsSchemaPromise;
}

async function ensureCoreSchema() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            active_until TIMESTAMPTZ,
            display_name TEXT,
            profile_photo TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        ALTER TABLE users
        DROP CONSTRAINT IF EXISTS users_role_check
    `);
    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS display_name TEXT,
        ADD COLUMN IF NOT EXISTS profile_photo TEXT,
        ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS active_until TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);
    await pool.query(`
        UPDATE users
        SET is_active = TRUE
        WHERE is_active IS NULL
    `);

    await pool.query(`
        ALTER TABLE users
        ADD CONSTRAINT users_role_check
        CHECK (role IN ('admin', 'manager', 'user', 'worker'))
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

    await ensurePendingQuestionsSchema();

    await pool.query(`
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    `);

    await pool.query(`
        INSERT INTO app_settings (key, value)
        VALUES ('non_admin_login_alert_enabled', 'true')
        ON CONFLICT (key) DO NOTHING
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
            is_saved BOOLEAN NOT NULL DEFAULT FALSE,
            session_name TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query(`
        ALTER TABLE results
        ADD COLUMN IF NOT EXISTS is_saved BOOLEAN NOT NULL DEFAULT FALSE
    `);
    await pool.query(`
        ALTER TABLE results
        ADD COLUMN IF NOT EXISTS session_name TEXT
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
        'CREATE INDEX IF NOT EXISTS idx_questions_module_course_source_id ON questions(module_id, course_id, source_id, id)',
        'CREATE INDEX IF NOT EXISTS idx_questions_module_id_id ON questions(module_id, id)',
        'CREATE INDEX IF NOT EXISTS idx_questions_course_id_id ON questions(course_id, id)',
        'CREATE INDEX IF NOT EXISTS idx_questions_source_id_id ON questions(source_id, id)',
        'CREATE INDEX IF NOT EXISTS idx_questions_created_at ON questions(created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_question_notes_q_u ON question_notes(question_id, user_id)',
        'CREATE INDEX IF NOT EXISTS idx_question_notes_user_updated ON question_notes(user_id, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_results_user_created ON results(user_id, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_results_user_mode_created ON results(user_id, mode, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_results_user_saved_created ON results(user_id, is_saved, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_sqr_session_qnum ON session_question_results(session_id, question_num)',
        'CREATE INDEX IF NOT EXISTS idx_sqr_question_session ON session_question_results(question_id, session_id)',
        'CREATE INDEX IF NOT EXISTS idx_sqr_session_question ON session_question_results(session_id, question_id)',
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

    await Promise.all(queries.map((q) => pool.query(q)));

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
        ADD COLUMN IF NOT EXISTS theme_preference TEXT NOT NULL DEFAULT 'system',
        ADD COLUMN IF NOT EXISTS question_limit INTEGER DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS hide_question_meta BOOLEAN NOT NULL DEFAULT FALSE
    `);
}

async function ensureAuthSchema() {
    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS session_id TEXT
    `);
}

async function ensureRequestedCourses() {
    const moduleRes = await pool.query('SELECT id, name FROM modules');
    const moduleByNormalizedName = new Map(
        moduleRes.rows.map((m) => [normalizeQuestionText(m.name), m.id])
    );

    const extras = [
        ['Biochimie', 'm\u00e9tabolisme du glycog\u00e8ne (M\u00e9tabolisme des glucides)'],
        ['Biochimie', 'glyolyse (M\u00e9tabolisme des glucides)'],
        ['Biochimie', 'cycle de krebs (M\u00e9tabolisme des glucides)'],
        ['Biochimie', 'cycle de pentose phosphate (M\u00e9tabolisme des glucides)'],
        ['H\u00e9mobiologie', 'Les an\u00e9mies h\u00e9molytiques h\u00e9r\u00e9ditaires par anomalie de l\u2019h\u00e9moglobine'],
        ['H\u00e9mobiologie', 'Effets ind\u00e9sirables de la transfusion'],
        ['Biophysique', 'Osmose'],
        ['Pharmacie gal\u00e9nique', 'Dessiccation \u2013 Lyophilisation'],
        ['Pharmacie gal\u00e9nique', 'M\u00e9lange des poudres'],
        ['Pharmacie gal\u00e9nique', 'Granulation des poudres'],
        ['Pharmacie gal\u00e9nique', 'Formes pharmaceutiques destin\u00e9es aux autres voies d\u2019administration (nasale, auriculaire et vaginale)'],
        ['Pharmacie gal\u00e9nique', 'Stabilit\u00e9'],
        ['Pharmacie gal\u00e9nique', 'Pommades, cr\u00e8mes et gels'],
        ['Pharmacie gal\u00e9nique', 'Dispositifs m\u00e9dicaux : Articles de pansement'],
        ['Toxicologie', 'Substances dopantes'],
        ['Toxicologie', 'Cyanure'],
        ['Toxicologie', 'Ethers de glycol'],
        ['Toxicologie', 'Pesticides pyr\u00e9thrino\u00efdes'],
        ['Toxicologie', 'Contaminants alimentaires']
    ];

    for (const [moduleName, courseName] of extras) {
        const moduleId = moduleByNormalizedName.get(normalizeQuestionText(moduleName));
        if (!moduleId) continue;
        await pool.query(
            `INSERT INTO courses (name, module_id)
             SELECT $1, $2
             WHERE NOT EXISTS (
               SELECT 1 FROM courses WHERE module_id = $2 AND lower(name) = lower($1)
             )`,
            [courseName, moduleId]
        );
    }
}

module.exports = {
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
};
