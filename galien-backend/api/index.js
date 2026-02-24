const serverless = require('serverless-http');
const { app, initApp } = require('../server');

const handler = serverless(app);

module.exports = async (req, res) => {
    await initApp();
    return handler(req, res);
};

