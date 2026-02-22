const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Login route
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        );

        if (result.rows.length === 0)
            return res.status(400).json({ message: 'User not found' });

        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password);

        if (!valid)
            return res.status(400).json({ message: 'Wrong password' });

        const token = jwt.sign(
            { id: user.id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );

        res.json({ token, role: user.role });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;
