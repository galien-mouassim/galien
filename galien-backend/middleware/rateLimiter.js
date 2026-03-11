function createRateLimiter({ windowMs, max, keyFn }) {
    const hits = new Map();

    setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits.entries()) {
            if (entry.resetAt <= now) hits.delete(key);
        }
    }, Math.max(30000, Math.floor(windowMs / 2))).unref();

    return (req, res, next) => {
        const now = Date.now();
        const key = keyFn(req);
        if (!key) return next();

        let entry = hits.get(key);
        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + windowMs };
        }

        entry.count += 1;
        hits.set(key, entry);

        if (entry.count > max) {
            const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
            res.setHeader('Retry-After', String(retryAfterSec));
            return res.status(429).json({ message: 'Too many requests, please retry later.' });
        }

        return next();
    };
}

const apiLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 300,
    keyFn: (req) => req.ip || req.socket?.remoteAddress || 'unknown'
});

const loginLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 15,
    keyFn: (req) => {
        const ip = req.ip || req.socket?.remoteAddress || 'unknown';
        const email = String(req.body?.email || '').toLowerCase().trim();
        return `${ip}:${email || 'no-email'}`;
    }
});

module.exports = { createRateLimiter, apiLimiter, loginLimiter };
