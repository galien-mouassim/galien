const pool = require('./database');
const bcrypt = require('bcryptjs');

async function resetAdmin() {
    const email = 'admin@galien.com';
    const password = 'admin123';
    const hash = await bcrypt.hash(password, 10);

    try {
        const result = await pool.query(
            'UPDATE users SET password=$1 WHERE email=$2',
            [hash, email]
        );
        console.log('✅ Admin password reset');
        process.exit(0);
    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    }
}

resetAdmin();
