# AI Trust Ledger Cloud Functions

JavaScript source for two Firebase Cloud Functions that read AI Trust Ledger team data and process nightly investment profit and team rewards in Cloud Firestore.

> **Project status:** This repository contains function source files only. It does not include `package.json`, a Firebase entry point, Firebase project configuration, tests, or deployment metadata, so it cannot be installed or deployed as a standalone project in its current form.

## Functions

### `computeTeamLevelsAndCreditProfit`

A second-generation HTTPS callable function configured for `us-central1` with a 60-second timeout and 512 MiB of memory.

The function:

- Requires a `userId` value in the callable request data.
- Loads ordered level rules from the `teamSettings` collection.
- Walks the user's referral tree one configured level at a time.
- Counts active and inactive users at each level.
- Aggregates account deposits and daily-profit values for active team members.
- Returns per-level user and summary data for UI display.
- Does not update balances, create transactions, or credit team profit.

The returned object contains `levels`, `profitBooked: false`, and `creditedAmount: 0`.

### `dailyProfitAndTeamRewards`

A second-generation scheduled function configured to run every day at `00:00` in the `Asia/Karachi` time zone. It uses a 540-second timeout, 1 GiB of memory, and scheduler retry settings.

The job runs two sequential phases:

1. **Plan profit processing** scans users in pages of 500 with up to 50 concurrent user tasks. It finalizes expired medicine plans, tracks missed-day profit for stock and medicine plans, updates active forex profit, refreshes plan percentages from configuration, and records relevant account and transaction changes.
2. **Team reward processing** scans the same user set with up to 25 concurrent tasks. It traverses configured referral levels, calculates unlocked level shares from active members' daily profit, credits eligible root accounts, and creates team-reward transactions.

Firestore transactions are retried for selected transient errors. Daily plan and team processing use deterministic documents in `dailyProfitLogs` and `dailyTeamProfitLogs` to avoid booking the same work more than once for a Pakistan-calendar day.

## Firestore Data Used

The implementation reads or writes these collections:

- `users`
- `accounts`
- `plans`
- `userPlans`
- `teamSettings`
- `transactions`
- `dailyProfitLogs`
- `dailyTeamProfitLogs`

The functions depend on the exact field names and nested account maps used by the companion AI Trust Ledger applications. Required composite indexes and Firebase security/configuration files are not documented in this repository.

## Tech Stack

- Node.js-style CommonJS JavaScript
- Firebase Functions v2 HTTPS callable and scheduler APIs
- Firebase Admin SDK
- Cloud Firestore transactions, queries, timestamps, and atomic increments
- `p-limit` for bounded concurrency

## Source Layout

```text
.
|-- computeteamlevelsandcreditprofit.js  # Callable referral/team statistics
|-- dailyprofitandteamrewards.js         # Nightly plan profit and team rewards
`-- README.md
```

## Integrating the Source

These files must be incorporated into an existing or newly initialized Firebase Functions project before they can run. That host project needs to:

1. Provide compatible CommonJS versions of `firebase-functions`, `firebase-admin`, and `p-limit`.
2. Initialize the Firebase Admin SDK once and expose both exported functions from the Functions entry point.
3. Select the intended Firebase project and configure any required Firestore indexes.
4. Validate the schema and financial rules against non-production data.
5. Exercise callable and scheduled behavior with the Firebase Emulator Suite or equivalent tests.
6. Deploy through the host project's reviewed Firebase configuration.

Exact install, emulator, and deploy commands are intentionally not listed because the required manifests and Firebase configuration are absent from this repository.

## Current Limitations and Safety Notes

- The callable function validates only the presence of `userId`; it does not check Firebase Authentication, administrator roles, or App Check before returning team data.
- Financial calculations and balance updates assume a specific Firestore schema and should be reviewed for business-rule accuracy before deployment.
- Both source files initialize the Admin SDK independently, which must be reconciled if they are loaded by the same Functions process.
- No automated tests, emulator fixtures, dependency lockfile, runtime version, Firebase configuration, or CI workflow is included.
- No license file is present.
