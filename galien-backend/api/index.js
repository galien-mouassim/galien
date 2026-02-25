const { app, initApp } = require('../server');

const initPromise = initApp().catch((err) => {
    console.error('Serverless init warning:', err.message);
});

module.exports = async (req, res) => {
    await initPromise;
    return app(req, res);
};
