# Notifications — Notes

> Yeh file platform ke saare notification rules capture karti hai.
> Har module (Backend, Users App, Host Panel, Admin Panel, Support Panel, Manager Panel) ke liye relevant notifications yahan documented hain.

---

## Notification Policy (Finalized)

- Saari notifications ka delivery channel **push notification** hoga.
- Join successful hone par **separate push notification nahi** jaayegi; join confirmation screen par dikhaya jaayega.
- Notification event-specific recipients ko jaayegi — har event par sabhi roles ko notification nahi milegi.
- Notification history/archive store nahi hogi. Sirf current actionable notification state zaroorat ke mutabik rahegi; purane events ka alag notification record maintain nahi hoga.
- Cancellation/refund notices mein cancellation ka reason aur apology dono honge.

---

## Host Notifications

### 1. Naya Match / Tournament Available

**Trigger:** Kisi bhi slot ka pehla participant join karta hai → pehla match / tournament auto-create hota hai

**Recipient:** Us type ke **saare active hosts**
- OMB create hua → saare **OMB Hosts** ko notification
- Tournament create hua → saare **Tournament Hosts** ko notification

**Content:**
- OMB: *"New match available — [Game] [Mode] ₹[Entry]"*
- Tournament: *"New tournament available — [Game] [Mode] ₹[Entry]"*

**Purpose:** Host ko pata chale ki koi nayi match/tournament available section mein aa gayi hai claim karne ke liye

---

## Manager Notifications

### 2. Room ID Not Uploaded — Timeout Alert (OMB)

**Trigger:** Room ID reveal time ke **3 minute baad** bhi host ne Room ID upload nahi kiya

**Recipient:** Manager

**Content:** *"Host has not uploaded Room ID — [Match ID] [Game] [Mode]. Host ID: [Host ID]. Match details attached."*

**Follow-up:** Match start time ke 5 min baad bhi nahi → Match auto-cancel + full refund. Manager, Admin aur Support ko operational push update milega; participants ko reason, refund aur apology ke saath cancellation push milegi.

---

### 3. Result Not Submitted — Timeout Alert (OMB + Tournament)

**Trigger:** Result submission deadline ke **3 minute baad** bhi host ne result submit nahi kiya

**Recipient:** Manager

**Content:** *"Host has not submitted result — [Match/Tournament ID] [Game] [Mode]. Host ID: [Host ID]. Details attached."*

**Follow-up:** Deadline ke 5 min baad bhi nahi → Auto-cancel + full refund. Manager, Admin aur Support ko operational push update milega; participants ko reason, refund aur apology ke saath cancellation push milegi.

---

### 4. Unclaimed Match / Tournament Alert

**Trigger:** Match ya tournament create hone ke baad **admin-configured time** tak kisi host ne claim nahi kiya
*(Yeh time Admin Panel mein schedule banate waqt set hota hai — "Manager alert after X minutes")*

**Recipient:** **Manager**

**Content:**
- OMB: *"Match unclaimed — [Game] [Mode] ₹[Entry]. No host has claimed it yet."*
- Tournament: *"Tournament unclaimed — [Game] [Mode] ₹[Entry]. No host has claimed it yet."*

**Re-notification:** Manager snooze duration set karta hai (e.g. 1, 2, 5 min) → agar phir bhi unclaimed → dobara notification (loop)

**Applies to:** OMBs ✅ Tournaments ✅

---

## User Notifications

### 3. Match / Tournament Cancelled — Low Participation

**Trigger:** Last auto-created match/tournament no_proceed_policy trigger kare (participants ≤ winner count at deadline)

**Recipient:** Us match/tournament ke **saare joined participants**

**Content:**
- OMB: *"Your match was cancelled due to low participation. Awards have been distributed randomly. Check your wallet."*
- Tournament: *"Your tournament was cancelled due to low participation. Rewards have been distributed randomly. No amount was lost."*
- Notification mein cancellation ka reason, wallet/reward update aur apology bhi hogi.

---

### 4. Match Cancelled — Room Details Timeout (OMB)

**Trigger:** Match start time ke 5 minute baad bhi host ne Room ID/Password upload nahi kiya

**Recipient:** Us match ke saare joined participants

**Content:** *"We’re sorry — your match was cancelled because room details were not uploaded on time. Your entry fee has been refunded."*

---

### 5. Match/Tournament Cancelled — Result Timeout

**Trigger:** Result deadline ke 5 minute baad bhi host ne result submit nahi kiya

**Recipient:** Us match/tournament ke saare joined participants

**Content:** *"We’re sorry — your [match/tournament] was cancelled because the result was not submitted on time. Your entry fee has been refunded."*

---

### 6. Room Details Available (OMB)

**Trigger:** Host Room ID aur Password add karta hai → match status **Waiting → Room Available**

**Recipient:** Us match ke **saare joined participants**

**Content:** *"Room details are now available for your match — [Game] [Mode]. Join now!"*

---

### 7. Tournament Participant Started (Tournament)

**Trigger:** Host kisi particular participant ki Initial Value confirm karta hai

**Important:** Har participant ka start time alag ho sakta hai. Isliye notification sirf us participant ko jaayegi jiska Initial Value save hua hai; sabhi participants ko ek saath start notification nahi jaayegi.

**Recipient:** Wahi participant

**Content:** *"Your tournament has started — [Game] [Mode]. Good luck!"*

---

### 8. Tournament Participants List Available

**Trigger:** Entry Closes ke exactly 1 hour baad participants list release hoti hai

**Recipient:** Us tournament ke saare joined participants

**Content:** *"The participant list for your tournament is now available — [Game] [Mode]."*

**Privacy:** Push se khulne wali list mein Game ID hogi; Platform User ID, mobile aur email nahi honge.

---

### 9. Competitors Position Reveal (Tournament)

**Trigger:** Host scheduled position reveal ke liye saari values submit karta hai → backend chart publish karta hai

**Recipient:** Us tournament ke **saare joined participants**

**Content:** *"Standings update is out for your tournament — [Game] [Mode]. Check your position!"*

---

### 10. Status Change Notifications (OMB)

**Recipient:** Us match ke saare joined participants

| Status Change | Notification |
|---|---|
| Waiting → Room Available | *"Room details are now available for your match — [Game] [Mode]. Join now!"* |
| Room Available → Result Pending | *"Your match has ended. Results are being processed — [Game] [Mode]."* |
| Result Pending → Completed | *"Results are out! Check your match result — [Game] [Mode]."* |

---

### 11. Status Change Notifications (Tournament)

**Recipient:** Us tournament ke saare joined participants

| Status Change | Notification |
|---|---|
| Waiting → Ongoing | Separate global push nahi; har participant ko uske Initial Value save hone par participant-specific push milti hai |
| Ongoing → Result Pending | *"Your tournament duration is complete. Results are being processed — [Game] [Mode]."* |
| Result Pending → Completed | *"Results are out! Check your tournament result — [Game] [Mode]."* |

---

### 12. Hacker / Cheater Tag

**Trigger:** Host kisi participant ko Hacker/Cheater tag karke result submit karta hai

**Affected participant ko push:** *"A Hacker/Cheater tag has been applied to your result. Please review the notice and contact Support if you want to raise an appeal."*

**Public notice:** Result/details screen par tag clearly visible rahega. Is notice ko us event ke relevant participants, Admin aur Support dekh sakte hain.

**Business rule:** Tagged participant ko prize = 0 aur refund = 0 milega.

---

## Admin and Support Push Notifications

Admin aur Support ko operational/support-relevant events par push notifications milengi:

- Low participation cancellation
- Room details timeout se auto-cancel + refund
- Result submission timeout se auto-cancel + refund
- Hacker/Cheater tag

Push notification se relevant Match/Tournament ID aur current details open hongi. Admin aur Support ko user ke normal status updates ya hosts ke available-work alerts nahi bheje jaayenge; woh respective panels mein current state dekh sakte hain.
