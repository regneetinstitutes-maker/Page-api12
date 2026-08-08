# Security Architecture & Data Protection Plan

## Bank Account Number Storage

### Current state

Bank account numbers (and their withdrawal snapshots) are stored as **plain text** in
the PostgreSQL database. This is explicitly noted in the schema comment:

```
// Stored as plain text. Encryption at rest (application-level or TDE)
// is a future infrastructure concern.
```

The API layer never returns full account numbers — responses expose only the last 4
digits via `maskAccountNumber()`. However, a database breach would expose the raw numbers.

### Risk

For an RBI-regulated real-money gaming platform, storing full bank account numbers
unencrypted is a compliance and security risk. India's DPDP Act and RBI guidelines
require reasonable safeguards for financial account identifiers.

### Encryption Plan

Choose **one** of the following approaches before processing real INR withdrawals:

---

#### Option A — PostgreSQL Transparent Data Encryption (TDE) (Preferred for managed DB)

**What it is:** Encrypts the entire PostgreSQL data volume at rest. The database engine
decrypts data transparently on read.

**How to enable:**
- AWS RDS / Aurora: Enable "Encryption at rest" in the cluster settings. Data is
  encrypted using AES-256 with a KMS key.
- Neon / Supabase: Both support encryption at rest for all tiers.
- Self-hosted: Use PostgreSQL 16+ with `pg_tde` extension or run on an encrypted
  volume (LUKS, AWS EBS with encryption enabled).

**What changes:** Nothing in application code. Schema, queries, ORM layer — all
unchanged. Turn-on is infrastructure-only.

**Limitation:** Does not protect against a SQL-injection attack that runs
`SELECT bank_account_number FROM user_bank_accounts` — the database engine
decrypts for all authenticated connections.

---

#### Option B — Application-Level Column Encryption (Defence-in-depth)

**What it is:** Encrypts the `bank_account_number` column value before INSERT and
decrypts after SELECT in the application layer.

**How to add without schema migration:**

The schema comment already notes: "the column name and type will not need to change
when that is added." The column is `text` — it can hold base64-encoded ciphertext.

1. Create `lib/crypto/bank-account-crypto.ts`:

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY = Buffer.from(process.env.BANK_ACCOUNT_ENCRYPTION_KEY!, "hex"); // 32 bytes

export function encryptAccountNumber(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(12):tag(16):ciphertext — all base64-encoded
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptAccountNumber(ciphertext: string): string {
  const [ivB64, tagB64, encB64] = ciphertext.split(":");
  const iv = Buffer.from(ivB64!, "base64");
  const tag = Buffer.from(tagB64!, "base64");
  const enc = Buffer.from(encB64!, "base64");
  const decipher = createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
```

2. Wrap calls in `lib/bank-account.ts`:
   - `addBankAccount`: call `encryptAccountNumber(input.bankAccountNumber)` before INSERT
   - `getUserBankAccounts` / `getBankAccount`: call `decryptAccountNumber(row.bankAccountNumber)` after SELECT

3. The withdrawal snapshot (`snapshotBankAccountNumber`) in `lib/withdrawal.ts` should
   store the **plaintext** (after decryption at snapshot time) since the submission job
   needs to send it to PayU. Alternatively, encrypt the snapshot too and decrypt in the
   submission job.

4. Required environment variable: `BANK_ACCOUNT_ENCRYPTION_KEY` — a 256-bit (64 hex chars)
   random key stored in Replit Secrets. Rotate by re-encrypting all rows.

---

#### Recommendation

**Implement Option A (TDE) immediately** — it requires zero code changes and provides
strong at-rest protection. **Plan Option B** for defence-in-depth if the threat model
includes compromised DB connections.

---

## Other Sensitive Data Notes

| Data | Storage | Protection |
|---|---|---|
| Bank account numbers | PostgreSQL (plain text) | **Plan encryption above** |
| Withdrawal snapshots | PostgreSQL (plain text) | **Plan encryption above** |
| Session tokens | PostgreSQL (plain text) | Short-lived, rotated on use |
| PayU key/salt | Environment variables | Never logged |
| Passwords | bcrypt hash | Never stored or logged in plain |

## Logging Contract

The logger (`lib/logger.ts`) uses pino's `redact` option to strip:
- `req.headers.authorization`
- `req.headers.cookie`
- `res.headers['set-cookie']`
- `req.body.bankAccountNumber`
- `req.body.snapshotBankAccountNumber`
- `req.body.password`

Full request bodies are never logged in structured log events. Unhandled error
middleware must not log `req.body` directly.
