require('dotenv').config();
const { Pool } = require('pg');

const hasUrl = !!process.env.DATABASE_URL;
const poolConfig = hasUrl
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
        connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 6000),
        idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 10000)
    }
    : {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_DATABASE,
        password: process.env.DB_PASSWORD,
        port: Number(process.env.DB_PORT || 5432),
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 6000),
        idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 10000)
    };

const pool = new Pool(poolConfig);

// Some managed databases can default to an empty search_path.
// Force the app to use the public schema for unqualified table names.
pool.on('connect', (client) => {
    client.query('SET search_path TO public').catch(() => {});
    const statementTimeoutMs = Number(process.env.DB_STATEMENT_TIMEOUT_MS || 15000);
    if (Number.isFinite(statementTimeoutMs) && statementTimeoutMs > 0) {
        client.query(`SET statement_timeout TO ${statementTimeoutMs}`).catch(() => {});
    }
});

module.exports = pool;
