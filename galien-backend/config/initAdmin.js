const pool = require('./database');
const bcrypt = require('bcryptjs');

async function initAdmin() {
    try {
        const email = 'admin@galien.com';
        const password = 'admin123';

        const hash = await bcrypt.hash(password, 10);

        const exists = await pool.query(
            'SELECT id FROM users WHERE email = $1',
            [email]
        );

        if (exists.rows.length === 0) {
            await pool.query(
                'INSERT INTO users (email, password, role) VALUES ($1, $2, $3)',
                [email, hash, 'admin']
            );
            console.log('✅ Admin user created');
        } else {
            console.log('ℹ️ Admin user already exists');
        }
    } catch (err) {
        console.error('❌ Error creating admin:', err.message);
    }
}

module.exports = initAdmin;
