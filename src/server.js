'use strict';
const app = require('./app');
const config = require('./config');

app.listen(config.port, () => {
  console.log(`Car Renter running on http://localhost:${config.port}`);
});
