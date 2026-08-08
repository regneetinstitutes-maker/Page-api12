# Admin Panel — Notes

> Yeh file Admin Panel se related finalized decisions capture karti hai.
> Admin Panel ek alag project mein banega — yeh file wahan le jaai ja sakti hai.
> Main decisions `project-context.md` mein bhi hain.

---

## Dashboard Stats (Finalized)

Admin Panel ke dashboard pe yeh metrics dikhenge:

| Metric | Detail |
|---|---|
| Total Users | Platform par registered users |
| Total Hosts | Registered hosts (OMB + Tournament) |
| Total User Play Coins | Sabhi users ke Play Coins ka sum |
| Total Winning Coins | Sabhi users ke Winning Coins ka sum |
| Cancelled / Auto Rewarded OMBs | Is mahine mein har date ko kitne OMBs cancel hue — monthly chart |
| Cancelled / Auto Rewarded Tournaments | Is mahine mein har date ko kitne Tournaments cancel hue — monthly chart |

---

## User Search (Finalized)

Admin kisi bhi user ko **mobile number se search** kar sakta hai.

### User Details Screen (Search ke baad)

**Basic Information**
- Full Name
- Mobile Number
- User ID *(backend generated)*
- Account Status: Active / Disabled / Banned
- Registration Date
- Last Login

**Wallet**
- Play Coins (User Coins)
- Winning Coins
- Total Deposited
- Total Withdrawn

**Activity**
- Total OMBs Joined
- Total Tournaments Joined
- Total OMBs Won
- Total Tournaments Won

**Current Activity**
- Current Running OMB *(agar hai — Match ID bhi dikhega)*
- Current Running Tournament *(agar hai — Tournament ID bhi dikhega)*

**History**
- Recent OMBs *(latest 5–10)*
- Recent Tournaments *(latest 5–10)*

**Actions**
- Disable / Enable Account
- Reset User Password
- View Wallet Transactions

---

## Top 20 Users — Deposits & Withdrawals (Finalized)

Admin Panel mein ek dedicated section hoga jo **live numbers ke saath** dikhayega:
- Top 20 users jinhone **sabse zyada deposit** kiya hai
- Top 20 users jinhone **sabse zyada withdrawal** kiya hai

---

## Content Management (OMBs & Tournaments) (Finalized)

Admin Panel se manage hoga:
- **Games**: Logo + Name — add / remove / edit
- **Modes**: Logo + Name — add / remove / edit
- **Entry Fees**: Modes ke under — add / remove / edit
- **Schedules (Time Slots)**: Entry Fees ke under — add / remove / edit
  - Schedule fields mein ek extra field: **"Manager alert after (minutes)"** — match/tournament create hone ke kitne minute baad manager ko unclaimed notification jaaye
- **Match/Tournament Details**: Prizes, Guide video, Notes, Participants, Team Size, Tournament Metric, etc.
  - **Room ID Reveal Time** *(OMBs)* — Admin configure karta hai: match kab start hone se kitne minute pehle Room ID/Password reveal hoga
  - **Result Submission Deadline** — Admin configure karta hai: match/tournament khatam hone ke baad kitne waqt mein host result submit kare

Users App in sab ke liye **read-only** hai.

---

## Match / Tournament Records Access (Finalized)

Admin, admin panel mein **Match/Tournament ID** dal ke kisi bhi match/tournament ki poori details dekh sakta hai.

Record mein hoga:
- Match/Tournament ID
- Kis host ne handle kiya
- Prize distribution
- Joined participants list

**Cancel Voice Note:**
- Agar match/tournament cancel hua hai aur Manager ne voice note chhoda hai → record mein **voice note** bhi dikhega
- Sirf cancelled matches/tournaments ke liye applicable

**Retention policy:**
- Latest **20,000 matches** ka record
- Latest **20,000 tournaments** ka record
- 20,001th (oldest) **auto-delete**

## Admin Push Notifications (Finalized)

Admin ko operational aur support-relevant events par push notifications milengi:

- Low participation cancellation
- OMB room-details timeout se auto-cancel + refund
- OMB/Tournament result timeout se auto-cancel + refund
- Hacker/Cheater tag

Push se relevant Match/Tournament ID aur current record khulega. Admin ko normal user status changes ya host availability alerts nahi bheje jaayenge. Notification history/archive alag se store nahi hogi; current record aur current status hi source of truth rahenge.

---

## Hosts Management (Finalized)

### Layout

```
+ Create New Host

[ OMB Hosts ]  [ Tournament Hosts ]   ← side-by-side toggle buttons

↓ List of hosts (selected role)
```

### Host Row (List mein)

```
Rakesh Kumar
OMB Host

Completed: 35    Paid: 30        [Pay]
```

Har row mein:
- Host Name
- Role (small text neeche)
- Completed count
- Paid count
- **Pay Button**

### Pay Button Logic

1. Admin Pay dabaye
2. Popup: *"Confirm payment for all pending completed matches/tournaments?"*
3. Buttons: **Cancel** / **Confirm**
4. Confirm karte hi: **Paid = Completed**

Manual number enter karne ki permission nahi — system automatic set karta hai Paid = Completed.

### Host Details (Tap to Expand — Same Place, No New Screen)

Host ke naam par tap karte hi **wahin expand** hoga:

**Basic Details**
- Full Name
- Mobile Number
- UPI ID
- Role
- Status: Active / Disabled

**Work Details**
- Current Assignment *(None / Running Match #OMB-1042 / Running Tournament #T-231)*
- Completed Matches / Tournaments
- Paid Matches / Tournaments

**Other Details**
- Created Date
- Last Login

**Actions**
- Edit Host
- Reset Password
- Enable / Disable
- Delete Host *(optional)*

### Create New Host

Fields:
- Full Name
- Mobile Number
- UPI ID
- Password
- Role: **OMB Host** / **Tournament Host**

Button: **Create Host**

### Host Roles

- **OMB Host** → sirf OMBs dikhenge available section mein
- **Tournament Host** → sirf Tournaments dikhenge available section mein
- Role assign hoti hai create karte waqt, edit bhi ho sakti hai
