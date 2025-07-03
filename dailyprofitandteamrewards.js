/*  ──────────────────────────────────────────────────────────────────────────
    AI Trust Ledger – Nightly Profit + Team Reward Cron  (single function)
    • Runs every day @ 00:00 Asia/Karachi
    • Phase 1 : per-plan profit processing  (50-way concurrency)
    • Phase 2 : team-reward computation    (25-way concurrency, starts only
              after Phase 1 finishes)
    • Fully idempotent via /dailyProfitLogs & /dailyTeamProfitLogs
    • Automatic txn retries with exponential back-off
    ────────────────────────────────────────────────────────────────────────── */

"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger }     = require("firebase-functions");
const admin          = require("firebase-admin");
const pLimit         = require("p-limit");

admin.initializeApp();
const db          = admin.firestore();
const FieldValue  = admin.firestore.FieldValue;
const Timestamp   = admin.firestore.Timestamp;

/* ─── PK-timezone helpers ─────────────────────────────────────── */
const PK_OFFSET_MS = 5 * 60 * 60 * 1000;          // +05:00
const DAY_MS       = 86_400_000;

function pkDayKey(date = new Date()) {
  const pk = new Date(date.getTime() + PK_OFFSET_MS);
  return pk.toISOString().slice(0, 10);           // YYYY-MM-DD
}
function pkTodayMidnight(date = new Date()) {
  const pk = new Date(date.getTime() + PK_OFFSET_MS);
  const msMid = pk.getTime() - (pk.getTime() % DAY_MS);
  return new Date(msMid - PK_OFFSET_MS);          // UTC Date at 00:00 PKT
}

/* ─── Generic helpers ─────────────────────────────────────────── */
const chunk10 = (arr) =>
  [...Array(Math.ceil(arr.length / 10))].map((_, i) => arr.slice(i * 10, i * 10 + 10));

async function runTxnWithRetry(fn, maxAttempts = 10) {
  let attempt = 0;
  while (true) {
    try {
      return await db.runTransaction(fn, { maxAttempts: 1 });
    } catch (e) {
      const retryable = e.code === 10 || e.code === 4;      // ABORTED / DEADLINE_EXCEEDED
      if (!retryable || ++attempt >= maxAttempts) throw e;
      await new Promise((r) => setTimeout(r, 50 * 2 ** attempt)); // back-off
    }
  }
}

/* ───────────────────────────────────────────────────────────────
   PHASE 1  –  PLAN-LEVEL PROFIT COLLECTION  (original logic)
   ─────────────────────────────────────────────────────────────── */

/* 1) MEDICINE expiry & credit */
async function finalizeMedicinePlans(uid) {
  const now = new Date();
  const plans = await db
    .collection("userPlans")
    .where("user_id", "==", uid)
    .where("status", "==", "medicine_active")
    .get();

  if (plans.empty) return;

  for (const doc of plans.docs) {
    const data = doc.data();
    const expiryTS = data.expiry_date;
    if (!expiryTS || now < expiryTS.toDate()) continue;

    const profitTrack = (data.profitTrack || 0) * 1.0;
    if (profitTrack <= 0) continue;

    const acctSnap = await db
      .collection("accounts")
      .where("userId", "==", uid)
      .limit(1)
      .get();
    if (acctSnap.empty) continue;
    const acctRef = acctSnap.docs[0].ref;

    await runTxnWithRetry(async (tx) => {
      const planTxn = await tx.get(doc.ref);
      if (planTxn.get("status") !== "medicine_active") return;

      const track = (planTxn.get("profitTrack") || 0) * 1.0;
      if (track <= 0) return;
      const invested = (planTxn.get("invested_amount") || 0) * 1.0;

      const acctTxn = await tx.get(acctRef);
      const earnings = acctTxn.get("earnings") || {};
      const invMap   = acctTxn.get("investment") || {};

      tx.update(acctRef, {
        "earnings.buyingProfit"   : (earnings.buyingProfit   || 0) + track,
        "earnings.dailyProfit"    : (earnings.dailyProfit    || 0) + track,
        "earnings.totalEarned"    : (earnings.totalEarned    || 0) + track,
        "investment.currentBalance": (invMap.currentBalance || 0) + invested + track,
      });

      tx.update(doc.ref, {
        status         : "medicine_expired",
        lastTrackedDate: Timestamp.fromDate(now),
      });

      const tRef = db.collection("transactions").doc();
      tx.set(tRef, {
        transactionId : tRef.id,
        userId        : uid,
        amount        : invested + track,
        type          : "investment_sold",
        address       : data.plan_name || "Medicine",
        status        : "sold",
        balanceUpdated: true,
        timestamp     : Timestamp.now(),
      });
    });
  }
}

/* 2) STOCK & MEDICINE missed-day profit */
async function collectStockAndMedicineDailyProfit(uid) {
  await collectDailyProfit(uid, ["stock_open"], false, false);
  await collectDailyProfit(uid, ["medicine_active"], true,  true);
}

async function collectDailyProfit(uid, statusList, clampExp, capDays) {
  const now = new Date();
  const plans = await db
    .collection("userPlans")
    .where("user_id", "==", uid)
    .where("status", "in", statusList)
    .get();

  if (plans.empty) return;

  for (const doc of plans.docs) {
    const data   = doc.data();
    const planId = doc.id;

    const dailyP = await updatePlanProfitFields(doc);
    if (dailyP === null) continue;

    const track0      = (data.profitTrack || 0) * 1.0;
    const lastTracked = (data.lastTrackedDate || Timestamp.now()).toDate();

    let upper = now;
    if (clampExp && data.expiry_date) {
      const exp = data.expiry_date.toDate();
      if (exp < upper) upper = exp;
    }

    const missedDays = Math.floor((upper - lastTracked) / DAY_MS);
    if (missedDays <= 0) continue;

    let maxTrack = Infinity;
    if (capDays && data.plan_days) maxTrack = dailyP * data.plan_days;

    const track1 = Math.min(track0 + dailyP * missedDays, maxTrack);
    const delta  = track1 - track0;
    if (delta <= 0) continue;

    const logId  = `${uid}-${planId}-${pkDayKey()}`;
    const logRef = db.collection("dailyProfitLogs").doc(logId);

    await runTxnWithRetry(async (tx) => {
      const logged = await tx.get(logRef);
      if (logged.exists) return;

      const planTxn = await tx.get(doc.ref);
      const lt      = (planTxn.get("lastTrackedDate") || Timestamp.now()).toDate();

      let up = now;
      if (clampExp && planTxn.get("expiry_date")) {
        const ex = planTxn.get("expiry_date").toDate();
        if (ex < up) up = ex;
      }
      const md = Math.floor((up - lt) / DAY_MS);
      if (md <= 0) return;

      const t0  = (planTxn.get("profitTrack") || 0) * 1.0;
      const t1  = Math.min(t0 + dailyP * md, maxTrack);
      const del = t1 - t0;
      if (del <= 0) return;

      tx.update(doc.ref, {
        profitTrack      : t1,
        lastTrackedDate  : Timestamp.fromDate(up),
        lastCollectedDate: Timestamp.fromDate(now),
      });

      tx.set(logRef, {
        user_id    : uid,
        plan_id    : planId,
        date       : pkDayKey(),
        collectedAt: Timestamp.now(),
      });
    });
  }
}

/* helper – refresh plan’s daily/direct profit fields */
async function updatePlanProfitFields(planDoc) {
  const data = planDoc.data();
  const planName = data.plan_name;
  if (!planName) return null;

  const planSnap = await db
    .collection("plans")
    .where("planName", "==", planName)
    .limit(1)
    .get();
  if (planSnap.empty) return null;

  const cfg = planSnap.docs[0].data();
  const pct = (cfg.dailyPercentage || 0) * 1.0;
  const dir = (cfg.directProfit   || 0) * 1.0;
  const invested = (data.invested_amount || 0) * 1.0;

  const newDaily  = invested * (pct / 100);
  const newDirect = invested * (dir / 100);

  await planDoc.ref.update({
    daily_profit       : newDaily,
    percentage         : pct,
    direct_profit      : newDirect,
    directProfitPercent: dir,
  });

  return newDaily;
}

/* 3) FOREX (active) daily profit */
async function collectForexProfit(uid) {
  const now       = new Date();
  const todayMid  = pkTodayMidnight(now);
  let totalBuying = 0.0;

  const plans = await db
    .collection("userPlans")
    .where("user_id", "==", uid)
    .where("status", "==", "active")
    .get();

  for (const doc of plans.docs) {
    const data   = doc.data();
    const planId = doc.id;

    const dailyP = await updatePlanProfitFields(doc);
    if (dailyP === null) continue;

    const lastColl = (data.lastCollectedDate || Timestamp.now()).toDate();
    const lastMid  = new Date(lastColl - (lastColl % DAY_MS));
    if (todayMid <= lastMid) continue;

    const logId  = `${uid}-${planId}-${pkDayKey()}`;
    const logRef = db.collection("dailyProfitLogs").doc(logId);

    await runTxnWithRetry(async (tx) => {
      if ((await tx.get(logRef)).exists) return;

      const planTxn = await tx.get(doc.ref);
      const lc      = (planTxn.get("lastCollectedDate") || Timestamp.now()).toDate();
      const lcMid   = new Date(lc - (lc % DAY_MS));
      if (todayMid <= lcMid) return;

      const track0 = (planTxn.get("profitTrack") || 0) * 1.0;
      tx.update(doc.ref, {
        profitTrack      : track0 + dailyP,
        lastCollectedDate: Timestamp.fromDate(now),
      });

      tx.set(logRef, {
        user_id    : uid,
        plan_id    : planId,
        date       : pkDayKey(),
        collectedAt: Timestamp.now(),
      });

      totalBuying += dailyP;
    });
  }

  if (totalBuying <= 0) return;

  const acctSnap = await db
    .collection("accounts")
    .where("userId", "==", uid)
    .limit(1)
    .get();
  if (acctSnap.empty) return;
  const acctRef = acctSnap.docs[0].ref;

  await runTxnWithRetry(async (tx) => {
    const acc      = await tx.get(acctRef);
    const earnings = acc.get("earnings")   || {};
    const inv      = acc.get("investment") || {};

    tx.update(acctRef, {
      "earnings.buyingProfit"   : (earnings.buyingProfit   || 0) + totalBuying,
      "earnings.dailyProfit"    : totalBuying,  // replace; change to += if desired
      "earnings.totalEarned"    : (earnings.totalEarned    || 0) + totalBuying,
      "investment.currentBalance": (inv.currentBalance     || 0) + totalBuying,
      "investment.remainingBalance": (inv.remainingBalance || 0) + totalBuying,
    });
  });
}

/* orchestrator for Phase 1 (per-user) */
async function processProfitForUser(userDoc) {
  const uid = userDoc.get("uid");
  if (!uid) {
    logger.warn(`[${userDoc.id}] ⛔️ missing uid`);
    return;
  }
  try {
    await finalizeMedicinePlans(uid);
    await collectStockAndMedicineDailyProfit(uid);
    await collectForexProfit(uid);
  } catch (e) {
    logger.error(`[${uid}] ❌ profit phase`, e);
  }
}

/* ───────────────────────────────────────────────────────────────
   PHASE 2 – TEAM-LEVEL PROFIT CREDIT  (refactored callable logic)
   ─────────────────────────────────────────────────────────────── */

async function computeAndCreditTeamProfit(rootUid) {
  /* 1) load config */
  const settingsSnap = await db.collection("teamSettings").orderBy("level").get();
  const settings     = settingsSnap.docs.map((d) => d.data());

  /* 2) walk referral tree depth-first */
  let frontier         = [rootUid];
  const levelShares    = [];        // { level, share }
  let totalTeamProfit  = 0;

  for (const cfg of settings) {
    /* children of current frontier */
    const userDocs = [];
    for (const chunk of chunk10(frontier)) {
      const qs = await db
        .collection("users")
        .where("referralCode", "in", chunk)
        .get();
      userDocs.push(...qs.docs);
    }

    /* build user list */
    const userList   = userDocs.map((d) => ({ uid: d.get("uid"), status: d.get("status") }));
    const activeUids = userList.filter((u) => u.status === "active").map((u) => u.uid);

    /* deposits + daily profit for this level */
    let levelDailyProfit = 0;
    for (const chunk of chunk10(activeUids)) {
      const accSnap = await db
        .collection("accounts")
        .where("userId", "in", chunk)
        .get();
      accSnap.forEach((acc) => {
        const earn = acc.get("earnings") || {};
        levelDailyProfit += earn.dailyProfit || 0;
      });
    }

    const unlocked = activeUids.length >= cfg.requiredMembers;
    const share    = unlocked ? (levelDailyProfit * cfg.profitPercentage) / 100 : 0;

    if (unlocked && share > 0) levelShares.push({ level: cfg.level, share });
    totalTeamProfit += share;

    frontier = activeUids;  // next depth
  }

  /* 3) credit once per PK-day */
  const logRef = db
    .collection("dailyTeamProfitLogs")
    .doc(`${rootUid}-${pkDayKey()}`);

  const acctSnap = await db
    .collection("accounts")
    .where("userId", "==", rootUid)
    .limit(1)
    .get();
  if (acctSnap.empty) return;
  const acctRef = acctSnap.docs[0].ref;

  const booked = await runTxnWithRetry(async (tr) => {
    if ((await tr.get(logRef)).exists) return false;      // already ran today
    if (totalTeamProfit === 0)          return false;      // nothing to credit

    const curInv = (await tr.get(acctRef)).get("investment") || {};

    tr.update(acctRef, {
      "investment.currentBalance"   : (curInv.currentBalance || 0) + totalTeamProfit,
      "investment.remainingBalance" : FieldValue.increment(totalTeamProfit),
      "earnings.teamProfit"         : FieldValue.increment(totalTeamProfit),
      "earnings.totalEarned"        : FieldValue.increment(totalTeamProfit),
      "earnings.dailyProfit"        : FieldValue.increment(totalTeamProfit),
    });

    for (const { level, share } of levelShares) {
      const txRef = db.collection("transactions").doc();
      tr.set(txRef, {
        transactionId : txRef.id,
        userId        : rootUid,
        amount        : share,
        type          : "teamReward",
        address       : `Team Profit (Level ${level})`,
        status        : "collected",
        balanceUpdated: true,
        timestamp     : Timestamp.now(),
      });
    }

    tr.set(logRef, { loggedAt: FieldValue.serverTimestamp() });
    return true;
  });

  logger.info(`teamProfit ${rootUid}: booked=${booked}, amount=${totalTeamProfit}`);
}

async function processTeamProfitForUser(userDoc) {
  const uid = userDoc.get("uid");
  if (!uid) return;
  try {
    await computeAndCreditTeamProfit(uid);
  } catch (e) {
    logger.error(`[${uid}] ❌ team phase`, e);
  }
}

/* ───────────────────────────────────────────────────────────────
   PAGINATED EXECUTION HELPERS  (shared by both phases)
   ─────────────────────────────────────────────────────────────── */

async function runPhase(name, perUserFn, concurrency) {
  logger.info(`▶ Phase – ${name}`);
  const limit = pLimit(concurrency);
  const PAGE  = 500;
  let last    = null,
      page    = 0;

  while (true) {
    let q = db.collection("users").orderBy("__name__").limit(PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;

    logger.info(`   • ${name} – page ${++page} (${snap.size} users)`);
    await Promise.all(snap.docs.map((u) => limit(() => perUserFn(u))));
    last = snap.docs[snap.docs.length - 1];
  }
  logger.info(`✓ Phase done – ${name}`);
}

/* ───────────────────────────────────────────────────────────────
   SCHEDULED ENTRY POINT  (the single exported function)
   ─────────────────────────────────────────────────────────────── */

exports.dailyProfitAndTeamRewards = onSchedule(
  {
    schedule      : "0 0 * * *",         // 00:00 every day PKT
    timeZone      : "Asia/Karachi",
    timeoutSeconds: 540,                 // 9 minutes
    memory        : "1GiB",
    retryConfig   : { retryCount: 3, minBackoffSeconds: 120 },
  },
  async () => {
    logger.info("════════ Nightly job START ════════");

    /* Phase 1 – per-plan profit collection */
    await runPhase("Plan Profit", processProfitForUser, 50);

    /* Phase 2 – team-reward computation (runs after Phase 1) */
    await runPhase("Team Rewards", processTeamProfitForUser, 25);

    logger.info("════════ Nightly job DONE ═════════");
  }
);