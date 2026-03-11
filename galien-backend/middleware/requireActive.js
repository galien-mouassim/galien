function requireActive(req, res, next) {
    if (req.user && req.user.is_active === false) {
        return res.status(403).json({ message: 'Compte desactive. Acces aux QCMs non disponible.' });
    }
    next();
}

module.exports = requireActive;
