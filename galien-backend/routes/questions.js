const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');

// Example route
router.get('/', authMiddleware, (req, res) => {
    res.json({ message: 'Questions API placeholder' });
});

module.exports = router;
