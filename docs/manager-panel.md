# Manager Panel — Notes

> Yeh file Manager Panel se related finalized decisions capture karti hai.
> Manager Panel ek alag project mein banega — yeh file wahan le jaai ja sakti hai.

---

## Manager Panel — Purpose

Manager Panel ka kaam platform ki **real-time operational health** monitor karna hai — specifically yeh ensure karna ki koi bhi match ya tournament bina host ke na reh jaaye.

---

## Unclaimed Match / Tournament Alert System (Finalized)

### Flow

```
Match / Tournament auto-create hua (pehle participant ke aate hi)
  └── Host Panel ke Available section mein appear hua
       └── Admin-configured timer shuru
            ├── Kisi ne claim kiya → No notification (sab theek)
            └── Timer expire, kisi ne claim nahi kiya
                 └── Manager Panel par notification aati hai
                      └── Manager snooze set karta hai (e.g. 1, 2, ya 5 minute)
                           ├── Us time mein claim hua → No notification
                           └── Us time mein bhi claim nahi hua → Dobara notification
                                └── (Loop — jab tak claim na ho ya manager handle na kare)
```

### Initial Alert Time
- Admin schedule banate waqt set karta hai — **"Notify manager after X minutes if unclaimed"**
- Har schedule ka apna alag time ho sakta hai
- Fixed nahi hai — admin ke control mein hai

### Snooze / Re-notification
- Manager khud snooze duration set karta hai (e.g. 1 min, 2 min, 5 min)
- Snooze expire hone ke baad bhi unclaimed → dobara notification
- Loop tab tak chalta hai jab tak match claim ho jaaye

### Applies To
- OMBs ✅
- Tournaments ✅

---

## Free Hosts List (Finalized)

Manager dekh sakta hai ki is waqt **kaun kaun se hosts free hain** — yaani jinke paas koi active assignment nahi hai.

### Layout

```
[ OMB Hosts ]  [ Tournament Hosts ]   ← do alag sections

OMB Hosts — Free Now
┌─────────────────────────────┐
│ Rakesh Kumar                │
│ +91 98765 43210             │
├─────────────────────────────┤
│ Amit Singh                  │
│ +91 91234 56789             │
└─────────────────────────────┘

Tournament Hosts — Free Now
┌─────────────────────────────┐
│ Priya Sharma                │
│ +91 99887 76655             │
└─────────────────────────────┘
```

### Details
- Sirf **free hosts** dikhenge — jo kisi match/tournament par assigned hain woh nahi dikhenge
- Har host ke saath: **Naam + Phone Number**
- Do alag sections: **OMB Hosts** aur **Tournament Hosts**
- Manager search bhi kar sakta hai naam se

---

## Host Timeout Alerts (Finalized)

Manager Panel ko automatic alerts milte hain jab host apna kaam time par na kare.

### OMB — Room ID Upload Timeout

| Trigger | Alert Content |
|---|---|
| Room ID reveal time + 3 min — host ne upload nahi kiya | Match ki saari details + Host ID → Manager Panel |
| Match start time + 5 min — room details abhi bhi nahi | Match auto-cancel (backend) — Manager ko inform |

### OMB + Tournament — Result Submission Timeout

| Trigger | Alert Content |
|---|---|
| Result deadline + 3 min — host ne result submit nahi kiya | Match/Tournament ki saari details + Host ID → Manager Panel |
| Result deadline + 5 min — result abhi bhi nahi | Match/Tournament auto-cancel (backend) — full refund — Manager ko inform |

### Applies To
- Room ID timeout: **OMBs only**
- Result timeout: **OMBs ✅ Tournaments ✅**

### Manager Push Notification Details (Finalized)

- Unclaimed match/tournament, room-details timeout aur result timeout alerts push notification ke roop mein milenge.
- Timeout ke baad auto-cancel hone par Manager ko cancellation/refund status ka push update milega.
- Notification mein Match/Tournament ID, Game, Mode aur Host ID hoga.
- Host claim ya result submit kar de to us event ki pending/re-notification push ruk jaayegi.

---

## Cancelled Match / Tournament — Voice Note (Finalized)

**Kab:** Koi bhi match ya tournament cancel ho jaaye (low participation / no_proceed_policy)

**Kya karta hai Manager:**
- Manager Panel mein cancelled match/tournament ke saamne ek **Voice Note** record kar sakta hai
- Voice note mein batata hai ki yeh match/tournament kis wajah se cancel hua

**Kahan dikhta hai:**
- **Manager Panel** — cancelled match/tournament ke saath
- **Admin Panel** — usi cancelled match/tournament ke record ke saath
