const jwt = require('jsonwebtoken'); 
const pool = require('../config/database');

async function authMiddleware(req, res, next) {
    const authHeader = req.headers['authorization'];

    if (!authHeader) {
        return res.status(401).json({ message: 'No token provided' });
    }

    // Supporte "Bearer TOKEN"
    const token = authHeader.startsWith('Bearer ')
        ? authHeader.split(' ')[1]
        : authHeader;

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.sid) {
            return res.status(401).json({ message: 'Session invalide, reconnectez-vous' });
        }

        const result = await pool.query(
            'SELECT session_id FROM users WHERE id = $1',
            [decoded.id]
        );

        if (!result.rows.length || result.rows[0].session_id !== decoded.sid) {
            return res.status(401).json({ message: 'Session expirée (connexion sur un autre appareil)' });
        }

        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ message: 'Invalid token' });
    }
}

module.exports = authMiddleware;
