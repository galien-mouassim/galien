const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/database');
const { loginLimiter } = require('../middleware/rateLimiter');
const { notifyAdminsOfNonAdminLogin } = require('../lib/notifications');

router.post('/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body || {};

    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ message: 'Utilisateur introuvable' });
        }

        const user = result.rows[0];
        // Expired accounts cannot log in at all.
        if (user.active_until && new Date(user.active_until).getTime() <= Date.now()) {
            return res.status(403).json({ message: 'Compte expire. Contactez un administrateur.' });
        }
        // Deactivated non-user roles (admin/manager/worker) cannot log in.
        // Deactivated "user" accounts can log in but will have restricted access.
        if (user.is_active === false && user.role !== 'user') {
            return res.status(403).json({ message: 'Compte desactive. Contactez un administrateur.' });
        }

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

        // Fire-and-forget admin notification when a non-admin account logs in.
        setImmediate(() => {
            notifyAdminsOfNonAdminLogin({ user, req }).catch(() => {});
        });

        res.json({
            token,
            role: user.role,
            is_active: user.is_active !== false
        });

    } catch (err) {
        const msg = err?.message || String(err) || 'Login failed';
        console.error('[LOGIN_ERROR]', msg, err?.code || '');
        res.status(500).json({ error: msg });
    }
});

module.exports = router;
