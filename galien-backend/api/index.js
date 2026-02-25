const serverless = require('serverless-http');
const { app, initApp } = require('../server');

const handler = serverless(app);

// Initialize schema/bootstrap in background so requests like /health
// are not blocked by startup work in serverless cold starts.
initApp().catch((err) => {
    console.error('Serverless init warning:', err.message);
});

module.exports = (req, res) => handler(req, res);
