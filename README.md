# iCash — Enterprise Biometric Banking Platform

A high-security, full-stack biometric digital banking platform built with **Node.js, Express.js, PostgreSQL, Prisma ORM, Argon2/Bcrypt credential hashing, secure HTTP-only session management, Appwrite Cloud SDK, FaceAPI.js biometric neural vectors, and Python Flask OpenCV + dlib Real-Time Anti-Spoofing Liveness Detection**.

---

## 🏛️ System Architecture

```text
                    ┌────────────────────────────────────────────────────────┐
                    │                 iCash Web Application                  │
                    │        (HTML5 / Vanilla CSS / Three.js Canvas)         │
                    └───────────┬───────────────────────────────┬────────────┘
                                │ HTTPS                         │ WebSocket / HTTP
                                ▼                               ▼
        ┌───────────────────────────────────┐    ┌───────────────────────────────────┐
        │      Express REST API Gateway     │    │  Python Liveness Detection Server │
        │ (Helmet, Rate Limit, CORS, Auth)  │    │      (OpenCV + dlib 68-EAR)       │
        └───────────────┬───────────────────┘    └─────────────────┬─────────────────┘
                        │                                          │ Real-time Frame
                        │                                          │ Eye-Blink State
         ┌──────────────┼──────────────┬──────────────┐            ▼
         ▼              ▼              ▼              ▼    ┌─────────────────────────┐
┌────────────────┐ ┌──────────┐ ┌────────────┐ ┌─────────┐ │  Anti-Spoofing Engine  │
│ Authentication │ │ Accounts │ │Transactions│ │Biometric│ │  (Photo/Screen Spoof    │
│(JWT & Cookies, │ │ (Multi-  │ │  (Transfers│ │ Vector  │ │   Rejection Guard)      │
│ Bcrypt Hashing)│ │  Portfolio││   & POS)   │ │ Engine) │ └─────────────────────────┘
└────────┬───────┘ └────┬─────┘ └──────┬─────┘ └───┬─────┘
         │              │              │           │
         └──────────────┴──────┬───────┴───────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │          Prisma ORM          │
                │   (Atomic ACID Transactions) │
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │     PostgreSQL Database      │
                │  (Users, Accounts, Balances, │
                │   Transactions, Audit Logs)  │
                └──────────────────────────────┘
```

---

## 🚀 Key Features

### 1. 👁️ Biometric Authentication & Real-Time Liveness (Anti-Spoofing)

- **128D Neural Face Vectors**: Fast, client-side neural descriptor extraction using MobileNet/SSD Mobilenet via `face-api.js`.
- **OpenCV + dlib Real-Time Blink Liveness Server**: Dedicated Python microservice running on port `5001`. Calculates **Eye Aspect Ratio (EAR)** on streaming video frames (`open -> closed -> open`), blocking photo/screen replay spoofing.
- **Multi-Face Guard**: Automatically alerts and halts transactions if multiple faces appear in the camera frame.
- **Resilient Fallbacks**: If the camera is unavailable or the Python server is offline, securely falls back to PIN authentication or on-device landmark analysis.

### 2. 🔐 Multi-Tier Security & Compliance

- **Cryptographic Credential Security**: Passwords and PINs are hashed using **bcrypt / Argon2** (12 rounds). Plaintext credentials and raw Aadhaar numbers are **never** stored.
- **Masked Aadhaar Privacy (UIDAI Principle)**: Compliant with data minimization standards by storing only `aadhaar_last4`, `aadhaar_verified`, and a cryptographic hash.
- **Emergency Duress Protocol**: Entering a registered emergency PIN unlocks the account while covertly dispatching a `DURESS_ALERT` security event with `CRITICAL` severity to the audit log.
- **Automatic Account Lockout**: Accounts are automatically locked after 5 consecutive failed PIN attempts.

### 3. 💳 Digital Banking & Portfolio Management

- **Multi-Account Portfolios**: Create, link, view, and manage multiple savings, current, and digital wallets with instant primary account switching.
- **ACID Atomic Transfers**: Instant money transfers executed in isolated database transactions (`prisma.$transaction`) with balance validations and idempotency checks.
- **Point of Sale (POS) Billing**: Dynamic checkout references with real-time merchant invoice tracking.
- **Senior Assisted Banking**: Registered senior citizens can delegate withdrawal privileges to designated relatives using dynamic 5-minute time-bound OTPs.
- **Permanent Account Deletion ("Delete Account")**: Self-service danger zone feature in Settings & Profile requiring 4-digit PIN re-verification to perform a permanent cascading deletion of personal records and balances.

### 4. ☁️ Appwrite Cloud SDK Integration

- Integrated `appwrite` SDK (`frontend/lib/appwrite.js`) connected to Appwrite Cloud (`https://sfo.cloud.appwrite.io/v1`, Project ID: `6a89af3a00114ef8b001`).
- Automatic client verification ping (`client.ping()`) upon app launch.

---

## 📁 Project Structure

```text
iCash/
├── frontend/                     # Modern Vanilla Web Application
│   ├── index.html                # User, Merchant & Admin portal interface
│   ├── script.js                 # UI controller, routing & state management
│   ├── biometric.js              # Real-time face scanner & liveness frame streamer
│   ├── api.js                    # Centralized REST API & Liveness client
│   ├── lib/
│   │   └── appwrite.js           # Appwrite Web SDK client configuration
│   └── style.css                 # Dark-mode aesthetic banking design system
├── backend/                      # Node.js & Express REST Backend
│   ├── src/
│   │   ├── controllers/          # Auth, Accounts, Transactions, Biometric controllers
│   │   ├── routes/               # REST API route definitions
│   │   ├── middleware/           # Auth, RBAC, Rate-limiting, Zod Validation
│   │   ├── services/             # Atomic business logic, SMS provider & queries
│   │   ├── utils/                # Token signing, Bcrypt, and Zod schemas
│   │   ├── prisma.js             # Prisma ORM singleton instance
│   │   └── server.js             # Express application entrypoint
│   ├── prisma/
│   │   ├── schema.prisma         # Relational database models
│   │   └── seed.js               # Initial administrative database seeder
│   ├── tests/                    # Jest + Supertest automated test suites
│   ├── docker-compose.yml        # PostgreSQL container setup
│   └── package.json
├── liveness_server/              # Python OpenCV + dlib Liveness Microservice
│   ├── app.py                    # Flask server with EAR eye-blink detection (Port 5001)
│   ├── download_model.py         # Automated downloader for dlib 68-point landmarks
│   ├── decompress.py             # BZ2 decompression helper
│   ├── requirements.txt          # Python dependencies (flask, opencv, dlib, scipy)
│   └── shape_predictor_68_face_landmarks.dat # 68-point facial landmarks model
├── package.json                  # Root scripts (build, dev, test, liveness)
└── README.md
```

---

## 🛠️ Setup & Running

### 1. Prerequisites

- **Node.js** >= 18.0
- **Python** >= 3.10
- **PostgreSQL** or Docker (for database)

---

### 2. Install Dependencies

#### Node.js Dependencies:

```bash
npm install
cd backend && npm install && cd ..
```

#### Python Liveness Server Dependencies:

```bash
pip install -r liveness_server/requirements.txt
```

---

### 3. Database Setup

1. Start PostgreSQL (or run Docker Compose):

```bash
cd backend
docker compose up -d
```

2. Initialize and push schema:

```bash
npm run prisma:push
npm run prisma:seed
```

---

### 4. Running the Servers

#### A. Start the Banking Application (Frontend + Express API):

```bash
npm run dev
# App will run on http://localhost:4000
```

#### B. Start the Real-Time Liveness Detection Server:

```bash
npm run liveness
# or: python liveness_server/app.py
# Liveness Microservice will run on http://localhost:5001
```

---

## 🧪 Automated Testing

Run the full backend automated test suite:

```bash
npm test
```

### Test Coverage Includes:

- **`tests/auth.test.js`**: User registration, duplicate prevention, Aadhaar lookup, PIN login, emergency duress alert logging, 5-attempt brute-force lockout, and PIN-confirmed permanent account deletion.
- **`tests/accounts.test.js`**: Account portfolio creation, primary account switching, multi-tenant deletion boundaries.
- **`tests/transactions.test.js`**: Atomic balance deductions, instant deposits, insufficient balance guard, statement queries.
- **`tests/security.test.js`**: Rate-limiting, multi-face alerts, audit log validation.
- **`tests/rbac.test.js`**: Role-based access enforcement for User, Merchant, and Admin routes.

---

## 📡 REST API Reference

### Authentication & Identity (`/api/auth`)

| Method   | Endpoint                  | Description                                       | Auth      |
| :------- | :------------------------ | :------------------------------------------------ | :-------- |
| `POST`   | `/api/auth/register`      | Register new user with masked Aadhaar             | Public    |
| `POST`   | `/api/auth/login-aadhaar` | Lookup account by last 4 digits of Aadhaar        | Public    |
| `POST`   | `/api/auth/login-pin`     | Login with PIN (Standard or Duress Emergency PIN) | Public    |
| `POST`   | `/api/auth/logout`        | Terminate session and clear HTTP-only cookies     | Protected |
| `GET`    | `/api/auth/me`            | Fetch authenticated profile and linked accounts   | Protected |
| `DELETE` | `/api/auth/me`            | Permanently delete account (Requires 4-digit PIN) | Protected |

### Accounts (`/api/accounts`)

| Method   | Endpoint            | Description                             | Auth      |
| :------- | :------------------ | :-------------------------------------- | :-------- |
| `GET`    | `/api/accounts`     | List user's linked bank accounts        | Protected |
| `POST`   | `/api/accounts`     | Link new bank account                   | Protected |
| `PATCH`  | `/api/accounts/:id` | Update account or toggle primary status | Protected |
| `DELETE` | `/api/accounts/:id` | Unlink bank account                     | Protected |

### Transactions & POS (`/api/transactions`)

| Method | Endpoint                              | Description                                  | Auth      |
| :----- | :------------------------------------ | :------------------------------------------- | :-------- |
| `GET`  | `/api/transactions`                   | Filter and paginate user transaction history | Protected |
| `POST` | `/api/transactions`                   | Execute atomic fund transfer                 | Protected |
| `POST` | `/api/transactions/topup`             | Instant demo wallet top-up                   | Protected |
| `POST` | `/api/transactions/delegate/generate` | Generate senior citizen withdrawal OTP       | Protected |
| `POST` | `/api/transactions/delegate/claim`    | Disburse delegated cash withdrawal           | Public    |

### Liveness Detection Microservice (`http://localhost:5001`)

| Method | Endpoint           | Description                                      |
| :----- | :----------------- | :----------------------------------------------- |
| `GET`  | `/health`          | Health status and active sessions                |
| `POST` | `/liveness/start`  | Initialize a new liveness session                |
| `POST` | `/liveness/frame`  | Analyze video frame and compute Eye Aspect Ratio |
| `GET`  | `/liveness/status` | Query verification state (`live: true/false`)    |
| `POST` | `/liveness/reset`  | Terminate session and clean up memory            |

---

## 🔒 Security Best Practices Implemented

1. **Zero Secret Leakage**: `password_hash`, `pin_hash`, and `emergency_pin_hash` are stripped from all API responses via Zod schemas and service interceptors.
2. **HTTP-only Cookie Authentication**: Session tokens are transmitted via `HttpOnly`, `SameSite=Lax` cookies, preventing XSS token harvesting.
3. **Database Cascading Deletion**: Account deletion completely purges all sensitive biometric descriptors, accounts, and session data in atomic transactions.
4. **Anti-Replay Liveness Guard**: Real-time eye-blink tracking protects against printed photos, videos, and screen spoofing.

---

## 📄 License

MIT License. Developed for enterprise biometric banking and financial digital security.