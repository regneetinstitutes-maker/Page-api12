# Project Context & Working Rules

> Yeh file project ki foundational decisions aur working methodology capture karti hai.
> Nayi session mein bhi yahan se context lo.

---

## Project Scope

- **Yeh project sirf backend hai** — Express 5 API server
- Users Frontend, Admin Panel, Support Panel, Host Panel — **sab alag alag projects mein banenge**
- Is backend ka kaam: in saare panels ko APIs provide karna

---

## App ka Concept

Ek **competition platform** jahan:
- Users entry fee de ke competitions join karte hain
- Competitions mein jeet ke prizes milti hain
- Do types of competitions:
  - **OMBs (One Match Battles)**
  - **Tournaments**

---

## Panels (Baad mein alag projects mein banenge)

| Panel | Kaam |
|---|---|
| Users App | End users — join, play, wallet, history |
| Host Panel | Competitions run karna |
| Admin Panel | Platform configure karna |
| Support Panel | User issues, disputes handle karna |
| Manager Panel | Operational monitoring — unclaimed matches, free hosts |

---

## Working Methodology

1. User pehle **poora flow** batata hai (jaise: users app ka poora flow)
2. Phir **discuss** hota hai — clarifications, edge cases
3. Phir **finalize/lock** kiya jata hai
4. Finalized decisions **yahan note** hoti hain
5. **Direct finalize nahi karna** jab user pehli baar kuch bole — pehle discuss

---

## What's Already Built (Backend)

| Module | Status |
|---|---|
| Auth (signup, login, logout, sessions) | ✅ Done |
| Users (profile, mobile OTP, email, terms) | ✅ Done |
| Wallet (Play Coins + Winning Coins, transactions, convert) | ✅ Done |
| Wallet Reservations (lock/confirm/release) | ✅ Done |
| Deposits — PayU (initiate, callback, reconciliation) | ✅ Done |
| Bank/UPI Payout Accounts | ✅ Done |
| Withdrawals — PayU Payout (full lifecycle, reconciliation) | ✅ Done |
| Background Scheduler | ✅ Done |
| OpenAPI Spec + Zod + API Client codegen | ✅ Done |

## What Needs to Be Built (Backend — Competition Modules)

| Module | Kya chahiye |
|---|---|
| Hosts | Hosts table — naam, mobile, UPI, role (OMB/Tournament), status, `current_assignment` |
| Matches (OMBs) | Match table — slot se linked, participants, status, room details, results |
| Tournaments | Tournament table — slot se linked, participants, status, initial/final values, results |
| Host Assignment | Claim → `current_assignment = match/tournament ID`; Release/Complete → `current_assignment = NULL` |
| Free Hosts API | Query: saare hosts jahan `current_assignment = NULL` — role ke hisaab se filter |
| Match Auto-Creation | Pehle participant ke aate hi match auto-create — slot-level atomic lock ke saath |
| No Proceed Policy | Room Details time par last match check — participants ≤ winner count → cancel + random prizes |
| OMB Host Timeout | Room Details ka reveal offset Admin schedule par configure karega; reveal deadline ke 3 minutes baad bhi details na aaye to Manager Panel alert, aur Starts On ke 5 minutes baad tak details na aaye to cancel + participant refunds |
| OMB Result Timeout | Starts On ke 1.5 hours baad result/positions deadline; deadline ke 3 minutes baad Manager Panel alert, aur 5 minutes baad tak result na aaye to cancel + participant refunds |
| Notifications | Push notification system — event-specific notifications for users, hosts, manager, Admin and Support; no notification history/archive |
| Voice Notes | Cancelled match/tournament ke saath manager ki voice note store karna |
| Unclaimed Alert Timer | Schedule-configured timer — X minutes baad manager ko alert agar koi host ne claim nahi kiya |
| Screenshot Storage | OMB result screenshot host upload karta hai — match ID ke saath store, saare participants ko serve |
| Competitors Position Schedule | Tournament ke dauran scheduled position reveals — host values submit kare, backend chart publish kare, participants ko notify kare |
| Host Payment Tracking | Har host ke liye Completed count aur Paid count track karna — Admin "Pay" action se Paid = Completed set hota hai |
| Cancellation Tracking | Har cancelled match/tournament ka timestamp store — Admin Panel ke monthly cancellation chart ke liye |

---

## Decisions Log

> UI/screen-level decisions → `user-frontend.md`
> Admin Panel decisions → `admin-panel.md` (bhi)
> Host Panel decisions → `host-panel.md` (bhi)

---

### Games & Modes — Data Model (Finalized)

```
Game (e.g. BGMI, Free Fire)  ← Logo + Name
  └── Mode (e.g. TDM, Battle Royale)  ← Logo + Name
        └── Entry Fee (e.g. ₹50, ₹100)
              └── Schedules (time slots — alag entity nahi, sirf timings hain)
```

- Saara content (Games, Modes, Entry Fees, Schedules, Match Details) **sirf Admin Panel se manage hoga**
- Users App **read-only** hai

---

### Match / Tournament ID (Finalized)

- Har match aur tournament ka ek unique **ID** hoga
- **User ko bhi dikhegi** — support se contact karne ke liye
- **Admin** is ID se admin panel mein records search kar sakta hai
- Match/Tournament ID se **poori details fetch** ki ja sakti hain

---

### Records System (Finalized)

Har match aur tournament ka record store hoga:
- Match/Tournament ID
- Kis host ne handle kiya
- Prize distribution
- Joined participants list

**Retention policy:**
- Latest **20,000 matches** ka record
- Latest **20,000 tournaments** ka record
- 20,001th (oldest) **auto-delete**

---

### Match/Tournament Creation — Automatic System (Finalized)

Matches aur tournaments **host manually publish karke live nahi hote**. System fully automatic:

1. Participants ek schedule ke liye join karte hain
2. Pehla participant join karte hi **pehli match/tournament turant create** ho jaati hai
3. Jab pehli match full ho jaaye aur next participant aaye → **nayi match create**
4. Yeh matches **host panel mein appear** hoti hain — available role wala koi bhi host claim kar sakta hai

**Pehle hi create karne ka reason:** Participant ke join karte hi uske My Play → Ongoing mein **Match ID turant dikhni chahiye** — isliye match creation delay nahi hoti.

**Race condition:** Do participants simultaneously pehle aayein → sirf **ek** match banegi (backend handle karega)

**Host Rules:**
- Do roles: **OMB Host** aur **Tournament Host** (Admin Panel se assign)
- Ek host ek time pe **sirf ek** match/tournament claim kar sakta hai

---

### Last Pair / Low Participation Rule (Finalized)

Last (incomplete) match/tournament ke liye:

**Deadline:**
- OMBs → **Room Details reveal time** tak
- Tournaments → **Entry Closes time** tak

**Winner Count** = total prize positions (e.g. top 35 ko prizes milti hain → winner count = 35)

| Condition | Result |
|---|---|
| Participants **≤ winner count** | Auto-cancel + random prize distribution |
| Participants **> winner count** (ek bhi zyada) | Normal processing |

**Random distribution:** Koi rank matter nahi — sabhi participants ko prize chart ke according prizes milti hain bina kisi position ke.

**User ko note milega:**
> "This match was canceled due to low participation. To ensure fairness, awards were distributed randomly according to the awards chart."

---

### Host's Role in Prize Distribution (Finalized)

1. Match complete hone ke baad host ko **joined participants ki list** dikhti hai (In-Game ID + Platform User ID)
2. Host bas **positions assign karta hai** (1st, 2nd, 3rd, ...)
3. **Backend** automatically prize chart ke according **coins distribute** kar deta hai

Host ko manually kisi ko coins nahi dene hote.

---

### Tournament — Per-Participant Timing (Finalized)

- Har participant ka tournament **start time alag hota hai**
- Trigger: Host us participant ki **Initial Value** (metric) enter karke confirm kare → usi moment se duration shuru
- **End time = Start time + Duration** (fixed, per participant)
- Host exact end time par game mein ja ke **Final Value** note karta hai, phir host panel mein double entry verification se enter karta hai

---

### Tournament — Numeric Metric Rule (Finalized)

Tournaments **sirf numeric metrics** par honge:
- ✅ Eliminations, Wins, Score, Trophies, Likes, Achievement Points, XP, Level Points, koi bhi future numeric metric
- ❌ Rank-based tournaments (Gold, Diamond, Heroic...) — **nahi honge**

---

### Tournament Ranking — Backend Calculation (Finalized)

```
Performance = Final Value − Initial Value
Example: 236 (final) − 78 (initial) = 158 (performance)
```

- Sabse zyada Performance → **Tournament Rank 1**
- Uske baad Rank 2, Rank 3, ...
- Prize distribution automatically isi ranking ke hisaab se

Teen alag cheezein:
```
Initial Value    →  Metric value jab host ne tournament start kiya (e.g. Eliminations = 78)
Final Value      →  Metric value jab tournament end hua (e.g. 236)
Tournament Rank  →  Calculated position among participants based on Performance
```

---

### Tournament — Participants List Release (Finalized)

- Entry Closes ke exactly **1 hour baad** — sabhi participants ko us tournament ke saare participants ki list milti hai
- List mein: **Game ID** + (additional fields — baad mein finalize hongi)
- **Nahi hoga list mein**: Platform User ID, Mobile, Email *(privacy)*

---

### Hacker / Cheating Tag — Backend Rule (Finalized)

- Host kisi bhi participant ko **Hacker/Cheater** tag de sakta hai (OMBs + Tournaments)
- Tagged participant: **prize = 0, refund = 0** — kuch nahi milta
- Tag **publicly visible** — results mein, ID search mein, participant ke app mein — koi restriction nahi

---

### Join Flow — Atomic Transaction (Finalized)

Join karna **ek single atomic transaction** hai. Teen cheezein ek saath hoti hain ya bilkul nahi hoti:

```
Join Successful = Coins Deduct + Seat Reserved + Match Joined
```

| Scenario | Result |
|---|---|
| Teeno successful | ✅ Commit — user joined, coins deducted |
| Koi bhi ek fail | ❌ Rollback — coins bilkul deduct nahi honge |

**User ke liye sirf do possibilities:**
- ✅ Join Successful
- ❌ Join Failed (coins safe)

Beech ki koi situation nahi hogi. Backend failure (server restart, network drop mid-request) se user ka paisa kabhi nahi phasega.
