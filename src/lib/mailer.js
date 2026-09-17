'use strict';
const config = require('./config-mail');

/**
 * Sends mail through Resend's HTTP API, which needs no dependency and works on
 * serverless, where a long-lived SMTP connection does not.
 *
 * Email is optional: with no API key the app still produces a signing link for
 * the contract, which can be sent by any other means.
 */
function isConfigured() {
  return Boolean(config.apiKey && config.from);
}

async function send({ to, subject, html, text }) {
  if (!isConfigured()) {
    return { sent: false, reason: 'Email is not configured — set RESEND_API_KEY and MAIL_FROM.' };
  }
  if (!to) return { sent: false, reason: 'That customer has no email address on file.' };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.from, to: [to], subject, html, text })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // The provider's message is useful to an admin but must not leak the key.
    const detail = body.slice(0, 200).replace(config.apiKey, '<redacted>');
    return { sent: false, reason: `The mail provider refused the message (${res.status}). ${detail}` };
  }
  return { sent: true };
}

module.exports = { send, isConfigured, from: () => config.from };
