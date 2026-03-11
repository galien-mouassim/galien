const METADATA_CACHE_TTL_MS = Number(process.env.METADATA_CACHE_TTL_MS || 60000);
const USER_ANALYTICS_CACHE_TTL_MS = Number(process.env.USER_ANALYTICS_CACHE_TTL_MS || 20000);
const metadataCache = new Map();

function cacheGet(key) {
    const item = metadataCache.get(key);
    if (!item) return null;
    if (item.expiresAt <= Date.now()) {
        metadataCache.delete(key);
        return null;
    }
    return item.payload;
}

function cacheSet(key, payload, ttlMs = METADATA_CACHE_TTL_MS) {
    metadataCache.set(key, { payload, expiresAt: Date.now() + ttlMs });
}

function invalidateMetadataCache() {
    metadataCache.clear();
}

function invalidateUserAnalyticsCache(userId) {
    if (!userId) return;
    const uid = Number(userId);
    metadataCache.delete(`user:stats:${uid}`);
    metadataCache.delete(`user:analytics:${uid}`);
}

module.exports = {
    cacheGet,
    cacheSet,
    invalidateMetadataCache,
    invalidateUserAnalyticsCache,
    USER_ANALYTICS_CACHE_TTL_MS
};
