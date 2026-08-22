# iCash — Enterprise Biometric Banking Platform

A high-security, full-stack biometric digital banking platform built with **Node.js, Express.js, PostgreSQL, Prisma ORM, Argon2/Bcrypt credential hashing, secure HTTP-only session management, and multi-face anti-spoofing anomaly detection**.

---

## 🏛️ System Architecture

```text
                    ┌────────────────────────────────┐
                    │     iCash Web Application      │
                    │  (HTML5 / CSS / Three.js UI)   │
                    └───────────────┬────────────────┘
                                    │ HTTPS (Credentials: include)
                                    ▼
                    ┌────────────────────────────────┐
                    │      Express REST API Layer    │
                    │  (Helmet, Rate Limit, CORS)    │
                    └───────────────┬────────────────┘
                                    │
         ┌──────────────────────────┼──────────────────────────┐
         ▼                          ▼                          ▼
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│  Authentication  │      │ Biometric Engine │      │ Security Auditor │
│ (JWT & Cookies,  │      │ (Vector Distance │      │ (Duress Alarms,  │
│  Bcrypt Hashing) │      │  Verification)   │      │ Multi-Face Guard)│
└────────┬─────────┘      └────────┬─────────┘      └────────┬─────────┘
         │                         │                         │
         └─────────────────────────┼─────────────────────────┘
                                   │
                                   ▼
                    ┌────────────────────────────────┐
                    │           Prisma ORM           │
                    │    (Atomic ACID Operations)    │
                    └───────────────┬────────────────┘
                                    │
                                    ▼
                    ┌────────────────────────────────┐
                    │      PostgreSQL Database       │
                    │   (Users, Accounts, Balances,  │
                    │    Transactions, Audit Logs)   │
                    └────────────────────────────────┘
```

---

## 🚀 Key Features

- **Persistent Relational Database**: Zero reliance on browser storage for financial or identity records. Accounts, transactions, biometric profiles, and audit trails are persisted in PostgreSQL.
- **Server-Side Authentication**: Secure session cookies (`HttpOnly`, `SameSite: Lax`, `Secure`) and JWT verification middleware.
- **Cryptographic Credential Security**: Passwords, PINs, and emergency duress codes are hashed using **bcrypt / Argon2** (12 salt rounds). Plaintext credentials and raw Aadhaar numbers are **never** stored.
- **Masked Aadhaar Privacy**: Compliant with UIDAI privacy principles by persisting only `aadhaar_last4`, `aadhaar_verified`, and a cryptographic `aadhaar_reference`.
- **Biometric Verification Engine**: On-device facial feature extraction paired with server-side vector verification abstraction (`BiometricService` with pluggable providers).
- **Multi-Face Anti-Spoof Guard**: Automatically detects multiple people in the camera frame during sensitive operations and dispatches `MULTIPLE_FACE_DETECTED` security audit events.
- **Emergency Duress Alarm**: If forced to unlock under threat, entering a 4-digit emergency PIN triggers a covert `DURESS_ALERT` security event with `CRITICAL` severity while unlocking the portal.
- **Senior Citizen Assisted Banking**: Registered senior citizens can generate dynamic 5-minute authorization OTPs for designated trusted contacts to withdraw cash on their behalf.
- **Role-Based Access Control (RBAC)**: Enforced permission boundaries across **USER**, **MERCHANT**, and **ADMIN** roles.
- **ACID Financial Transactions**: PostgreSQL atomic transactions (`prisma.$transaction`) ensure consistency and prevent overdrafts or double-spending.

---

## 📁 Project Structure

```text
iCash/
├── frontend/
│   ├── index.html            # User, Merchant & Admin portal interfaces
│   ├── script.js             # UI controller wired to backend REST API
│   ├── api.js                # Centralized REST API client with cookie handling
│   └── style.css             # High-polish design system and responsive styles
├── backend/
│   ├── src/
│   │   ├── controllers/      # Route controllers (Auth, Accounts, Transactions, etc.)
│   │   ├── routes/           # REST API route definitions
│   │   ├── middleware/       # Auth, RBAC, Rate-limiting, Validation, Error Handling
│   │   ├── services/         # Business logic & atomic database services
│   │   ├── utils/            # Hashing, Token sign/verify, Zod schemas
│   │   ├── prisma.js         # Prisma client singleton
│   │   └── server.js         # Express app initialization & static asset serving
│   ├── prisma/
│   │   ├── schema.prisma     # Relational PostgreSQL schema
│   │   └── seed.js           # Database seeder for initial administrative accounts
│   ├── tests/                # Automated Jest / Supertest test suites
│   ├── docker-compose.yml    # PostgreSQL container definition
│   ├── .env                  # Environment configuration
│   ├── .env.example          # Environment template
│   └── package.json
├── package.json              # Root build & start scripts
└── README.md
```

---

## 🛠️ Setup & Installation

### Prerequisites

- **Node.js** >= 18.0
- **Docker Desktop** (for the PostgreSQL database container)

### 1. Configure Environment

Create `backend/.env` based on `backend/.env.example`:

```env
PORT=4000
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/icash?schema=public"
JWT_SECRET="your-secure-jwt-secret-key"
SESSION_SECRET="your-session-cookie-secret"
CORS_ORIGIN="http://localhost:5500,http://localhost:3000"
SMS_PROVIDER="console"
BIOMETRIC_PROVIDER="demo"
```

### 2. Start the Database

Start the PostgreSQL container (Docker Desktop must be running):

```bash
cd backend
docker compose up -d
```

Wait a few seconds for the container to become healthy, then verify:

```bash
docker compose ps
```

### 3. Install Dependencies & Push Schema

```bash
npm install
npx prisma db push
node prisma/seed.js
```

### 4. Start the Backend Server

```bash
npm run dev
```

Open **`http://localhost:4000`** in your browser.

### 5. Run Automated Test Suite

```bash
npm test
```

Runs 23 automated tests covering authentication, lockout policies, transaction atomicity, account isolation, RBAC, and security event triggers.

---

## 📡 REST API Documentation

### Authentication (`/api/auth`)

#### `POST /api/auth/register`

Registers a new customer profile in PostgreSQL with masked Aadhaar, hashes PINs with bcrypt, initializes a primary account, and sets an HTTP-only session cookie.

- **Request Body:**

```json
{
  "fullName": "Customer Name",
  "phone": "9823012345",
  "aadhaarNumber": "123456789012",
  "dob": "1998-04-12",
  "role": "USER",
  "pin": "1234",
  "emergencyPin": "9876",
  "descriptors": [[...]]
}
```

#### `POST /api/auth/login-aadhaar`

Looks up verified accounts matching the entered Aadhaar last 4 digits.

- **Request Body:** `{ "aadhaarLast4": "4821" }`

#### `POST /api/auth/login-pin`

Verifies user PIN, checks account lock status (locks after 5 failures for 15 minutes), handles covert duress alerts, and returns safe user data with a session cookie.

- **Request Body:** `{ "userId": "uuid", "pin": "1234" }`

#### `GET /api/auth/me` _(Protected)_

Returns the currently authenticated user's profile, primary account, and balance.

#### `POST /api/auth/logout` _(Protected)_

Revokes active server session and clears session cookie.

---

### Bank Accounts (`/api/accounts`)

#### `GET /api/accounts` _(Protected)_

Returns all active accounts owned by the authenticated user.

#### `POST /api/accounts` _(Protected)_

Links a new bank account or virtual card.

- **Request Body:**

```json
{
  "bankName": "HDFC Digital Bank",
  "accountType": "SAVINGS",
  "initialBalance": 10000,
  "isPrimary": false
}
```

#### `PATCH /api/accounts/:id` _(Protected)_

Updates account details or sets as primary.

#### `DELETE /api/accounts/:id` _(Protected)_

Closes a non-primary linked account.

---

### Transactions (`/api/transactions`)

#### `GET /api/transactions` _(Protected)_

Returns user's transaction history from PostgreSQL.

#### `POST /api/transactions` _(Protected)_

Executes an atomic withdrawal, transfer, or deposit.

- **Request Body (ATM Withdrawal):**

```json
{
  "transactionType": "WITHDRAWAL",
  "amount": 2000,
  "description": "ATM cash withdrawal",
  "verifyMethod": "FACE"
}
```

- **Request Body (Transfer):**

```json
{
  "transactionType": "TRANSFER",
  "amount": 1500,
  "recipientName": "Recipient Name",
  "recipientUserId": "optional-user-uuid",
  "verifyMethod": "PIN"
}
```

#### `POST /api/transactions/topup` _(Protected)_

Deposits funds to primary account balance.

#### `POST /api/transactions/delegate/generate` _(Protected - Senior Citizen Only)_

Generates a dynamic 6-digit delegation OTP valid for 5 minutes.

- **Request Body:** `{ "amount": 3000 }`

#### `POST /api/transactions/delegate/claim` _(Public)_

Authorized contact claims funds using senior citizen's delegation OTP.

- **Request Body:**

```json
{
  "seniorName": "Account Holder Name",
  "otp": "123456"
}
```

---

### Biometrics (`/api/biometric`)

#### `POST /api/biometric/enroll` _(Protected)_

Saves 128D numeric facial descriptors to PostgreSQL.

#### `POST /api/biometric/verify`

Server-side Euclidean distance matching against registered template.

---

### Security & Audit (`/api/security`)

#### `GET /api/security/status` _(Protected)_

Returns active duress alerts, multi-face count, and lock status.

#### `POST /api/security/events`

Records security anomalies (`MULTIPLE_FACE_DETECTED`, `LOGIN_FAILED`, etc.) with IP and device user-agent.

---

### Admin Portal (`/api/admin` - Requires `role = ADMIN`)

- `GET /api/admin/users`: Lists all system users with status and total balances.
- `GET /api/admin/users/:id`: Detailed user audit view.
- `PATCH /api/admin/users/:id/status`: Change status (`ACTIVE`, `LOCKED`, `SUSPENDED`).
- `GET /api/admin/security-events`: Complete system security audit trail.
- `GET /api/admin/complaints`: User disputes table.
- `PATCH /api/admin/complaints/:id`: Update dispute status and resolution note.

---

### Merchant Portal (`/api/merchant` - Requires `role = MERCHANT`)

- `GET /api/merchant/profile`: Commercial profile, settled balance, pending balance.
- `POST /api/merchant/payment-requests`: Generates dynamic POS billing codes.
- `GET /api/merchant/settlements`: Settlement batch history.
- `POST /api/merchant/refunds`: Issues refunds on transactions.

---

## 🔒 Security Summary

1. **Strict User Isolation**: User A can never read, modify, or withdraw from User B's accounts.
2. **PostgreSQL Atomic Transactions**: Ensures zero financial inconsistency during concurrent requests.
3. **Covert Duress Protection**: Protects users in coerced situations without tipping off bad actors.
4. **Anti-Brute Force**: 5 failed PIN attempts triggers an automatic 15-minute account lockout.
5. **No Plaintext Aadhaar**: Compliance with UIDAI privacy principles via irreversible reference hashing and masking.
