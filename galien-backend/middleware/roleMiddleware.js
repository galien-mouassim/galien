function requireAdmin(req, res, next) {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ message: 'Forbidden' });
    }
    return next();
}

function requireAdminOrManager(req, res, next) {
    const role = req.user?.role;
    if (role !== 'admin' && role !== 'manager') {
        return res.status(403).json({ message: 'Forbidden' });
    }
    return next();
}

function requireAdminOrWorker(req, res, next) {
    const role = req.user?.role;
    if (role !== 'admin' && role !== 'manager' && role !== 'worker') {
        return res.status(403).json({ message: 'Forbidden' });
    }
    return next();
}

module.exports = { requireAdmin, requireAdminOrManager, requireAdminOrWorker };
