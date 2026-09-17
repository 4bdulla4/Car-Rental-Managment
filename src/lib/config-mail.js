'use strict';
require('dotenv').config();

module.exports = {
  apiKey: process.env.RESEND_API_KEY || '',
  from: process.env.MAIL_FROM || '',
  // Absolute URLs are needed in email, where a relative path means nothing.
  baseUrl: (process.env.APP_URL || '').replace(/\/+$/, '')
};
