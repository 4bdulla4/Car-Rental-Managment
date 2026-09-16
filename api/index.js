'use strict';
// Vercel serverless entry point. The Express app handles schema setup and the
// first-admin bootstrap on its first request after a cold start.
module.exports = require('../src/app');
