---
name: Push notification policy
description: Finalized delivery, recipient, and retention rules for competition lifecycle notifications.
---

All competition lifecycle notifications use push delivery. Join success is shown in the Join Confirmation screen and does not create a separate push. Recipients remain event-specific: users, hosts, managers, Admin, and Support receive only the events relevant to their role.

**Why:** The product discussion explicitly chose push notifications for everyone while avoiding redundant join alerts and unnecessary historical notification storage.

**How to apply:** When implementing or extending a notification event, define its trigger, recipient role(s), message/action, and current-state behavior in `docs/notifications.md` and the connected panel documentation. Do not introduce an archived notification-history store unless the product decision changes.