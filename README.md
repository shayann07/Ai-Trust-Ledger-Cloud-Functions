# AI Trust Ledger (Cloud Functions Engine)

[![Platform](https://img.shields.io/badge/Platform-Firebase%20v2%20%2F%20GCP-FFCA28?logo=firebase&logoColor=black)](https://firebase.google.com/docs/functions)
[![Runtime](https://img.shields.io/badge/Runtime-Node.js%2020.x-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Database](https://img.shields.io/badge/Database-Cloud%20Firestore-FFA000?logo=firebase&logoColor=white)](https://firebase.google.com/docs/firestore)
[![Concurrency](https://img.shields.io/badge/Concurrency-p--limit%2050x-blue)](https://www.npmjs.com/package/p-limit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> High-throughput serverless financial settlement engine built with Firebase Cloud Functions v2, orchestrating daily ROI payouts, MLM referral tree calculations, plan expiration settlements, and idempotent batch processing.

---

## 📖 Overview

The **AI Trust Ledger Cloud Functions** repository houses the mission-critical financial settlement backend for the AI Trust Ledger ecosystem. Engineered using **Firebase Cloud Functions v2**, **Node.js**, and the **Firebase Admin SDK**, this system executes distributed, fault-tolerant batch accounting at midnight every night (Asia/Karachi timezone) while serving on-demand callable functions for graph tree traversals.

### System Responsibilities
- **Automated Daily Yield Accrual**: Calculates and credits daily ROI for active stock, forex, and medical investment contracts.
- **Capital Liquidation & Plan Expiration**: Automatically matures expired venture contracts, returning principal capital plus bonus yields to investor balances.
- **Hierarchical MLM Commission Traversal**: Traverses multi-tier affiliate trees to distribute downline performance bonuses according to dynamic Firestore configurations.
- **Idempotency & Concurrency Control**: Employs double-entry guard collections (`/dailyProfitLogs`, `/dailyTeamProfitLogs`) and semaphore concurrency throttling (`p-limit`) to prevent double-spending and contention errors.

---

## 🏗️ Architecture & Cron Execution Lifecycle

```mermaid
graph TD
    subgraph Schedulers & Triggers
        Cron[Cloud Scheduler: 00:00 Asia/Karachi]
        Callable[OnCall: computeTeamLevelsAndCreditProfit]
    end

    subgraph Orchestration Pipeline
        Phase1[Phase 1: Plan-Level Settlement\n50-way Concurrency]
        Phase2[Phase 2: Team Commission Distribution\n25-way Concurrency]
    end

    subgraph Firestore Data Stores
        UserPlans[(/userPlans Active Plans)]
        Accounts[(/accounts Balances & Earnings)]
        Txns[(/transactions Ledger)]
        Logs[(/dailyProfitLogs & /dailyTeamProfitLogs)]
        Settings[(/teamSettings Tier Rules)]
    end

    Cron --> Phase1
    Phase1 -->|Scan & Update| UserPlans
    Phase1 -->|Credit ROI & Principal| Accounts
    Phase1 -->|Log Idempotency| Logs
    Phase1 -->|Record Audit| Txns
    Phase1 -->|Signal Completion| Phase2

    Phase2 -->|Query Multi-Tier Settings| Settings
    Phase2 -->|Traverse Referral Trees| Accounts
    Phase2 -->|Credit Affiliate Rewards| Accounts
    Phase2 -->|Record Referral Txns| Txns
    Phase2 -->|Write Idempotency Guards| Logs

    Callable -->|Graph Traverse & Return Levels| Accounts
```

### Nightly Batch Processing State Machine

```mermaid
sequenceDiagram
    autonumber
    participant Cloud as Cloud Scheduler
    participant Engine as dailyProfitAndTeamRewards
    participant Guard as Firestore Profit Logs
    participant Txn as Firestore Transactions
    participant Acct as Firestore Accounts

    Cloud->>Engine: Trigger Scheduled Event (00:00 PKT)
    Note over Engine: Phase 1: Process User Plans (50 concurrency)
    Engine->>Guard: Check /dailyProfitLogs/{dayKey}_{planId}
    alt Already Processed Today
        Guard-->>Engine: Exists -> Skip (Idempotent)
    else First Execution Today
        Engine->>Acct: Atomic Transaction (Credit ROI + Update Balance)
        Engine->>Txn: Insert "daily_profit" Transaction Record
        Engine->>Guard: Write Idempotency Guard Document
    end
    Note over Engine: Phase 2: Compute Multi-Tier Team Bonuses (25 concurrency)
    Engine->>Acct: Traverse Downlines & Calculate Tier Volumes
    Engine->>Acct: Atomic Transaction (Credit Team Profit)
    Engine->>Txn: Insert "team_profit" Transaction Record
    Engine->>Guard: Write /dailyTeamProfitLogs/{dayKey}_{uid}
```

---

## ✨ Core Functions & Modules

### 1. ⏱️ `dailyprofitandteamrewards.js`
- **Schedule**: `0 0 * * *` (Daily at midnight, Asia/Karachi time).
- **Plan Matures & Finalization**: Detects expired medical plans, changes state to `medicine_expired`, returns invested principal, and logs `investment_sold`.
- **Missed-Day Profit Aggregator**: Handles multi-day catching-up algorithms if maintenance occurs, calculating exact accrued returns between `lastTrackedDate` and current midnight.
- **Team MLM Reward Engine**: Reads active tier settings from `/teamSettings`, parses user downline chains, evaluates minimum active member requirements, and credits upstream bonuses.
- **Transaction Retry Resilience**: Custom `runTxnWithRetry` helper providing exponential backoff on Firestore `ABORTED` (code 10) and `DEADLINE_EXCEEDED` (code 4) status codes.

### 2. 🌲 `computeteamlevelsandcreditprofit.js`
- **Trigger**: `onCall` (Firebase v2 HTTPS Callable).
- **Parameters**: `{ userId: string }`.
- **Functionality**: Dynamically queries `/teamSettings` and performs a breadth-first traversal of the user's referral tree using 10-item query chunking (`where("referralCode", "in", chunk)`).
- **Return Payload**: Structured array containing per-level user lists, names, contact identifiers, and aggregated volume statistics for client rendering.

---

## 🛠️ Technical Stack Matrix

| Component | Technology | Description |
|---|---|---|
| **Platform** | Firebase Cloud Functions v2 | Cloud Run serverless container runtime |
| **Runtime** | Node.js 20.x | Modern JavaScript execution engine |
| **SDK** | `firebase-admin` (v12+), `firebase-functions` (v5+) | Firestore NoSQL Admin API and 2nd Gen triggers |
| **Concurrency Control** | `p-limit` | Concurrency limiting for asynchronous batch pipelines |
| **Database** | Google Cloud Firestore | ACID transactional NoSQL document database |
| **Scheduler** | Google Cloud Scheduler | Enterprise cron trigger infrastructure |

---

## 🚀 Getting Started

### Prerequisites
- **Node.js** (v18 or v20 LTS).
- **Firebase CLI** installed globally:
  ```bash
  npm install -g firebase-tools
  ```
- Access to a Firebase Project with **Firestore** and **Cloud Functions (Blaze Plan)** enabled.

### Local Installation & Deployment

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/shayann07/Ai-Trust-Ledger-Cloud-Functions.git
   cd Ai-Trust-Ledger-Cloud-Functions
   ```

2. **Install Node Dependencies**:
   ```bash
   npm install firebase-functions@latest firebase-admin@latest p-limit
   ```

3. **Firebase Authentication & Target Selection**:
   ```bash
   firebase login
   firebase use <your-project-id>
   ```

4. **Deploy Cloud Functions to GCP**:
   ```bash
   # Deploy all functions
   firebase deploy --only functions

   # Deploy specific scheduled runner
   firebase deploy --only functions:dailyprofitandteamrewards
   ```

---

## 📄 License

This project is open-source software licensed under the [MIT License](LICENSE) — Copyright (c) 2026 [shayann07](https://github.com/shayann07).
