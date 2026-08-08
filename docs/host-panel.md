# Host Panel — Notes

> Yeh file Host Panel se related finalized decisions capture karti hai.
> Host Panel ek alag project mein banega — yeh file wahan le jaai ja sakti hai.
> Main decisions `project-context.md` mein bhi hain.

---

## Host Roles (Finalized)

Do alag roles hain — Admin Panel se assign hoti hain:

| Role | Kya dikhta hai |
|---|---|
| **OMB Host** | Sirf OMBs (available + running) |
| **Tournament Host** | Sirf Tournaments (available + running) |

---

## Host Panel Structure (Finalized)

```
Host Panel
├── Available      ← unclaimed matches/tournaments
└── Running        ← claimed aur currently active
```

- Backend auto-create karta hai matches/tournaments jab participants join karte hain
- Yeh matches host panel ke **Available** section mein appear hote hain
- Koi bhi available host aakar **claim** kar sakta hai

### Claim Rules
- Ek host ek time pe **sirf ek hi** match/tournament claim kar sakta hai
- Jab current assignment complete ho jaaye, tab nayi claim ho sakti hai

---

## OMB Host — Available Section

Har card mein:

| Field |
|---|
| Match ID |
| Game |
| Mode |
| Entry |
| Entry Close Time |
| Participants (joined so far) |
| **Claim** button |

---

## OMB Host — Running Section (Finalized)

Match claim karne ke baad Running section mein aata hai.

### Running OMB Screen Layout

**Top:**
- Room ID & Password dene ka time likha hoga *(Admin-configured — schedule banate waqt set hota hai)*
- Room ID input field
- Password input field

### Room ID Upload — Timeout Rules

| Time | Kya hota hai |
|---|---|
| Reveal time + 3 min — Room ID abhi bhi upload nahi | Manager Panel ko alert jaata hai — match ki saari details + host ID ke saath |
| Match start time + 5 min — Room details abhi bhi nahi | Match auto-cancel → saare participants ko full refund |

### Result Submission — Timeout Rules

| Time | Kya hota hai |
|---|---|
| Result deadline + 3 min — result abhi bhi submit nahi | Manager Panel ko alert jaata hai — match ki saari details + host ID ke saath |
| Result deadline + 5 min — result abhi bhi nahi | Match auto-cancel → saare participants ko full refund |

**Section 1 — Match Details**
- Saari match information (Game, Mode, Participants, Team Size, Prizes, Start Time, Notes, etc.)

**Section 2 — Participants List**
- Har participant: In-Game UID + Game ID Name
- Position assign karne ka option

### Participant Room Confirmation (OMBs only)

Room ID dene ke baad, participants list mein har participant ke aage ek **Confirm Tick** option hoga:

- Jab participant room mein aa jaaye, host aake confirm karta hai
- **Process (2 steps):** Empty box pe click → Confirm → ✅ Green tick lag jaata hai
- Single click se confirm nahi hoga — do steps zaroori hain

**Participant Search:**
- Host participant ka naam partial search se dhundh sakta hai
- e.g., "ha" type karo → "Rohan" appear ho jaata hai (partial match works)

---

### Position Assignment Flow

1. Host jis participant ke position box pe tap kare → **Confirm** dabaye → us participant ko **1st position** milti hai → list mein sabse upar aa jaata hai
2. Next participant → Confirm → **2nd position** → list mein second number pe
3. Isi tarah saari positions di jaati hain

### Double Entry Verification (Room ID/Password + Positions dono ke liye)

```
Step 1: Enter value → Confirm
Step 2: Enter same value again → Confirm
Match → ✅ Submit
Differ → ❌ Popup: "You haven't entered information correctly.
                    Please re-enter carefully and with concentration."
```

Yeh rule Room ID/Password dono ke liye aur position assignment ke liye bhi lagu hota hai.

### Hacker / Cheating Tag (OMBs + Tournaments)

Position assignment ke dauran, host kisi bhi participant ko **Hacker / Cheater** tag de sakta hai:

**Rules:**
- Tagged participant ko: **koi prize nahi, koi refund nahi** — sab zero
- Double Entry Verification lagta hai iss tag pe bhi
- Tag **publicly visible** hai — koi restriction nahi:
  - Match/Tournament results mein sabhi participants ko dikhega
  - Match/Tournament ID se search karne par list mein bhi aayega
  - Participant ke apne completed card/details mein bhi dikhega

### Screenshot Upload (OMBs only)

Position submission ke dauran, host ko ek **Screenshot Upload** ka option bhi milega:

- Screenshot = in-game match ka result screenshot
- Yeh **poore match ka** screenshot hai — kisi particular participant ka nahi
- Match ID ke saath store hoga
- Participants ke **Completed OMBs** mein unke app mein bhi dikhega

### Release Button

- Running screen par ek **Release** button hoga
- Tap karne par **direct release nahi hoga**
- Text field mein **"release"** type karna hoga → **Confirm** dabana hoga
- Tab match release hoga aur Available section mein wapas jaayega

### No Proceed Policy — Host ke liye

- Agar koi match available section mein pada ho aur **Room Details reveal time** aa jaaye jab tak claimed nahi hua — backend automatically no_proceed_policy trigger karega
- Woh match **available section se hata diya jaayega** (cancelled)
- Participants ko cancellation notification jaayegi
- Host ko kuch karne ki zaroorat nahi — backend handle karta hai

### Host Push Notifications (Finalized)

- Pehla participant join karte hi auto-created OMB ke liye saare active OMB Hosts ko push notification milegi.
- Push mein Match ID, Game, Mode, Entry aur claim action hoga.
- Host claim karte hi us match ka unclaimed/re-notification flow ruk jaayega.

---

## Tournament Host — Available Section

Har card mein:

| Field |
|---|
| Tournament ID |
| Game |
| Mode |
| Entry |
| Entry Close Time |
| Duration |
| Participants (joined so far) |
| **Claim** button |

### Tournament Host Push Notifications (Finalized)

- Pehla participant join karte hi auto-created tournament ke liye saare active Tournament Hosts ko push notification milegi.
- Push mein Tournament ID, Game, Mode, Entry aur claim action hoga.
- Host claim karte hi us tournament ka unclaimed/re-notification flow ruk jaayega.

---

## Tournament Host — Running Section (Finalized)

### Running Tournament Screen Layout

**Tournament Details:**

| Field |
|---|
| Tournament ID |
| Game |
| Mode |
| Tournament Metric *(e.g. Eliminations, Score, Wins)* |
| Entry |
| Participants |
| Team Size |
| Prize Chart |
| Entry Close Time |
| Duration |
| Results On |
| Notes |

**Participants List:**

Har participant ke saamne:
- In Game UID
- **Initial Value** *(host enter karega)*
- **Final Value** *(host enter karega)*

### Initial Value Entry (Per Participant)

1. Host game mein jaata hai, us participant ki **current metric value** note karta hai *(e.g. Eliminations = 78)*
2. Host Panel mein **Double Entry Verification** se value enter karta hai
3. Save hote hi **usi timestamp** se us participant ka tournament officially start hota hai *(Start Time lock, End Time lock)*

### Final Value Entry (Per Participant)

1. Exactly **Start Time + Duration** ke waqt host game mein hota hai
2. Us waqt us participant ki **final metric value** note karta hai *(e.g. 236)*
3. Host Panel mein **Double Entry Verification** se value enter karta hai

### Double Entry Verification (Same as OMBs)

```
Step 1: Enter value → Confirm
Step 2: Enter same value again → Confirm
Match → ✅ Save
Differ → ❌ Popup: "You haven't entered information correctly.
                    Please re-enter carefully and with concentration."
```

### Backend Calculation (After Final Value)

```
Performance = Final Value − Initial Value
Example: 236 − 78 = 158
```

- Sabse zyada Performance = Tournament Rank 1
- Uske baad Rank 2, Rank 3, ...
- Prize distribution automatically isi ranking ke hisaab se hoti hai

### Competitors Position Schedule (Finalized)

Tournament ke dauran participants ko competitors ki live standings nahi pata hoti. Iske liye **scheduled position reveals** hote hain.

**Concept:**
- Admin tournament create karte waqt ek ya zyada **position reveal schedules** set karta hai (specific date & time)
- Schedule ke 1–2 hours pehle, host ek ek karke **saare participants ki current metric value** game mein check karta hai
- Host Panel mein us schedule ke under har participant ki value enter karta hai *(single entry — double verification nahi)*
- Jab saari values submit ho jaayein → backend:
  - Winner counts jitne top participants ki list banata hai
  - Chart publish karta hai (Game ID + metric value + submission time)
  - Saare participants ko **notification** jaati hai

**Chart mein terminology (metric ke hisaab se):**
- "Numerical rank value" ya "submission time" **nahi likhenge**
- Metric naam use hoga: e.g., *"Eliminations"* (not "numerical rank value")
- Time ke liye: *"At [time]"* (not "submission time")

**Example chart (Eliminations tournament):**

| Position | Game ID | Eliminations | At |
|---|---|---|---|
| 1 | Alpha | 203 | At 7:02 PM |
| 2 | Shadow | 178 | At 7:05 PM |
| 3 | Demon | 165 | At 7:08 PM |

**Host Panel — Competitors Position Schedule Section:**
- Running tournament screen mein ek alag section: **Competitors Position Schedules**
- Har schedule ke under: participants ki list + metric value input field
- Submit karo → backend publish karta hai

### Release Button

Same as OMBs — type "release" + Confirm.
