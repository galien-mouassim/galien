require('dotenv').config();
const { Pool } = require('pg');

const hasUrl = !!process.env.DATABASE_URL;
const poolConfig = hasUrl
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
    }
    : {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_DATABASE,
        password: process.env.DB_PASSWORD,
        port: Number(process.env.DB_PORT || 5432),
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
    };

const pool = new Pool(poolConfig);

// Some managed databases can default to an empty search_path.
// Force the app to use the public schema for unqualified table names.
pool.on('connect', (client) => {
    client.query('SET search_path TO public').catch(() => {});
});

pool.connect()
    .then(() => console.log('✅ PostgreSQL connected successfully'))
    .catch(err => console.error('❌ PostgreSQL connection failed', err));

module.exports = pool;
