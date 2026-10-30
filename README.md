# Daraja Mini App

A small Express app for learning the Safaricom Daraja API. It has a one-page web UI that:

1. Sends an **M-Pesa STK Push** (the PIN prompt on the customer's phone).
2. Receives the payment result on a **callback URL**.
3. Looks up a payment with the **Transaction Status Query** API.

This is a learning project, not a production payment system. See [Limitations](#limitations).

## How it works

### STK Push

```
Browser --POST /api/stkpush--> Your server --> Safaricom
                                                  |
                               PIN prompt on the customer's phone
                                                  |
Safaricom --POST /api/callback--> Your server (paid / cancelled / failed)
```

A successful response from `/api/stkpush` only means Safaricom **accepted the request**. Whether the customer actually paid arrives later at `/api/callback`.

### Transaction Status Query

```
Browser --POST /api/transaction-status--> Your server --> Safaricom ("accepted")
Safaricom --POST /api/transaction-status/result--> Your server (the real answer)
Browser --GET /api/transaction-status/result/:id--> polls until the answer arrives
```

This API is also asynchronous, so the server stores the result when it arrives and the page polls for it.

## Project structure

```
my-daraja-app/
├── public/
│   └── index.html     # UI: STK Push card + Check Transaction Status card
├── server.js          # Express server and all Daraja calls
├── package.json
├── .env               # Your secrets (not committed)
└── .gitignore
```

## Requirements

- Node.js 18 or newer (the server uses the built-in `fetch`)
- A Safaricom Daraja developer account with a sandbox app
- [ngrok](https://ngrok.com) (or a similar tunnel) so Safaricom can reach your local server

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create a `.env` file

```
CONSUMER_KEY=your_consumer_key
CONSUMER_SECRET=your_consumer_secret
BUSINESS_SHORTCODE=174379
PASSKEY=your_sandbox_passkey
CALLBACK_URL=https://your-ngrok-domain.ngrok-free.dev/api/callback

# Only needed for the Transaction Status card
INITIATOR_NAME=testapi
SECURITY_CREDENTIAL=your_encrypted_initiator_password

PORT=3000
```

| Variable | Where to get it |
|---|---|
| `CONSUMER_KEY`, `CONSUMER_SECRET` | Your app in the Daraja portal |
| `BUSINESS_SHORTCODE`, `PASSKEY` | Lipa na M-Pesa Online page, "Test Credentials" section |
| `CALLBACK_URL` | Your public ngrok URL plus `/api/callback` |
| `INITIATOR_NAME` | Sandbox test initiator name shown in the portal (`testapi`) |
| `SECURITY_CREDENTIAL` | The initiator password encrypted with Safaricom's sandbox certificate. Generate it with the Security Credential tool in the Daraja portal |

Keep `.env` out of git. It is already listed in `.gitignore`. Never share your consumer secret, passkey, or security credential.

### 3. Start a tunnel

Safaricom cannot call `localhost`, so expose your server:

```bash
ngrok http 3000
```

Copy the HTTPS forwarding URL into `CALLBACK_URL` (keep the `/api/callback` ending). The Transaction Status result and timeout URLs are derived from this value automatically.

### 4. Run the server

```bash
node server.js
```

Open `http://localhost:3000`. Restart the server any time you change `.env`, because `dotenv` only reads it at startup.

## Using the app

### Send an STK Push

1. Enter a phone number (`0712345678`, `712345678`, `+254712345678`, and `254712345678` all work) and an amount.
2. Click **Pay Now**.
3. Enter your M-Pesa PIN on the phone.
4. Watch the server terminal. The callback prints either a `PAID:` line with the receipt number, amount, and phone, or a `NOT PAID` line with a result code.

### Check a transaction

1. Enter a 10-character M-Pesa receipt number.
2. Click **Check Status**.
3. The page shows the result when Safaricom delivers it, or an error message with its result code.

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/stkpush` | Body `{ phone, amount }`. Starts an STK Push |
| POST | `/api/callback` | Safaricom posts the STK Push result here |
| POST | `/api/transaction-status` | Body `{ transactionId }`. Sends a status query |
| POST | `/api/transaction-status/result` | Safaricom posts the query result here |
| POST | `/api/transaction-status/timeout` | Safaricom posts here if the query times out |
| GET | `/api/transaction-status/result/:id` | The browser polls this for the result |

## Common result codes (STK Push callback)

| Code | Meaning |
|---|---|
| `0` | Payment successful |
| `1` | Insufficient funds |
| `1032` | Cancelled by the user |
| `1037` | Prompt timed out (no response from the phone) |

## Notes from testing

- **Use small amounts.** In our testing, the sandbox STK Push produced a real PIN prompt and a real M-Pesa SMS, and the payment was deducted from the wallet. Keep the amount at `1` KES.
- **Transaction Status returned code `2032`** ("The transaction receipt number does not exist") for the receipt we tried. That still proves the whole round trip works (OAuth, credentials, query, result URL, and polling). The sandbox's lookup may not find receipts from payments made through the STK Push, so treat this API as something to fully test against production.
- **The success message after Pay Now is not proof of payment.** Only the callback is.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Missing ... in .env` at startup | Add the variable to `.env` and restart |
| `INITIATOR_NAME and SECURITY_CREDENTIAL are missing` | Add both to `.env` and restart the server |
| Callback never appears in the terminal | Check that ngrok is running and that `CALLBACK_URL` matches the current ngrok URL exactly |
| `ERR_NGROK_334` (endpoint already online) | An old ngrok session is still running. Stop it with `Ctrl+C` in its terminal, end it from the ngrok dashboard (Agents), or start with `--pooling-enabled` |
| `OAuth failed (HTTP 400/401)` | Check `CONSUMER_KEY` and `CONSUMER_SECRET` |
| Port already in use | Stop the other process on port 3000 or change `PORT` |

## Limitations

This project is for learning. Before handling real money you would need at least:

- **Authentication** on every endpoint. Right now anyone who can reach the server can trigger payments.
- **Callback verification.** Daraja callbacks are not signed. Use a secret token in the callback path, an IP allowlist, and confirm results through the API.
- **A database.** Transaction Status results are kept in memory and are lost when the server restarts. Payment results from `/api/callback` are only logged, not stored.
- **Idempotency.** Safaricom can retry callbacks, so processing must be safe to repeat.
- **Token caching.** A new OAuth token is requested for every call.
- **Production credentials and certificate.** Switch `SANDBOX_URL` to `https://api.safaricom.co.ke` and generate the security credential with the production certificate.

## Next steps

- Store the `CheckoutRequestID` from each STK Push, and save the callback result against it.
- Add the **STK Push Query** API (`/mpesa/stkpushquery/v1/query`), which checks a push by its `CheckoutRequestID` and answers immediately. It is the standard way to recover from a dropped callback.
- Move the in-memory store to a database.
- Add B2C and C2B (Paybill/Till) flows once the STK Push basics are clear.

## Tech

Node.js, Express, dotenv, and plain HTML/CSS/JavaScript for the frontend.