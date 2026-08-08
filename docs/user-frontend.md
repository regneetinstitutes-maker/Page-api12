# User Frontend (Users App) — Notes

> Yeh file Users App se related finalized decisions capture karti hai.
> Users App ek alag project mein banega — yeh file wahan le jaai ja sakti hai.
> Main decisions `project-context.md` mein bhi hain.

---

## Final Terminology (Finalized)

| Full Name | Short Label (UI mein yahi dikhega) |
|---|---|
| Game Name | Game |
| Mode Name | Mode |
| Number of Participants | Participants |
| Number of Teammates | Team Size |
| Entry Fee | Entry |
| Prize Distribution | Prizes |
| Guide Video | Guide |
| Start Date & Time | Starts On |
| Entry Close Date & Time | Entry Closes |
| Tournament Duration | Duration |
| Result Date & Time | Results On |
| Room ID & Password Available Time | Room Details |
| Admin Information | Notes |
| Game ID Name | In-Game Name |
| Game UID | In Game UID |
| Join Now / Pay & Join | Pay & Join |

---

## Content Hierarchy

```
Game  ← Logo + Name
  └── Mode  ← Logo + Name
        └── Entry Fee (e.g. ₹50, ₹100)
              └── Schedule (time slot — alag entity nahi, sirf timings hain)
```

---

## Play Section — Top Level Structure

```
Home → Play Button

Play
├── OMBs
├── Tournaments
└── My Play
    ├── Ongoing
    │   ├── OMBs
    │   └── Tournaments
    └── Completed
        ├── OMBs
        └── Tournaments
```

---

## OMBs — Browse & Join Flow (Finalized)

### Navigation
```
Play → OMBs → Games → Modes → Entry Fees → Schedule Cards → Details Screen
→ Enter / Select Game ID → Pay & Join → Joined → My Play
```

### Schedule Card Fields
Game, Mode, Entry, Participants, Team Size, Starts On

### OMB Details Screen Fields
Game, Mode, Guide, Participants, Team Size, Entry, Prizes, Starts On, Room Details, Notes, In Game UID, In-Game Name, **Pay & Join**

- **Room Details**: Starts On se pehle reveal hoga — reveal offset **Admin-configured** hai (schedule banate waqt set hota hai), fixed 10 minutes nahi
- **Room Details timeout**: Configured reveal time ke 3 minutes baad bhi Room ID/Password upload na ho to match details aur host ID Manager Panel mein jayegi. Starts On ke 5 minutes baad tak bhi Room Details na aaye to match auto-cancel hoga aur sabhi participants ko refund milega.
- **Notes**: Free-text field
- Game ID join ke baad **lock**

### Join Confirmation Popup
**Success:**
> Successfully Joined

**Fail:**
> Unable to Join
> Reason: ...

### OMB — Participants Count Visibility
User ko apne match mein kitne participants join hue hain **nahi dikhega**

---

## Tournaments — Browse & Join Flow (Finalized)

### Navigation
```
Play → Tournaments → Games → Modes → Entry Fees → Schedule Cards → Details Screen
→ Enter / Select Game ID → Pay & Join → Joined → My Play
```

### Tournament Schedule Card Fields
Game, Mode, Entry, Participants, Team Size, Entry Closes
*(Starts On intentionally nahi hai)*

### Tournament Details Screen Fields
Game, Mode, Guide, Participants, Team Size, Entry, Prizes, Entry Closes, Duration, Results On, Notes, In Game UID, **Pay & Join**
*(In-Game Name intentionally nahi hai)*

### Tournament — Participants List
- Entry Closes ke exactly **1 hour baad** — saare participants ko us tournament ke participants ki list milti hai
- List mein: **Game ID** + (additional fields — baad mein finalize hongi)
- **Nahi hoga**: Platform User ID, Mobile, Email *(privacy)*

---

## My Play — Ongoing → OMBs (Finalized)

### Ongoing OMB Card

**Normal Info:**
Game, Mode, Entry, Participants, Team Size, Starts On

**⭐ Highlight Section:**
- **Status** (colored pill/badge — always prominent)
- Agar Status = Room Available → highlight mein saath dikhega: **Room ID & Password Available** (sabse prominent element)

### OMB Status (3 Stages)

| Status | Color | Matlab |
|---|---|---|
| **Waiting** | 🟡 Yellow | User join kar chuka hai. Room ID abhi available nahi. |
| **Room Available** | 🔵 Blue | Host ne Room ID aur Password add kar diye. User game join kar sakta hai. |
| **Result Pending** | 🟠 Orange | Match khatam. Host result upload kar raha hai. Result aate hi Completed mein shift. |

### Ongoing OMB — Card pe Tap → Details Screen

| Field | Detail |
|---|---|
| Game Name | — |
| Mode Name | — |
| Match ID | — |
| Match Start Date & Time | — |
| Number of Participants | — |
| Number of Teammates | — |
| Prize Distribution | — |
| Room ID | Jab host add kare |
| Password | Jab host add kare |
| Room ID & Password Copy Button | — |
| Admin Information (Notes) | — |
| Status | Waiting / Room Available / Result Pending |

*(Join Now / Pay & Join nahi hoga — user already join kar chuka hai)*

---

## My Play — Ongoing → Tournaments (Finalized)

### Ongoing Tournament Card

**Normal Info:**
Game, Mode, Entry, Participants, Team Size, Entry Closes, Results On

**⭐ Highlight Section:**
- **Status** (colored pill/badge — always prominent)

### Tournament Status (3 Stages)

| Status | Color | Matlab |
|---|---|---|
| **Waiting** | 🟡 Yellow | User join kar chuka hai. Entry close nahi hui ya host ne Initial Rank record nahi ki. |
| **Ongoing** | 🟢 Green | Initial Rank record ho chuki hai. Tournament chal raha hai. |
| **Result Pending** | 🟠 Orange | Tournament duration complete. Host Final Rank verify kar raha hai. Result aate hi Completed mein shift. |

### Ongoing Tournament — Card pe Tap → Details Screen

| Field | Detail |
|---|---|
| Tournament ID | — |
| Game | — |
| Mode | — |
| Guide | — |
| Participants | — |
| Team Size | — |
| Entry | — |
| Prizes | — |
| Entry Closes | — |
| Duration | — |
| Results On | — |
| Initial Value | Host confirm karne ke baad dikhegi (e.g. Eliminations = 78) |
| Status | Waiting / Ongoing / Result Pending |
| Notes | — |
| In Game UID | — |

*(Join Now nahi hoga — user already join kar chuka hai)*

### Push Notifications (Finalized)

- Join successful hone par separate push notification nahi jaayegi; Join Confirmation screen par dikhaya jaayega.
- OMB mein Room ID/Password available hone par us match ke sabhi joined participants ko push notification milegi.
- OMB Result Pending hone par match end aur result processing ka push milega; Completed hone par final result aur prize dekhne ka push milega.
- OMB low participation, room-details timeout ya result timeout cancellation par cancellation reason, refund/reward update aur apology ke saath push notification milegi.
- Tournament mein har participant ka start time alag hota hai. Host jis participant ka Initial Value save karega, push notification sirf usi participant ko milegi.
- Entry Closes ke exactly 1 hour baad participants list available hone par sabhi joined participants ko push notification milegi.
- Scheduled competitor standings publish hone par sabhi joined participants ko push notification milegi.
- Participant ka duration complete hone par us participant ko Result Pending push notification milegi.
- Result Completed hone par joined participants ko result dekhne ki push notification milegi.
- Low participation, room-details timeout ya result timeout cancellation par cancellation reason, refund/reward update aur apology ke saath push notification milegi.
- Hacker/Cheater tag lagne par affected participant ko notice aur appeal/support direction ke saath push notification milegi. Tag result mein publicly visible rahega.
- Notification history/archive store nahi hogi; app sirf current actionable notification state use karegi.

---

## My Play — Completed → OMBs (Finalized)

### Completed OMB Card
Game, Mode, Match ID, Final Position, Prize Won

### Completed OMB — Card pe Tap → Details Screen

**Result Section:**
Match ID, Position, Prize Won, Result Status

**Match Information Section:**
Game Name, Mode Name, Participants, Team Size, Start Date & Time, Prize Distribution (complete), Notes

**Screenshot:**
- Match ka in-game result screenshot (poore match ka, kisi ek participant ka nahi)
- Host ne jo upload kiya hoga — saare participants ko dikhega

**Hacker / Cheating Tag:**
- Agar kisi participant ko host ne Hacker/Cheater tag diya ho → result mein clearly dikhega
- No prize, no refund — tag publicly visible hai sabko

**❌ Completed Details mein nahi hoga:**
Guide, Room Details, In-Game Name, In Game UID, Pay & Join

---

## My Play — Completed → Tournaments (Finalized)

### Completed Tournament Card
Game, Mode, Tournament ID, Tournament Rank, Prize Won

### Completed Tournament — Card pe Tap → Details Screen

| Field | Detail |
|---|---|
| Tournament ID | — |
| Game | — |
| Mode | — |
| Participants | — |
| Team Size | — |
| Entry | — |
| Prizes | — |
| Entry Closes | — |
| Duration | — |
| Results On | — |
| Initial Value | Metric value jab tournament start hua (e.g. Eliminations = 78) |
| Final Value | Metric value jab tournament end hua (e.g. 236) |
| Tournament Rank | Backend calculated — highest Performance = Rank 1 |
| Prize Won | — |
| Notes | — |

**Participants Ranking Table:**

| Tournament Rank | Game ID | Initial Value | Final Value | Performance |
|---|---|---|---|---|
| 1 | Alpha | 45 | 203 | 158 |
| 2 | Shadow | 78 | 218 | 140 |
| 3 | Demon | 120 | 241 | 121 |

**Performance = Final Value − Initial Value** (backend calculate karta hai)

**Privacy rules — ranking mein kabhi nahi dikhega:**
- ❌ Platform User ID
- ❌ Mobile Number
- ❌ Email

---

## Auto Reward Case — Low Participation (Finalized)

**Condition:** Participants ≤ Auto Reward Limit (winner count)

**Behavior:**
- Card **kabhi Ongoing mein nahi jaayega**
- **Direct Completed** mein aayega

**Details screen ke upar message:**
> "This tournament was cancelled due to low participation. To ensure fairness, rewards were distributed randomly according to the prize chart. No participant lost anything."

*(Same rule OMBs ke liye bhi — refer `project-context.md` Low Participation Rule)*

---

## OMB vs Tournament — Final Differences (Finalized)

| | OMB Ongoing | Tournament Ongoing |
|---|---|---|
| Special field | Room Details (jab available) | Initial Rank (jab confirmed) |
| Key status info | Status + Room availability | Status |

| | OMB Completed | Tournament Completed |
|---|---|---|
| Result info | Position, Prize Won | Initial Rank, Final Rank, Tournament Rank, Prize Won |
| Ranking table | ❌ | ✅ (Game ID + Tournament Rank + Initial/Final Rank) |

---

## Status Badge Design (Finalized)

Status ko **colored pill/badge** ke roop mein dikhana hai — sirf text nahi.

| Status | Color |
|---|---|
| Waiting | 🟡 Yellow |
| Room Available | 🔵 Blue |
| Ongoing *(Tournament only)* | 🟢 Green |
| Result Pending | 🟠 Orange |

Premium apps (Discord, Notion, GitHub) jaisa clean look — user ek second mein samajh jaaye.

---

## User Journey Flows (Finalized)

### OMB Complete Journey
```
Play → OMBs → Games → Modes → Entry Fees → Schedule Cards → Details Screen
→ Enter / Select Game ID → Pay & Join → Join Confirmation
→ My Play → Ongoing → Waiting
→ Host adds Room ID → Room Available
→ Host uploads Result → Result Pending
→ Backend distributes Prize → Completed
```

### OMB — Host Timeout Rules (Finalized)

- **Room Details deadline:** Admin-configured reveal time.
- **Room Details Manager alert:** Configured reveal time ke 3 minutes baad bhi Room ID/Password na aaye to match details aur host ID Manager Panel mein bheji jayegi.
- **Room Details auto-cancel:** Starts On ke 5 minutes baad tak bhi Room Details na aaye to match cancel hoga aur sabhi participants ko refund milega.
- **Result deadline:** Starts On ke **1.5 hours baad** tak host ko result/positions submit karne honge.
- **Result Manager alert:** Result deadline ke 3 minutes baad bhi result submit na ho to match details aur host ID Manager Panel mein bheji jayegi.
- **Result auto-cancel:** Result deadline ke 5 minutes baad tak bhi result/positions submit na ho to match cancel hoga aur sabhi participants ko refund milega.

### Tournament Complete Journey
```
Play → Tournaments → Games → Modes → Entry Fees → Schedule Cards → Details Screen
→ Enter / Select Game ID → Pay & Join → Join Confirmation
→ My Play → Waiting
→ Host enters Initial Value → Confirm → Ongoing → Duration starts
→ Duration ends → Host enters Final Value → Result Pending
→ Backend calculates Tournament Ranking → Prize Distribution
→ Completed
```

---

## Important Rules (Finalized)

### Game ID Rules
- Join karte waqt enter / select karna hoga
- Join ke baad **lock** — change nahi hoti
- Cards mein locked state mein dikhti hai

### Match / Tournament ID
- Har event ki unique **public ID** — user ko dikhti hai
- Support isi se kaam karta hai

### Privacy
Participants ek dusre ki yeh cheezein **kabhi nahi dekh sakte:**
- Platform User ID, Mobile Number, Email

Sirf dekh sakte hain (tournament ranking mein): Game ID, Tournament Rank, Initial/Final In-Game Rank

---

## Competitors Position Schedule — User View (Finalized)

Tournament ke dauran, scheduled times par participants ko **competitors ki current standings** ki chart milti hai.

**Notification:** Jab bhi koi position reveal publish ho, saare participants ko notification aati hai.

**Chart mein dikhega:**

| Position | Game ID | [Metric Name] | At |
|---|---|---|---|
| 1 | Alpha | 203 | At 7:02 PM |
| 2 | Shadow | 178 | At 7:05 PM |
| 3 | Demon | 165 | At 7:08 PM |

- **[Metric Name]** = tournament ka metric (e.g., *Eliminations*, *Score*, *Wins*) — generic label nahi
- **At** = submission time ka label — "submission time" word nahi dikhega
- Sirf **winner counts** jitne top participants dikhenge
- **Privacy**: sirf Game ID dikhega — User ID / Mobile / Email nahi

---

## Low Participation — Auto-Cancel Notice (Finalized)

**OMBs:**
> "This match was canceled due to low participation. To ensure fairness, awards were distributed randomly according to the awards chart."

**Tournaments:**
> "This tournament was cancelled due to low participation. To ensure fairness, rewards were distributed randomly according to the prize chart. No participant lost anything."
