'use strict';
const app = require('./app');
const config = require('./config');
const { ensureFirstAdmin } = require('./lib/bootstrap');

ensureFirstAdmin();

app.listen(config.port, () => {
  console.log(`Car Renter running on port ${config.port}`);
});
