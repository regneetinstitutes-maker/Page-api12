---
name: Discussion Style — User Frontend Flow
description: How to discuss user frontend flow with the user — segment by segment, with roles of Backend/Admin/Host/Support only within that segment.
---

# Discussion Style Rule

User frontend ka flow **ek segment at a time** discuss karna hai.

- Har message mein sirf **utna hi flow** batana jitna us message mein scope tha
- Har segment ke saath **4 cheezein** batani hain — sirf us segment ke context mein:
  1. Backend
  2. Admin Panel
  3. Host Panel
  4. Support Panel
- Poora flow ek saath nahi batana
- Next segment tab discuss karna jab user kehein

# Important Business Rules — Definition

Fixed product rules jo define karte hain ki system kisi situation mein kaise behave karega.
UI design ya backend implementation nahi hote — platform ke core business decisions hote hain.
Inhe sabhi modules follow karte hain: Users App, Backend, Host Panel, Admin Panel, Support Panel.

Har segment discussion mein relevant business rules bhi include karni hain agar woh us segment se related hon.

# No Proceed Policy — Correct Rule

Trigger: Room Details reveal time par — agar last auto-created match mein participants ≤ winner count hain.
Sirf LAST match check hota hai — pehle wale matches fill ho ke bane the.
Result: Direct Completed + random prize distribution.
"Start hone wala ho" wali language GALAT hai — Room Details time se tied hai.
Exact boundary: participants ≥ winner count + 1 → normal proceed. participants ≤ winner count → no proceed policy.

# Current progress:
- [DONE - overview only] Home → Pay & Join (high level, user ne bola zyada tha)
- [NEXT] Home page → Pay & Join button — **segment-by-segment detail** shuru karni hai
