/**
 * computeTeamLevelsAndCreditProfit – UI-only version
 *
 * Input : { userId: "<root-uid>" }
 * Output: {
 *   levels         : Array<LevelStats & { users: [...] }>,
 *   profitBooked   : false,
 *   creditedAmount : 0
 * }
 *
 * Notes
 * ─────
 * • Traverses the referral tree exactly like before.
 * • Builds `levels[]` with full per-level user arrays.
 * • **⇢ No balance updates, no transaction docs, no guard logs.**
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger }             = require("firebase-functions");
const { initializeApp }      = require("firebase-admin/app");
const { getFirestore }       = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

/* ───────── helpers ───────── */
function chunk10(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i += 10) out.push(arr.slice(i, i + 10));
  return out;
}

/* ───────── callable ───────── */
exports.computeTeamLevelsAndCreditProfit = onCall(
  { region: "us-central1", timeoutSeconds: 60, memory: "512MiB" },
  async (req) => {
    const rootUid = req.data && req.data.userId;
    if (!rootUid) throw new HttpsError("invalid-argument", "userId is required");

    /* 1️⃣ load level config ------------------------------------------------ */
    const settingsSnap = await db.collection("teamSettings").orderBy("level").get();
    const settings = settingsSnap.docs.map(d => d.data());

    /* 2️⃣ walk referral tree ---------------------------------------------- */
    let frontier = [rootUid];
    const levels = [];

    for (const cfg of settings) {
      /* direct referrals of current frontier */
      const userDocs = [];
      for (const chunk of chunk10(frontier)) {
        const qs = await db.collection("users")
                           .where("referralCode", "in", chunk).get();
        userDocs.push(...qs.docs);
      }

      /* build user list for UI */
      const userList = userDocs.map(d => ({
        uid:       d.get("uid"),
        firstName: d.get("firstName") || "",
        lastName:  d.get("lastName")  || "",
        status:    d.get("status")
      }));
      const activeUids = userList
        .filter(u => u.status === "active")
        .map(u => u.uid);

      /* deposits + daily profit (still computed so UI can show stats) */
      let levelDeposit = 0;
      let levelDailyProfit = 0;
      for (const chunk of chunk10(activeUids)) {
        const accSnap = await db.collection("accounts")
                                .where("userId", "in", chunk).get();
        accSnap.forEach(acc => {
          const inv  = acc.get("investment") || {};
          const earn = acc.get("earnings")   || {};
          levelDeposit     += inv.totalDeposit || 0;
          levelDailyProfit += earn.dailyProfit || 0;
        });
      }

      const unlocked = activeUids.length >= cfg.requiredMembers;

      levels.push({
        level:            cfg.level,
        requiredMembers:  cfg.requiredMembers,
        profitPercentage: cfg.profitPercentage,
        totalUsers:       userDocs.length,
        activeUsers:      activeUids.length,
        inactiveUsers:    userDocs.length - activeUids.length,
        totalDeposit:     levelDeposit,
        levelUnlocked:    unlocked,
        users:            userList
      });

      frontier = activeUids;             // next depth
    }

    logger.info(`Fetched ${levels.length} team levels for ${rootUid} (UI-only)`);

    /* 3️⃣ return without crediting ---------------------------------------- */
    return {
      levels,
      profitBooked:   false,
      creditedAmount: 0
    };
  }
);
