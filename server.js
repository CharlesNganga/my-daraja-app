/**
 * Daraja (M-Pesa) STK Push + Transaction Status demo server
 * ---------------------------------------------------------
 * STK Push flow:
 *   Browser -> POST /api/stkpush -> Safaricom (prompt appears on phone)
 *   Customer enters PIN on phone
 *   Safaricom -> POST /api/callback (your server) with the result
 *
 * Transaction Status flow (asynchronous):
 *   Browser -> POST /api/transaction-status -> Safaricom ("accepted")
 *   Safaricom -> POST /api/transaction-status/result (the real answer)
 *   Browser polls GET /api/transaction-status/result/:id until it arrives
 *
 * Requires Node 18+ (uses the built-in global fetch).
 * Install:  npm install express dotenv
 * Run:      node server.js
 */

require('dotenv').config(); // Load variables from .env into process.env
const express = require('express');
const path = require('path');

const {
  CONSUMER_KEY,
  CONSUMER_SECRET,
  BUSINESS_SHORTCODE,
  PASSKEY,
  CALLBACK_URL, // PUBLIC https URL, e.g. https://abc123.ngrok-free.app/api/callback
  INITIATOR_NAME,      // Only needed for Transaction Status (sandbox: testapi)
  SECURITY_CREDENTIAL, // Only needed for Transaction Status (encrypted initiator password)
  PORT = 3000,
} = process.env;

// Fail fast if a core value is missing, so you get a clear message
const required = { CONSUMER_KEY, CONSUMER_SECRET, BUSINESS_SHORTCODE, PASSKEY, CALLBACK_URL };
for (const [name, value] of Object.entries(required)) {
  if (!value) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
}

const SANDBOX_URL = 'https://sandbox.safaricom.co.ke';

// Your public base URL, derived from CALLBACK_URL
// (https://abc.ngrok-free.app/api/callback -> https://abc.ngrok-free.app)
const PUBLIC_BASE_URL = CALLBACK_URL.replace(/\/api\/callback\/?$/, '');

// In-memory store of Transaction Status results, keyed by OriginatorConversationID.
// Fine for learning; a real app would use a database.
const statusResults = new Map();

const app = express();

// Middleware: parse JSON bodies and serve the frontend from /public
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Get an OAuth access token from Safaricom.
 * Basic Auth = base64("consumerKey:consumerSecret").
 * Tokens last about 1 hour. For simplicity we request a fresh one each time;
 * a real app would cache it until shortly before it expires.
 */
async function getAccessToken() {
  const credentials = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');

  const response = await fetch(
    `${SANDBOX_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${credentials}` } }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OAuth failed (HTTP ${response.status}): ${text}`);
  }

  const data = await response.json();
  return data.access_token;
}

/**
 * Timestamp in YYYYMMDDHHmmss format, using Nairobi time (UTC+3).
 * Daraja is picky about this value, so we don't depend on the server's timezone.
 */
function getTimestamp() {
  const nairobi = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return nairobi.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/**
 * Convert 0712345678, 712345678, +254712345678 into 254712345678.
 * Returns null if the result is not a valid Kenyan mobile number.
 */
function normalizePhone(input) {
  let phone = String(input || '').replace(/\D/g, '');
  if (phone.startsWith('0')) phone = '254' + phone.slice(1);
  else if (phone.startsWith('7') || phone.startsWith('1')) phone = '254' + phone;
  return /^254[71]\d{8}$/.test(phone) ? phone : null;
}

// ===========================================================================
// STK PUSH
// ===========================================================================

// Trigger an STK Push (the PIN prompt on the customer's phone)
app.post('/api/stkpush', async (req, res) => {
  try {
    const { phone, amount } = req.body;

    // Basic input validation
    const msisdn = normalizePhone(phone);
    const numAmount = Math.round(Number(amount));
    if (!msisdn) {
      return res.status(400).json({ success: false, error: 'Invalid phone number. Use e.g. 0712345678.' });
    }
    if (!numAmount || numAmount < 1) {
      return res.status(400).json({ success: false, error: 'Amount must be at least 1.' });
    }

    const token = await getAccessToken();
    const timestamp = getTimestamp();

    // Password = base64(Shortcode + Passkey + Timestamp)
    const password = Buffer.from(BUSINESS_SHORTCODE + PASSKEY + timestamp).toString('base64');

    const payload = {
      BusinessShortCode: BUSINESS_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline', // Use 'CustomerBuyGoodsOnline' for a Till
      Amount: numAmount,
      PartyA: msisdn,                // Phone paying
      PartyB: BUSINESS_SHORTCODE,    // Shortcode receiving
      PhoneNumber: msisdn,           // Phone that gets the prompt
      CallBackURL: CALLBACK_URL,
      AccountReference: 'DarajaDemo', // Shows on the customer's M-Pesa message (max 12 chars)
      TransactionDesc: 'Demo payment',
    };

    const response = await fetch(`${SANDBOX_URL}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    // ResponseCode "0" only means Safaricom ACCEPTED the request.
    // It does NOT mean the customer has paid. The final result arrives at /api/callback.
    if (response.ok && data.ResponseCode === '0') {
      return res.json({ success: true, message: data.CustomerMessage, data });
    }

    console.error('STK push rejected:', data);
    return res.status(400).json({
      success: false,
      error: data.errorMessage || data.ResponseDescription || 'STK push failed',
      data,
    });
  } catch (err) {
    console.error('STK push error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Safaricom calls this URL with the final result of the payment
app.post('/api/callback', (req, res) => {
  console.log('--- M-Pesa callback received ---');
  console.log(JSON.stringify(req.body, null, 2));

  // Pull out the useful bits (shape: Body.stkCallback)
  const cb = req.body?.Body?.stkCallback;
  if (cb) {
    if (cb.ResultCode === 0) {
      // On success, CallbackMetadata.Item is an array of { Name, Value }
      const items = cb.CallbackMetadata?.Item || [];
      const get = (name) => items.find((i) => i.Name === name)?.Value;
      console.log('PAID:', {
        receipt: get('MpesaReceiptNumber'),
        amount: get('Amount'),
        phone: get('PhoneNumber'),
      });
    } else {
      // e.g. 1032 = cancelled by user, 1 = insufficient funds, 1037 = timed out
      console.log(`NOT PAID (code ${cb.ResultCode}): ${cb.ResultDesc}`);
    }
  }

  // Always acknowledge quickly so Safaricom stops retrying
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// ===========================================================================
// TRANSACTION STATUS QUERY (reconciliation)
// ===========================================================================

// 1. Ask Safaricom about a transaction by its M-Pesa receipt number
app.post('/api/transaction-status', async (req, res) => {
  try {
    const transactionId = String(req.body.transactionId || '').trim().toUpperCase();

    // M-Pesa receipt numbers are 10 uppercase letters/digits, e.g. LHD1234567
    if (!/^[A-Z0-9]{10}$/.test(transactionId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid receipt number. Expected 10 letters/digits, e.g. LHD1234567.',
      });
    }

    if (!INITIATOR_NAME || !SECURITY_CREDENTIAL) {
      return res.status(500).json({
        success: false,
        error: 'INITIATOR_NAME and SECURITY_CREDENTIAL are missing in .env.',
      });
    }

    const token = await getAccessToken();

    const payload = {
      Initiator: INITIATOR_NAME,
      SecurityCredential: SECURITY_CREDENTIAL, // initiator password, RSA-encrypted
      CommandID: 'TransactionStatusQuery',
      TransactionID: transactionId,
      PartyA: BUSINESS_SHORTCODE,
      IdentifierType: '4',                      // 4 = organization shortcode
      ResultURL: `${PUBLIC_BASE_URL}/api/transaction-status/result`,
      QueueTimeOutURL: `${PUBLIC_BASE_URL}/api/transaction-status/timeout`,
      Remarks: 'Status check',
      Occasion: 'Reconciliation',
    };

    const response = await fetch(`${SANDBOX_URL}/mpesa/transactionstatus/v1/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    // ResponseCode "0" = query accepted. The result itself arrives at ResultURL.
    if (response.ok && data.ResponseCode === '0') {
      return res.json({
        success: true,
        message: 'Query accepted. Waiting for Safaricom to send the result.',
        originatorConversationID: data.OriginatorConversationID,
      });
    }

    console.error('Transaction status rejected:', data);
    return res.status(400).json({
      success: false,
      error: data.errorMessage || data.ResponseDescription || 'Transaction status query failed',
    });
  } catch (err) {
    console.error('Transaction status error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Safaricom posts the actual query result here
app.post('/api/transaction-status/result', (req, res) => {
  console.log('--- Transaction status result ---');
  console.log(JSON.stringify(req.body, null, 2));

  const result = req.body?.Result;
  if (result) {
    // ResultParameter is an array of { Key, Value }; turn it into a plain object
    const params = result.ResultParameters?.ResultParameter || [];
    const details = Object.fromEntries(params.map((p) => [p.Key, p.Value]));

    statusResults.set(result.OriginatorConversationID, {
      success: result.ResultCode === 0,
      resultCode: result.ResultCode,
      resultDesc: result.ResultDesc,
      details,
    });
  }

  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// 3. Safaricom calls this if the query timed out in their queue
app.post('/api/transaction-status/timeout', (req, res) => {
  console.log('--- Transaction status TIMEOUT ---');
  console.log(JSON.stringify(req.body, null, 2));
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// 4. The browser polls this until the result has arrived
app.get('/api/transaction-status/result/:id', (req, res) => {
  const result = statusResults.get(req.params.id);
  if (!result) return res.json({ pending: true });
  res.json({ pending: false, ...result });
});

// ===========================================================================
// START SERVER
// ===========================================================================
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});