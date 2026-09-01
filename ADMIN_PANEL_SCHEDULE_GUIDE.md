# Admin Panel Schedule Design Guide

## Backend Truth

Schedule.startsAt = **Match start time** (for OMB)
Schedule.entryClosesAt = **Entry closing time** (for Tournament)

Source: [artifacts/api-server/src/lib/competition.ts](artifacts/api-server/src/lib/competition.ts#L325)
```ts
const closingTime = schedule.type === "omb" ? schedule.startsAt : schedule.entryClosesAt;
```

---

## Structure: Game → Mode → Schedule

### Hierarchy
```
Game (e.g., PUBG Mobile)
  └─ Mode (e.g., Solo)
      ├─ Schedule 1 (10:00 AM - OMB competition)
      ├─ Schedule 2 (2:00 PM - Tournament competition)
      └─ Schedule 3 (5:00 PM - OMB competition)
```

---

## Admin Panel Form Structure

### Step 1: Create Game
**Route:** `POST /api/admin/competition/games`

Fields:
- name (required): string
- logoUrl (optional): URL

Example:
```json
{
  "name": "PUBG Mobile",
  "logoUrl": "https://example.com/pubg.png"
}
```

---

### Step 2: Create Mode
**Route:** `POST /api/admin/competition/modes`

Fields:
- gameId (required): select from game list
- name (required): string (Solo, Duo, Squad, etc.)
- logoUrl (optional): URL

Example:
```json
{
  "gameId": "game-uuid-here",
  "name": "Solo",
  "logoUrl": "https://example.com/solo.png"
}
```

**Key Point:** Mode just has name. No entry fee, no prizes, no timing here.

---

### Step 3: Create Schedule (Main Config)
**Route:** `POST /api/admin/competition/schedules`

This is where ALL competition config lives:

#### For OMB Type
```json
{
  "modeId": "mode-uuid-here",
  "type": "omb",
  "status": "published",
  "entryFee": 50,
  "maxParticipants": 20,
  "teamSize": 1,
  "startsAt": "2026-09-02T10:00:00.000Z",
  "roomRevealMinutesBeforeStart": 15,
  "resultDeadlineMinutes": 90,
  "managerAlertAfterMinutes": 5,
  "prizes": [
    { "position": 1, "amount": 500 },
    { "position": 2, "amount": 250 }
  ],
  "guideVideoUrl": "https://example.com/guide.mp4",
  "notes": "OMB match at 10 AM"
}
```

**What startsAt means for OMB:**
- Match will start at this exact time
- Players can join ONLY before this time
- Room details revealed 15 minutes before
- If no results submitted after deadline (90 min), auto-cancel

#### For Tournament Type
```json
{
  "modeId": "mode-uuid-here",
  "type": "tournament",
  "status": "published",
  "entryFee": 100,
  "maxParticipants": 16,
  "teamSize": 1,
  "entryClosesAt": "2026-09-02T13:30:00.000Z",
  "durationMinutes": 60,
  "tournamentMetric": "score",
  "resultDeadlineMinutes": 90,
  "managerAlertAfterMinutes": 5,
  "prizes": [
    { "position": 1, "amount": 2000 }
  ],
  "guideVideoUrl": "https://example.com/guide.mp4",
  "notes": "Tournament starting at 2:00 PM, entry closes at 1:30 PM"
}
```

**What entryClosesAt means for Tournament:**
- Entry closes at this time
- Match starts after entry closes (automatically by scheduler)
- Tournament runs for durationMinutes (60 min in example)

---

## Key Differences: OMB vs Tournament

| Aspect | OMB | Tournament |
|--------|-----|-----------|
| Time Field | `startsAt` (match start) | `entryClosesAt` (entry closes) |
| Schedule Time = | Match starts at this exact time | Entry closes at this time, match starts after |
| Timing Flow | Players join before startsAt, match starts at startsAt | Players join until entryClosesAt, match starts after |
| Duration | Fixed (as per startsAt) | Specified in durationMinutes |
| Entry Fee | entryFee | entryFee |
| Max Players | maxParticipants | maxParticipants |
| Required Fields | startsAt, roomRevealMinutesBeforeStart | entryClosesAt, durationMinutes, tournamentMetric |

---

## Admin Panel UI Flow

### Screen 1: Games
- List all games
- Button: Create Game
- Shows: name, logoUrl, isActive

### Screen 2: Modes (after selecting game)
- List modes for selected game
- Button: Create Mode
- Shows: name, logoUrl, isActive
- No entry fee, prizes, or timing here

### Screen 3: Schedules (after selecting mode)
- List all schedules for selected mode
- Button: Create Schedule
- Shows:
  - For OMB: type, entryFee, maxParticipants, **startsAt** (match time), prizes
  - For Tournament: type, entryFee, maxParticipants, **entryClosesAt**, durationMinutes, tournamentMetric, prizes

---

## Form Validation Rules

### Mode Form
```
gameId: required, must exist
name: required, 1-128 chars
logoUrl: optional, must be valid URL if present
```

### Schedule Form - OMB
```
modeId: required, must exist
type: "omb" (hardcoded or selected)
status: "draft" | "published" | "closed"
entryFee: required, must be > 0
maxParticipants: required, must be > 0
teamSize: default 1, must be > 0
startsAt: required for OMB (this is match start time)
roomRevealMinutesBeforeStart: required for OMB, must be >= 0
prizes: array with position and amount
resultDeadlineMinutes: default 90, must be > 0
managerAlertAfterMinutes: default 5, must be >= 0
```

### Schedule Form - Tournament
```
modeId: required, must exist
type: "tournament" (hardcoded or selected)
status: "draft" | "published" | "closed"
entryFee: required, must be > 0
maxParticipants: required, must be > 0
teamSize: default 1, must be > 0
entryClosesAt: required for tournament (entry closes, match starts after)
durationMinutes: required for tournament, must be > 0
tournamentMetric: required for tournament (e.g., "score", "kills", etc.)
prizes: array with position and amount
resultDeadlineMinutes: default 90, must be > 0
managerAlertAfterMinutes: default 5, must be >= 0
```

---

## Admin Panel Form Templates

### OMB Schedule Form
```
Label: "OMB Match Time"
Field Name: "startsAt"
Type: DateTime Picker
Validation: Required, must be future date
Placeholder: "Select match start time (e.g., 10:00 AM)"

This is when the match will START. 
Players must join BEFORE this time.
```

### Tournament Schedule Form
```
Label: "Entry Closes At"
Field Name: "entryClosesAt"
Type: DateTime Picker
Validation: Required, must be future date
Placeholder: "Select entry closing time (e.g., 1:30 PM)"

This is when entry closes.
Match starts AFTER this time.
```

---

## Correct Admin Panel Layout

### Create Schedule Screen
```
[Select Mode] ← dropdown of modes
[Select Type] ← radio: OMB / Tournament

If OMB:
  [Entry Fee] [Max Players] [Team Size]
  [Match Start Time] ← startsAt (this is match time)
  [Room Reveal Minutes Before Start]
  [Add Prizes] (position 1, amount 500) (position 2, amount 250)
  [Result Deadline Minutes]
  [Manager Alert After Minutes]
  [Guide Video URL]
  [Notes]

If Tournament:
  [Entry Fee] [Max Players] [Team Size]
  [Entry Closes At] ← entryClosesAt
  [Duration Minutes] (match runs for this long after entry closes)
  [Tournament Metric] (score, kills, etc.)
  [Add Prizes] (position 1, amount 2000)
  [Result Deadline Minutes]
  [Manager Alert After Minutes]
  [Guide Video URL]
  [Notes]

[Create Schedule Button]
```

---

## JSON Payload Examples

### Example 1: Daily 10 AM OMB
```json
{
  "modeId": "solo-mode-id",
  "type": "omb",
  "status": "published",
  "entryFee": 50,
  "maxParticipants": 20,
  "teamSize": 1,
  "startsAt": "2026-09-02T10:00:00.000Z",
  "roomRevealMinutesBeforeStart": 15,
  "resultDeadlineMinutes": 90,
  "managerAlertAfterMinutes": 5,
  "prizes": [
    { "position": 1, "amount": 500 },
    { "position": 2, "amount": 250 },
    { "position": 3, "amount": 100 }
  ]
}
```

### Example 2: Daily 2 PM Tournament
```json
{
  "modeId": "solo-mode-id",
  "type": "tournament",
  "status": "published",
  "entryFee": 100,
  "maxParticipants": 16,
  "teamSize": 1,
  "entryClosesAt": "2026-09-02T13:30:00.000Z",
  "durationMinutes": 60,
  "tournamentMetric": "score",
  "resultDeadlineMinutes": 90,
  "managerAlertAfterMinutes": 5,
  "prizes": [
    { "position": 1, "amount": 2000 }
  ]
}
```

### Example 3: Daily 5 PM OMB
```json
{
  "modeId": "solo-mode-id",
  "type": "omb",
  "status": "published",
  "entryFee": 75,
  "maxParticipants": 24,
  "teamSize": 1,
  "startsAt": "2026-09-02T17:00:00.000Z",
  "roomRevealMinutesBeforeStart": 10,
  "resultDeadlineMinutes": 90,
  "managerAlertAfterMinutes": 5,
  "prizes": [
    { "position": 1, "amount": 1000 },
    { "position": 2, "amount": 500 },
    { "position": 3, "amount": 250 }
  ]
}
```

---

## Critical Points

✅ **Correct:**
- Schedule.startsAt = Match start time (OMB)
- Schedule.entryClosesAt = When entry closes (Tournament)
- Entry fee, max participants, prizes = Schedule level
- Mode just has name

❌ **Wrong:**
- Putting entry fee in Mode
- Putting startsAt in Mode
- Confusing startsAt as entry deadline for OMB
- Mode as time slot container

---

## Implementation Checklist

- [ ] Game form working (create/list)
- [ ] Mode form working (create/list, filtered by game)
- [ ] Schedule form working with Mode selector
- [ ] Schedule form shows OMB-specific fields when type=omb
- [ ] Schedule form shows Tournament-specific fields when type=tournament
- [ ] startsAt used as match start time display for OMB
- [ ] entryClosesAt used as entry close time display for Tournament
- [ ] Prizes array handling working
- [ ] Form validation matches backend schema exactly
- [ ] API payloads have exact field names (not snake_case)
- [ ] Timezone handling correct (use ISO 8601 format)

---

## Backend Routes Reference

| Action | Route | Method |
|--------|-------|--------|
| Create Game | `/api/admin/competition/games` | POST |
| Create Mode | `/api/admin/competition/modes` | POST |
| Create Schedule | `/api/admin/competition/schedules` | POST |
| Get Games | `/api/competitions/games` | GET |
| Get Modes | `/api/competitions/modes?gameId=...` | GET |
| Get Schedules | `/api/competitions/schedules?type=omb&modeId=...` | GET |
| Update Schedule | `/api/admin/competition/schedules/:id` | PATCH |

---

**Remember:** Schedule = complete match/tournament config including timing and rules.
Not just a time slot.
