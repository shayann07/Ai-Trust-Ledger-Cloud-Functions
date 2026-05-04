# AI Trust Ledger Cloud Functions

This repository contains the deployed Node.js Firebase Cloud Functions used by the AI Trust Ledger app. These functions handle backend logic such as computing team levels and credit profit and calculating daily profits and team rewards.

## Functions

- **computeteamlevelsandcreditprofit.js** – Scheduled function that calculates and updates team levels and credit profit for users based on their investments and referrals.
- **dailyprofitandteamrewards.js** – Scheduled function that processes daily ROI (return on investment) and team rewards distributions, crediting user wallets and updating transaction history.

## Getting Started

To run or deploy these functions yourself:

1. **Clone this repository**.

   ```bash
   git clone https://github.com/shayann07/Ai-Trust-Ledger-Cloud-Functions.git
   ```

2. **Navigate into the functions directory** and install dependencies:

   ```bash
   cd Ai-Trust-Ledger-Cloud-Functions
   npm install
   ```

3. **Set up Firebase** using the Firebase CLI. If you haven’t already, install the CLI and log in:

   ```bash
   npm install -g firebase-tools
   firebase login
   ```

4. **Configure your Firebase project** by specifying your project ID:

   ```bash
   firebase use --add
   ```

5. **Add environment variables** (e.g. API keys, secret keys) using `firebase functions:config:set` or the `.env` file (not included for security).

6. **Deploy the functions**:

   ```bash
   firebase deploy --only functions
   ```

## Technologies Used

- **Node.js** – JavaScript runtime.
- **Firebase Cloud Functions** – Serverless functions for backend logic.
- **Cloud Firestore / Firebase Admin** – Database and admin SDK for secure server-side access.

## License

This project is licensed under the **MIT License**. Feel free to use and modify as needed.

<!-- gitpulse:contribution index="1" timestamp="2026-04-29" -->
<!-- gitpulse:contribution index="2" timestamp="2026-05-04" -->