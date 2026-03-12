const jwt = require('jsonwebtoken');
const pool = require('../config/database');

const enforceSingleSession = String(process.env.ENFORCE_SINGLE_SESSION || '').toLowerCase() === 'true';

async function authMiddleware(req, res, next) {
    const authHeader = req.headers['authorization'];

    if (!authHeader) {
        return res.status(401).json({ message: 'No token provided' });
    }

    const token = authHeader.startsWith('Bearer ')
        ? authHeader.split(' ')[1]
        : authHeader;

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        let result;
        try {
            result = await pool.query(
                'SELECT session_id, is_active, active_until FROM users WHERE id = $1',
                [decoded.id]
            );
        } catch (dbErr) {
            // Backward compatibility for older DBs where these columns may not exist yet.
            if (dbErr && dbErr.code === '42703') {
                const legacy = await pool.query(
                    'SELECT session_id FROM users WHERE id = $1',
                    [decoded.id]
                );
                result = {
                    rows: (legacy.rows || []).map((r) => ({
                        session_id: r.session_id,
                        is_active: true,
                        active_until: null
                    }))
                };
            } else {
                throw dbErr;
            }
        }

        if (!result.rows.length) {
            return res.status(401).json({ message: 'Utilisateur introuvable' });
        }

        if (enforceSingleSession) {
            if (!decoded.sid) {
                return res.status(401).json({ message: 'Session invalide, reconnectez-vous' });
            }
            if (result.rows[0].session_id !== decoded.sid) {
                return res.status(401).json({ message: 'Session expiree (connexion sur un autre appareil)' });
            }
        }

        if (result.rows[0].is_active === false && decoded.role !== 'user') {
            return res.status(403).json({ message: 'Compte desactive' });
        }
        const isExpired = !!(result.rows[0].active_until && new Date(result.rows[0].active_until).getTime() <= Date.now());
        if (isExpired && decoded.role !== 'user') {
            return res.status(403).json({ message: 'Compte expire' });
        }

        req.user = { ...decoded, is_active: result.rows[0].is_active !== false, is_expired: isExpired };
        next();
    } catch (err) {
        if (err && err.code && err.code !== '22P02') {
            console.error('[AUTH_MIDDLEWARE_ERROR]', err.code, err.message || err);
        }
        return res.status(401).json({ message: 'Invalid token' });
    }
}

module.exports = authMiddleware;
