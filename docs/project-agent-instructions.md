# Project Agent Instructions

> Yeh file un rules ko capture karti hai jo kisi bhi agent ko is project par kaam karte waqt follow karni chahiye.
> Nayi session mein, nayi file mein kuch bhi add karne se pehle yeh file zaroor padho.

---

## Yeh Files Kya Hain?

Yeh `docs/` folder ki saari files is platform ka **living documentation** hain — code likhne se pehle ka poora system design yahan capture hota hai.

Inhe padhke koi bhi agent — ya insaan — yeh samajh sake:
- Platform kaise kaam karta hai
- Har panel ka kya role hai
- Backend ko kya banana hai
- Kaunsa feature kis file mein hai

**Yeh files code nahi hain — yeh platform ka blueprint hain.**

---

## Files Ki List aur Unka Kaam

| File | Kaam |
|---|---|
| `project-context.md` | Platform ka concept, backend modules, business rules, data models — poore project ka core |
| `user-frontend.md` | Users App ke screens, flows, UI behavior — end user ka full journey |
| `host-panel.md` | Host Panel ke screens, actions, rules |
| `admin-panel.md` | Admin Panel ke management screens, configurations |
| `support-panel.md` | Support Panel ke search tools |
| `manager-panel.md` | Manager Panel ke monitoring tools, alerts |
| `notifications.md` | Platform ki saari notifications — trigger, recipient, content |
| `project-agent-instructions.md` | Yeh file — rules, methodology, discussion progress |

---

## Yeh Files Kaise Aage Badhti Hain?

### Step 1 — Pehle discuss karo
Koi bhi cheez seedha final nahi hoti. Pehle user se discuss karo — clarifications, edge cases, decisions. Jab tak user confirm na kare, kuch bhi file mein mat daalo.

### Step 2 — Finalize hone par likhो
Jab koi cheez discuss hokar final ho jaaye — tabhi relevant file mein add karo. Draft ya uncertain decisions nahi likhni.

### Step 3 — Cross-reference check karo
Jab bhi kuch likho — socho: kya aur kisi file mein bhi iska mention hona chahiye? (Rule 1 aur Rule 2 follow karo)

### Step 4 — Is file mein progress update karo
Har finalized segment ke baad `project-agent-instructions.md` ke Discussion Progress section mein update karo. (Rule 4)

---

## Yeh Files Kaise Manage Hoti Hain?

- **Koi bhi file delete nahi hoti** jab tak user explicitly na bole
- **Decisions kabhi silently overwrite nahi hote** — agar koi purana decision change ho toh purana hata ke naya likho, ambiguity nahi rehni chahiye
- **"Finalized" tag wali cheezein** confirm decisions hain — inhe discuss kiye bina change mat karo
- **Nayi panel ya feature aaye** → pehle check karo kya existing file mein fit hota hai, agar nahi toh nayi file banao
- **Agent instructions mein likhа kuch bhi** — woh rule hai, suggestion nahi

---

## Rule 1 — Cross-File Feature Documentation

Jab bhi koi feature do ya zyada panels ya modules (e.g. Backend, Admin Panel, Host Panel, Support Panel, Manager Panel, Users App) ke beech mein kaam karta ho, toh **har us module ki file mein woh feature documented hona chahiye** — sirf us module ke perspective se.

### Sahi tarika:

**Example:** Host Panel mein host position assign karta hai → Backend prizes distribute karta hai.

- `host-panel.md` mein likhenge: host positions kaise assign karta hai
- `project-context.md` (backend) mein likhenge: positions receive karke prize distribution kaise hoti hai

Dono files mein feature hoga — lekin sirf apne apne kaam ke hisaab se.

### Galat tarika:

- ❌ Sirf ek file mein likhna aur doosri mein chhod dena
- ❌ Ek panel ki file mein doosre panel ka kaam detail karna
- ❌ Kisi panel ki file mein ek feature add karna jo us panel se related hi nahi hai (faaltu mention)

### Rule summary:

> **Agar Feature X, Panel A aur Panel B dono mein kaam karta hai → Feature X, dono files mein hona chahiye — har ek apne role ke saath.**
> **Agar Feature X sirf Panel A ka kaam hai → sirf Panel A ki file mein hoga.**

---

## Rule 2 — Backend aur Panel Files Sync

Har woh feature jiske liye backend kuch karta hai (API, database, calculation, timer, etc.) — woh `project-context.md` ke **"What Needs to Be Built"** section mein hona chahiye.

Agar kisi panel ki file mein ek feature hai jo backend se chalta hai, aur woh `project-context.md` mein nahi hai — toh woh ek gap hai, use fix karo.

---

## Rule 3 — Panel Files Scope

Har panel ki file mein **sirf woh content** hoga jo us panel ka actual kaam hai:

| Panel | Scope |
|---|---|
| `user-frontend.md` | User ke screens, flows, UI behavior |
| `host-panel.md` | Host ke actions, screens, rules |
| `admin-panel.md` | Admin ke management screens, configurations |
| `support-panel.md` | Support ke search tools aur read-only access |
| `manager-panel.md` | Manager ke monitoring tools, alerts |
| `project-context.md` | Backend modules, business rules, data models |
| `notifications.md` | Saari notifications — trigger, recipient, content |

---

## Rule 4 — Discussion Progress: Saath Saath Update Karo

Jab bhi koi nayi cheez discuss ho, finalize ho, ya koi decision ho — **usi waqt** is file ke "Discussion Progress" section mein update karo. Baad mein yaad karke nahi likhna — har message ke saath sync rehna.

---

## Discussion Methodology

Hum **ek segment at a time** discuss karte hain. Har segment mein yeh 5 cheezein cover hoti hain:

1. **Backend** — Is segment mein backend kya karta hai
2. **Admin Panel** — Is segment mein admin ka kya role hai
3. **Host Panel** — Is segment mein host ka kya role hai
4. **Support Panel** — Is segment mein support ka kya role hai
5. **Important Business Rules** — Is segment se related fixed product rules

**Important Business Rules ka matlab:** Woh fixed product decisions jo define karte hain ki system kisi situation mein kaise behave karega. UI ya backend implementation nahi — platform ke core business decisions. Sabhi modules inhe follow karte hain.

---

## Discussion Progress

> **Important:** Jab tak alag se mention na ho — saari discussed cheezein **OMBs aur Tournaments dono ke liye** apply hoti hain.

### ✅ Completed: Home Page → Pay & Join Button (Browse Flow)

**Flow:**
```
Home → Play → OMBs / Tournaments
  → Games → Modes → Entry Fees → Schedule Cards → Details Screen → Pay & Join
```

**Key points finalized:**
- Poora content Admin Panel se manage hota hai — Users App read-only hai
- Backend schedule cards aur details screen ka data serve karta hai
- Host aur Support ka is stage par koi role nahi

---

### ✅ Completed: Pay & Join → Completed (Full Lifecycle)

**OMB Flow:**
```
Pay & Join → Join Confirmation → My Play → Ongoing
  Waiting → Room Available → Result Pending → Completed
```

**Tournament Flow:**
```
Pay & Join → Join Confirmation → My Play → Ongoing
  Waiting → Ongoing (Initial Value) → Result Pending → Completed
```

**Important Business Rules finalized:**
- Join = Atomic transaction (Wallet Deduction + Seat Reservation + Match Join — teeno ya kuch nahi)
- Ek user ek contest mein sirf ek baar join kar sakta hai
- In-Game UID join ke baad lock
- Room ID/Password sirf configured reveal time par dikhega
- Ek host ek time par sirf ek match claim kar sakta hai
- Double Entry Verification match hone ke baad hi data accept hoga
- Hacker tag = prize 0 + refund 0, publicly visible
- Prize distribution sirf verified final results ke baad
- Contest configuration join hone ke baad immutable

**OMB-specific finalized:**
- OMB mein **"Match Running" status nahi hoga** — 3 stages hain: Waiting → Room Available → Result Pending → Completed
- "Match Running" show karna aur notification bhejana dono hataye gaye

---

### ✅ Completed: Match Auto-Creation System

**Flow:**
```
Pehla participant → Match #1 create (atomic lock)
Match #1 full → Next participant → Match #2 create
Aur aage aise hi...
```

**Important Business Rules finalized:**
- Match creation slot-level atomic lock ke saath — simultaneous requests mein duplicate nahi banega
- Seat reservation atomic — last seat race condition handled
- Overflow users nayi auto-created match mein jaate hain
- Har auto-created match usi slot ki no_proceed_policy inherit karta hai

---

### ✅ Completed: No Proceed Policy

**Trigger:**
- OMB: Room Details reveal time par last auto-created match check
- Tournament: Entry Closes time par last auto-created match check

**Rule:**
- Participants ≤ winner count → No Proceed Policy → Direct Completed + random prize distribution
- Participants ≥ winner count + 1 → Normal proceed

**Sirf last auto-created match check hota hai** — pehle wale matches fill hoke bane the.

---

### 🔄 Pending: Remaining User Frontend Flow

Abhi tak sirf OMB + Tournament ka join-to-complete flow discuss hua hai.
Baaki flows pending hain — next session mein continue karenge:
- Wallet flow (deposit, withdrawal, coins)
- Profile flow
- My Play → Ongoing details
- My Play → Completed details
- Competitors Position Schedule — user view

---

### ✅ Completed: Notification System Discussion

**Finalized notification rules:**
- Saari notifications push notifications hongi.
- Join successful hone par separate push nahi; Join Confirmation screen kaafi hai.
- Tournament ka start notification participant-specific hai — jis participant ka Initial Value save hoga, push sirf usi participant ko milegi.
- Entry Closes ke exactly 1 hour baad participants list release hone par sabhi joined participants ko push milegi.
- OMB/Tournament status, standings, completed result, low participation cancellation aur timeout cancellation ke relevant recipients ko push milegi.
- Timeout cancellation notice mein reason, refund/reward update aur apology hoga.
- Hacker/Cheater tag par affected participant ko notice/push aur support/appeal direction milegi; tag publicly visible rahega.
- Admin aur Support ko operational/support-relevant events par push notifications milengi.
- Notification history/archive store nahi hogi; current actionable notification state hi rakhi jaayegi.
