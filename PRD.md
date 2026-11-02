# PRD.md — Dommus Negotii Portal · Phase 1: Credit Super Store Cooperative Loan Management System

| Item | Value |
|---|---|
| Client | MOAUM Consultancy Services |
| Product | Dommus Negotii — Modular Group Services Portal |
| This document covers | **Phase 1 only**: Portal Shell, Shared Ledger, Evidence Repository, Credit Super Store module |
| Version | 1.5 (database moved to Neon Free with Cloudflare R2 for evidence files; borrowing and guarantee limits; policy defaults confirmed) |
| Date | 2 November 2026 |
| Prepared by | Developer (with AI mentor) |
| Currency / Timezone | NGN (kobo precision) / Africa/Lagos (WAT, UTC+1) |
| Sign-off date | Not yet set |

**Naming used throughout this document**
- **Phase** means a product phase. Phase 1 is this document. Later phases add Modules 2–7.
- **Milestone** means a delivery step inside Phase 1 (1a–1d).
- **GMD** means the Group Managing Director, who is also the General Manager. One person, one role.
- **Installment k** is due on **anniversary k** and closes **cycle k** (Section 2). Installments are never named by calendar month.
- **Member** means a cooperative member (the customer). "Customer" is not used elsewhere.

---

## 0. Change history

"Client decision" items were decided by MOAUM. "Derived" items were added to close a gap or as recommended good practice. Confirm the derived items at sign-off.

### v1.5 (from v1.4)

| # | Area | Change | Basis |
|---|---|---|---|
| 1 | Database (§5) | PostgreSQL moves from Supabase to **Neon, Free plan** to start. Upgrade triggers defined. | Client decision |
| 2 | Evidence (§5) | Supabase Storage is replaced by a **Cloudflare R2** private bucket (free tier) with 5-minute presigned URLs and a 7-year bucket lock. | Derived (Neon has no file storage) |
| 3 | Operations (§5) | Free-plan guardrails: compute capped at 0.25 CU with scale-to-zero, health check that doesn't wake the database, batched scheduled jobs, nightly encrypted database dump to R2. Recovery point ≤ 24 hours while on Free. | Derived |
| 4 | Loans (F7, F2) | Borrowing limits enforced as financial settings: at most **2** open loans per member and **2** open guarantees per guarantor. | Client decision |
| 5 | Policy (§10) | Personal-data retention for declined applicants and reminder timing: defaults confirmed. | Client decision |
| 6 | Roles (§3) | Secretary role confirmed. | Client decision |
| 7 | Tests (§9) | AT-u added. | Derived |

### v1.4 (from v1.3)

| # | Area | Change | Basis |
|---|---|---|---|
| 1 | Members (F5) | Admin, GMD and Secretary can send prospective members personal registration invitation links (single or bulk, with resend and revoke). | Client decision |
| 2 | Roles (§3) | New **Secretary** role: invitations and announcements only, with no financial or KYC access. GMD and Admin gain non-financial write actions (invitations; announcements for the GMD). | Client decision (Secretary, invitations); announcements derived |
| 3 | Members (F5) | Registration is by invitation by default. The open public link becomes a setting, off by default. Activation messages for bulk-imported members use the same invitation mechanism. | Derived |
| 4 | Roles (§3) | Secretary + Loan Officer blocked: whoever invites a member never activates them. | Derived |
| 5 | Auth (F1) | Account lockout, new-device sign-in alerts, session list and revoke, password policy with breached-password check. | Derived |
| 6 | Members (F5) | Member profile change requests (approved by the Loan Officer) and an NDPA self-service copy of personal data. | Derived |
| 7 | Settings (F2) | Financial settings (interest rate, go-live date, reconciliation date window) need Management approval and can't be backdated. | Derived |
| 8 | Loans (F6, F7) | Payoff quote for members and staff. Exposure panel for Loan Officer and Management (member's loans, arrears, guarantees given). | Derived |
| 9 | Reconciliation (F11) | Monthly close: closed months stay fixed in reports; later backdated events show as prior-period adjustments. | Derived |
| 10 | Reports (F13) | Public receipt verification page for the QR code; full ledger export for auditors; invitation report. | Derived |
| 11 | Notifications (F15) | Arrears and pre-due reminders, announcements, invitation events, low SMS balance alert. | Derived |
| 12 | Operations (§5) | Backups and restore targets, monitoring, scheduled jobs, separate staging data, mobile-first and accessibility targets. | Derived |
| 13 | Tests (§9) | AT-q to AT-t added. | Derived |

### v1.3 (from v1.2)

| # | Area | Change | Basis |
|---|---|---|---|
| 1 | Interest (F6) | Every loan pays at least cycle 1 interest, even if repaid on the disbursement day. Early payoff = outstanding principal + interest arrears + current cycle interest. | Client decision |
| 2 | Interest (F6) | Grace window covers catch-up of arrears only. A prepayment lowers interest from the next cycle, never the cycle it is paid in. | Derived (needed for #1 to hold) |
| 3 | Engine (F6) | Loan state is recomputed from all payments on every posting, reversal, correction or reclassification. Differences are posted as reversing and replacement ledger events. No "cycle close" job. | Client decision |
| 4 | Dates (F6) | Due dates anchor to the disbursement day of the month, clamped to month end in shorter months. Payment timing is by `payment_date`, not upload date, so a late-uploaded schedule still covers the month it relates to. | Client decision |
| 5 | Dates (F6) | Cycle boundaries defined: a payment dated on an anniversary belongs to the cycle ending that day. | Derived |
| 6 | Remittance (F9) | Rows on a CLOSED loan, or for a member with no ACTIVE loan, post to that member's Overpayment Credit instead of rejecting the batch. | Client decision |
| 7 | Remittance (F9) | `period_covered` is for reference only. Allocation is always oldest-first, and any excess reduces principal. | Client decision |
| 8 | Reconciliation (F11) | "Cash-in-transit" removed. Money is either verified in the bank or **Recorded, not yet paid**. Joint reconciliation equations written out. | Client decision |
| 9 | Reconciliation (F10, F11) | Bank opening balance per account at go-live; bank charges, bank interest and internal transfers recorded from statement lines; statement continuity check. | Derived (needed for #8 to balance) |
| 10 | Legacy (F8) | Interest-rate column added. One OPENING_BALANCE event per loan; no historic events. New `CSS-YYYY-NNNNN` numbers issued to all legacy loans; old number kept as `legacy_account_no`. | Client decision |
| 11 | Lodgements (F9, F10) | Lodgements are declared and recorded on the remittance sheet (a Lodgements sheet in the same file). The sheet is the lodgement's evidence. | Client decision |
| 12 | Auth (F1) | Two-factor login mandatory for **all** staff roles, including Loan Officer. | Client decision |
| 13 | Auth (F1, F2) | SMS (Termii) and email (Resend) providers move to Milestone 1a for one-time codes, phone verification and password reset. Notification triggers stay in 1d. | Client decision |
| 14 | Loans (F7) | New state `DISBURSEMENT_PENDING` between APPROVED and ACTIVE. CLOSED → ACTIVE reopen by the system only. | Client decision |
| 15 | Ledger (F4) | New event `DEPOSIT_CREDITED` creates an Overpayment Credit. New event `OPENING_BALANCE`. New sources `BANK_STATEMENT`, `REFUND_VOUCHER`. Reserved source `DIRECT_PAYMENT` renamed `LIVE_PAYMENT`. | Client decision (#15 first item); rest derived |
| 16 | Evidence (F3) | A file used as primary evidence for more than one submission is flagged and opens a DUPLICATE_EVIDENCE exception. | Client decision |
| 17 | Controls (F9) | The Treasurer cannot move money between members: payroll rows must match, per member, a **Source Advice** uploaded independently by the Finance Manager; direct payment rows must reference a bank credit the Finance Manager has tagged to that member. | Client decision (control); mechanism derived |
| 18 | Roles (§3) | Blocked combinations extended. Staff cannot act on their own member record or loans. | Derived |
| 19 | Members (F5, F7) | Bulk-imported members get an SMS invitation. Loan Officer can capture an assisted application from a signed paper form. Exit also requires a zero Overpayment Credit. | Derived |
| 20 | Wording | One term per concept across the document (see Naming above and Glossary). | Client decision |

---

## 1. Project Overview

### 1.1 What we are building
Dommus Negotii is MOAUM's group portal. It will eventually host seven independent service modules (Credit, Catering, Training Institute, Construction, Cleaning & Fumigation, Consultancy, Printing). **Phase 1 delivers the portal foundation plus the Credit Super Store module**, and is signed off on its own before any other module starts.

The Credit Super Store module manages cooperative member loans for about **150 members**. It is a **book of record**. It does not move money. Every financial entry mirrors verified physical or banking activity and must carry evidence.

### 1.2 Problems it solves
- Loan balances are kept in spreadsheets with no single source of truth.
- Repayments arrive through monthly remittance schedules from two sources, and nobody systematically checks them against the bank.
- There is no audit trail, no separation of duties, and no consolidated view for management.

### 1.3 Binding principles
1. **No evidence, no posting.** Every financial record has at least one attached evidence file (stored with uploader, timestamp and SHA-256 checksum).
2. **Two-track trust.**
   - **Track A:** the monthly remittance schedule is the *only* source of truth for loan repayments. Each row is bound to an independent record: payroll rows to the remittance source's Source Advice, direct payment rows to a member-tagged bank credit.
   - **Track B:** bank money is verified against the bank statement *before* the Cashier can record it.
3. **Append-only.** Corrections are reversing entries with a reason and evidence. Nothing is ever edited or deleted.
4. **Modular.** Modules integrate only through the Portal Shell and the Shared Ledger. Modules never call each other directly. Each module has its own database schema.
5. **Future-proof.** Live payments can be added later as a new ledger `source` (`LIVE_PAYMENT`, reserved) without changing the schema.

### 1.4 Out of scope for Phase 1
- Live payments, payment gateways, card processing, bank APIs.
- Savings products of any kind. Members do not hold savings with the Credit module.
- Penalties, late fees, overdue classification and portfolio-at-risk ageing buckets.
- Applying an Overpayment Credit to another loan. Overpayment Credits are only ever refunded.
- Recovering unpaid loans from guarantors (the guarantor is recorded; recovery is a manual, offline process).
- Offline capture.
- Modules 2–7 (only their integration contracts are delivered).
- Branding (logo, colours, domain). Neutral placeholder theme until decided.

### 1.5 Delivery milestones (each signed off separately)
| Milestone | Contents |
|---|---|
| **1a — Foundation** | Portal Shell (auth with account protection, roles incl. Secretary, two-factor login, module registry, settings with approval of financial settings, audit), notifications service with SMS (Termii) and email (Resend) providers for one-time codes, verification and password reset, Shared Ledger, Evidence Repository (incl. duplicate-evidence flag), Member management (invitations, registration, bulk import, profile change requests, NDPA data copy), scheduled jobs, monitoring and backups |
| **1b — Loans** | Loan engine (calculator, schedule, allocation, recompute), loan workflow (application → disbursement → closure), legacy loan import with opening balances, Source Advice upload, remittance schedule ingestion (Track A) with payroll rows and declared lodgement lines, Overpayment Credits, corrections, member statements, payoff quotes, exposure panel |
| **1c — Bank & Reconciliation** | Bank accounts and opening balances, bank statement import, lodgement verification (Track B), direct payment credit tagging and direct payment rows, bank line entries, Unapplied Bank Credits and Unverified Lodgements, Track A / Track B / joint reconciliation, exceptions, monthly close, refunds (F12) |
| **1d — Reporting & Handover** | GMD dashboard, reports, PDF receipts & statements, receipt verification page, ledger export, notification triggers, reminders and announcements (F15), API docs, module registration guide, integration contracts |

Direct payment rows depend on bank statement import, so they are enabled in 1c. Milestone 1b acceptance uses payroll rows only.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Remittance source** | An authorized origin of payroll remittances (two in Phase 1, configured by Admin) |
| **Remittance schedule** | The monthly Excel file submitted by the Treasurer for one remittance source and one `month_covered`. It has a Rows sheet (payroll rows and direct payment rows) and a Lodgements sheet |
| **Payroll row** | A schedule row for a deduction made by the remittance source. Bound to the Source Advice |
| **Direct payment row** | A schedule row for a member's own payment into a MOAUM bank account. Bound to a bank credit the Finance Manager has tagged to that member |
| **Source Advice** | The remittance source's own per-member list of amounts deducted for a month, obtained by the Finance Manager directly from the source and uploaded by the Finance Manager. Payroll rows must match it per member |
| **Lodgement** | Money paid into a MOAUM bank account, declared as a line on the Lodgements sheet of a remittance schedule (or, for a direct payment, created from a tagged bank credit) |
| **BANK_VERIFIED** | Status of a lodgement after the Finance Manager has matched it to a bank statement credit line |
| **Unverified Lodgement** | A lodgement with no matched bank statement credit yet |
| **Unapplied Bank Credit** | A bank statement credit with no matched lodgement and no member tag yet |
| **Recorded, not yet paid** | The part of a posted schedule's total not yet backed by BANK_VERIFIED lodgements |
| **Overpayment Credit** | Money received for a member that is not owed on any ACTIVE loan. Held as a liability until refunded |
| **Exception** | A reconciliation or control gap (shortfall, excess, mismatch, duplicate, unexplained difference, duplicate evidence) that must be closed by the GMD with a documented reason and evidence |
| **Disbursement date (d0)** | The value date of the disbursement transfer, taken from the verified disbursement voucher |
| **Anniversary k (Aₖ)** | The date k months after d0, on d0's day of the month, or the last day of the month when that month is shorter |
| **Cycle k** | Cycle 1 is d0 to A₁ inclusive. Cycle k (k ≥ 2) runs from the day after Aₖ₋₁ to Aₖ inclusive. Interest is charged once per cycle |
| **Installment k** | The amount due on Aₖ: scheduled principal for k plus cycle k interest |
| **Go-live date** | The single cutover date (a setting) at which legacy loan and bank opening balances are struck |
| **Opening balance** | A loan's or bank account's position at the go-live date, posted as one OPENING_BALANCE ledger event |
| **Recompute** | Rebuilding a loan's full state from its terms, opening balance and all payments, then posting the difference to the ledger (F6) |
| **Invitation** | A personal, single-use, expiring link sent by SMS (and email) that lets one named person register as a member (`REGISTRATION`) or lets a bulk-imported member set up their login (`ACTIVATION`) |
| **Financial setting** | A setting that changes money outcomes: interest rate, go-live date, reconciliation date window, borrowing and guarantee limits. Changes need Management approval |
| **Payoff quote** | The amount that closes a loan if paid on or before a stated date (F6) |
| **Monthly close** | The Finance Manager's closing of a reconciled month; its reports are frozen as snapshots (F11) |
| **Prior-period adjustment** | A ledger event posted after a month was closed but dated inside it; reported in the next open month |
| **Kobo** | 1/100 of a naira. All money is stored as integer kobo |
| **Basis points (bps)** | 1/100 of a percent. The 7.5% monthly rate is stored as 750 bps |
| **GMD** | Group Managing Director, who is also the General Manager. Read-only consolidated dashboards, plus the sole authority to close exceptions |

---

## 3. Roles & Permissions

Separation of duties is enforced **at the API layer** (server actions / route handlers), not only in the UI. On any dual-control record, the verifier must be a different user from the creator.

| Role | Can | Cannot |
|---|---|---|
| **Member** | Register through an invitation link (or the open link when enabled); apply for loans; request profile changes; download a copy of own personal data; get payoff quotes; request refunds of Overpayment Credits; view own loans, schedules, statements, receipts and evidence of own payments | See other members; any staff action |
| **Treasurer (Schedule Officer)** | Upload remittance schedules (payroll rows, direct payment rows, lodgement lines) for the configured sources; run dry-run; commit valid schedules; prepare corrections and reclassifications on own schedules | Upload Source Advice; tag bank credits; verify anything; record Cashier entries; approve loans |
| **Finance Manager / Bank Reconciliation Officer** | Upload Source Advice; upload bank statements; tag direct payment credits to members; mark lodgements BANK_VERIFIED; verify disbursement vouchers, refund vouchers, bank line entries, corrections and reclassifications; run reconciliation; move exceptions to UNDER_REVIEW; commit legacy loan and bank opening balance imports after review | Originate receipts; post loan repayments; approve loans; close exceptions |
| **Cashier** | Record and apply BANK_VERIFIED lodgements; prepare disbursement and refund vouchers; record bank line entries (charges, bank interest, internal transfers) from statement lines | Create a lodgement or receipt from nothing; verify anything; approve loans |
| **Loan Officer** | Activate or decline pending members; approve member profile change requests; capture assisted applications from signed paper forms; verify KYC and guarantor; recommend or decline applications | Approve loans; any financial entry |
| **Management / Approver** | Approve, reduce or reject loan amounts; adjust tenure; approve refunds; approve financial setting changes | Enter, verify or post financial transactions |
| **Auditor** | Read-only access to everything: modules, ledger, evidence, reconciliation, audit trail | Any write action |
| **Admin** | Manage users and roles, settings (financial settings need Management approval, F2), remittance sources, bank accounts, module registry; upload member, legacy loan and bank opening balance import files; send, resend and revoke member invitations | Enter, verify or approve financial transactions; commit financial imports; activate members |
| **GMD** | Read-only consolidated dashboards; **review and close exceptions** with a documented reason and evidence (the GMD's only financial write action); send, resend and revoke member invitations; send announcements | Enter, verify, approve or post financial transactions; activate members |
| **Secretary** | Send, resend and revoke member invitations (single and bulk); see invitation status and a member directory (name, phone, status, remittance source); send announcements | See KYC documents, loans or any financial data; activate members; any financial action |

**Staffing:** MOAUM has 5 operational staff, one per financial role: Treasurer, Finance Manager, Cashier, Loan Officer and Management. The GMD and the Secretary are separate people, and neither holds a financial role. Admin is held by the developer/IT support. Auditor logins are issued to internal or external auditors as needed. One person per role is maintained (accepted risk, Section 10).

**Multiple roles:** a user may hold more than one role except for these **blocked combinations**, which are rejected when assigned:
- Cashier + Finance Manager
- Treasurer + Finance Manager
- Management + Cashier
- Management + Loan Officer
- Secretary + Loan Officer (whoever invites a member never activates them)
- GMD + any other role
- Admin + any other role

**No self-dealing:** a staff user whose login is linked to a Member record cannot perform any workflow action on that member's own records (verify, recommend, approve, prepare or verify vouchers, tag bank credits, verify lodgements, approve refunds, close exceptions). The Treasurer's own loans may appear on a schedule they upload, because payroll rows are bound to the Source Advice and direct payment rows to an FM-tagged credit.

---

## 4. Functional Requirements (User Stories)

Each feature has user stories, rules and a **Definition of Done (DoD)**. DoD items marked **[AT-x]** map to the acceptance tests in Section 9.

### F1 — Portal Shell: Authentication & Identity (1a)

**Stories**
- As a staff user, I log in with email + password and a TOTP second factor, so financial roles are protected.
- As a member, I log in with my phone number (or email, if on file) + password.
- As an Admin, I create staff users, assign roles per module, and deactivate users.
- As any user, my session expires after inactivity.

**Rules**
- Portal users (logins) are separate from module entities. A `Member` record may optionally link to a `PortalUser`.
- Two-factor login (TOTP) is mandatory for **every staff role**: Treasurer, Finance Manager, Cashier, Loan Officer, Management, GMD, Secretary, Admin and Auditor.
- Members: the phone number is verified by an SMS one-time code at registration (or at first sign-in for bulk-imported members). Password reset is by SMS one-time code, or by email link when an email is on file. Staff password reset is by email link.
- A PENDING member can sign in only to see their registration status.
- Roles are assigned per module (`moduleCode + role`).
- Staff session idle timeout: 30 minutes. Member session idle timeout: 60 minutes.
- **Account protection:** after 5 failed sign-in attempts the account is locked for 15 minutes and the user is notified. Passwords are at least 10 characters and are checked against a list of known-breached passwords. A sign-in from a new device sends an alert to the user. Each user can see and revoke their active sessions. Deactivating a user revokes all their sessions immediately.

**DoD**
- [ ] Login, logout, password reset (email for staff; SMS or email for members), phone verification, and TOTP enrolment/verification work.
- [ ] A staff user without two-factor enrolled cannot reach any staff page, for every staff role.
- [ ] Every server action checks role and module permission. A unit test proves a Cashier call to a Finance-only action returns 403.
- [ ] Every blocked role combination is rejected when assigned.
- [ ] A self-dealing action (e.g. a Loan Officer verifying their own application) returns 403.
- [ ] Lockout, new-device alerts and session revoke work; a deactivated user's open session is rejected on the next request.
- [ ] Login success and failure are written to the audit trail with IP address.

### F2 — Portal Shell: Module Registry, Settings, Audit, Notifications (1a)

**Stories**
- As an Admin, I see registered modules with their code, status (live/degraded/offline) and emitted event types.
- As an Admin, I change settings. Financial settings take effect only after Management approves them.
- As an Auditor, I search the immutable audit trail by user, date, entity and action.
- As the system, I send SMS and email through a single notifications service.

**Rules**
- Audit records include user, timestamp, IP, action, entity type and id, before/after snapshot, and evidence reference. The table is insert-only: the database role used by the app has no `UPDATE` or `DELETE` permission on it.
- Notifications are queued and logged with delivery status. Providers are Termii (SMS) and Resend (email), both live from Milestone 1a. Business notification triggers are added in 1d (F15).
- **Financial settings** (interest rate, go-live date, reconciliation date window of ±3 days, maximum open loans per member, maximum open guarantees per guarantor): the Admin proposes a change with an effective date and a reason; Management approves or rejects it. The effective date can't be earlier than the approval date. A new rate applies only to loans approved on or after its effective date. Other settings take effect immediately. Every settings change is audited.

**DoD**
- [ ] The Credit module is registered as `CREDIT` with status and event list.
- [ ] A DB-level test proves `UPDATE`/`DELETE` on `audit_log` fails.
- [ ] Notification send attempts (including one-time codes) are logged with provider response.
- [ ] Audit search with filters is paginated and exportable to Excel.
- [ ] **[AT-r]** A financial setting change has no effect until Management approves it, and a backdated effective date is rejected.

### F3 — Evidence Repository (1a)

**Stories**
- As any user creating a financial record, I attach one or more evidence files (PDF, JPG, PNG, XLSX, CSV).
- As an Auditor, I open any evidence file and see who uploaded it, when, and its checksum.

**Rules**
- Files are stored in a private bucket and accessed via short-lived presigned URLs (5 minutes).
- A SHA-256 checksum is computed server-side at upload and re-verified on download.
- Maximum file size: 10 MB.
- Retention: **7 years**. Evidence is never hard-deleted.
- A file whose checksum already exists is linked to the existing file rather than stored twice.
- **Primary and supporting evidence.** Each evidence link is either *primary* (the evidence a record is created from) or *supporting* (added later to an exception, correction or reconciliation note). A **submission** is one of: a remittance schedule (with its rows and lodgement lines), a Source Advice, a bank statement, a disbursement voucher, a refund voucher, a bank line entry, an import batch, a member registration, a loan application, a direct payment credit tag.
- **Duplicate evidence flag.** If a file (by checksum) becomes primary evidence for a second, different submission, the upload is linked, the uploader must enter a reason, and the system opens a `DUPLICATE_EVIDENCE` exception (F11) naming both submissions. Reuse within one submission, and supporting evidence that references an existing file, are not flagged.

**DoD**
- [ ] Evidence metadata is stored: id, filename, MIME type, size, sha256, uploader, uploaded_at.
- [ ] Any attempt to post a financial record without evidence is rejected at the API.
- [ ] A tampered file (checksum mismatch) is flagged on retrieval.
- [ ] There is no delete endpoint for evidence.
- [ ] **[AT-n]** The same deposit slip uploaded as primary evidence for two different submissions opens a DUPLICATE_EVIDENCE exception and requires a reason.

### F4 — Shared Ledger (1a)

**Stories**
- As the system, I write a typed, append-only ledger event whenever an accepted schedule or verified record posts, or a recompute changes an allocation.
- As the GMD or Auditor, I drill down from any dashboard figure to ledger events and their evidence.

**Rules**
- Fields: `event_id, occurred_at, posted_at, module_code, event_type, source, evidence_refs[], portal_user_id, module_entity_type, module_entity_id, bank_account_id (nullable), currency, cash_amount, revenue_amount, deposit_delta, principal_amount, interest_amount, retention_amount, status, uniqueness_key, reverses_event_id, schema_version, metadata`.
- `occurred_at` is the business date (payment date, transfer value date, statement date). `posted_at` is the system time.
- Money fields are integer kobo (`BigInt`). Original events carry positive amounts; the event type gives the direction. A reversal event carries the exact negatives of the original and sets `reverses_event_id`.
- `source` enum: `REMITTANCE_SCHEDULE | BANK_SLIP | BANK_STATEMENT | DISBURSEMENT_VOUCHER | REFUND_VOUCHER | LEGACY_IMPORT | RECEIPT_ENTRY | EXCEL_BATCH | LIVE_PAYMENT`. `RECEIPT_ENTRY`, `EXCEL_BATCH` and `LIVE_PAYMENT` are reserved and unused in Phase 1.
- `schema_version` is 2 from this version (v1.2's schema was version 1 and was never deployed).
- **Idempotent:** `uniqueness_key` is unique. Re-posting the same event is a no-op that returns the existing event. Keys are built from the business key plus a recompute sequence number, e.g. `CREDIT:ROW:{schedule_id}:{row_no}:INTEREST:{seq}`.
- **Append-only:** no `UPDATE`/`DELETE` permission for the app DB role. Corrections are new events referencing `reverses_event_id`.
- `PRINCIPAL_RECOVERY` is never counted as revenue. `INTEREST_INCOME` is revenue.

**Phase 1 event types**

| Event type | Posted when | Money fields set | Source |
|---|---|---|---|
| `OPENING_BALANCE` | Legacy loan import committed (per loan); bank opening balance committed (per account) | Loan: `principal_amount` (outstanding principal; arrears in `metadata`). Bank: `cash_amount` and `bank_account_id` | `LEGACY_IMPORT` |
| `CASH_OUT` | Disbursement voucher verified; refund voucher verified; bank line entry (charge or outgoing internal transfer) verified | `cash_amount`, `bank_account_id`; disbursement also sets `principal_amount` | `DISBURSEMENT_VOUCHER`, `REFUND_VOUCHER`, `BANK_STATEMENT` |
| `CASH_IN` | Cashier records a BANK_VERIFIED lodgement; bank line entry (bank interest or incoming internal transfer) verified | `cash_amount`, `bank_account_id` | `BANK_SLIP`, `BANK_STATEMENT` |
| `PRINCIPAL_RECOVERY` | Schedule row allocation, or recompute replacement | `principal_amount` | `REMITTANCE_SCHEDULE` |
| `INTEREST_INCOME` | Schedule row allocation, or recompute replacement | `interest_amount`, `revenue_amount` (equal) | `REMITTANCE_SCHEDULE` |
| `DEPOSIT_CREDITED` | An Overpayment Credit is created (excess after payoff, row on a CLOSED loan, row with no ACTIVE loan, reclassified prepayment) | `deposit_delta` | `REMITTANCE_SCHEDULE` |
| `DEPOSIT_REFUNDED` | Refund voucher verified (paired with `CASH_OUT`) | `deposit_delta` | `REFUND_VOUCHER` |
| `SCHEDULE_ACCEPTED` | Schedule passes validation at commit | none (control total in `metadata.amount`) | `REMITTANCE_SCHEDULE` |
| `SCHEDULE_POSTED` | All row allocations of the schedule are written | none (`metadata.amount`) | `REMITTANCE_SCHEDULE` |
| `LODGEMENT_BANK_VERIFIED` | Finance Manager marks a lodgement BANK_VERIFIED | none (`metadata.amount`) | `BANK_SLIP` |
| `LODGEMENT_APPLIED` | Cashier records and applies a BANK_VERIFIED lodgement (paired with `CASH_IN`) | none (`metadata.amount`) | `BANK_SLIP` |
| `LODGEMENT_UNAPPLIED` | A Track B run classifies a statement credit as Unapplied. Reversed when the credit is later matched or tagged | none (`metadata.amount`) | `BANK_STATEMENT` |

`BANK_DEPOSIT` is reserved and unused in Phase 1 (verified money in is `CASH_IN`). Status events carry no money in the money fields, so they can never double-count.

**DoD**
- [ ] A DB-level test proves ledger rows cannot be updated or deleted.
- [ ] Posting the same `uniqueness_key` twice yields exactly one event.
- [ ] Every event has at least one `evidence_ref` (enforced by a check constraint `cardinality(evidence_refs) >= 1`).
- [ ] A reversal event exactly negates the original amounts and links to it.

### F5 — Member Onboarding (1a)

**Stories**
- As an Admin, GMD or Secretary, I send a prospective member a personal registration invitation link by SMS (and email if known), one at a time or in bulk from a list. I can resend or revoke it and see its status.
- As an invited person, I open my link, enter my details, MOAUM ID card number and ID card scan, verify my phone by SMS code and set a password. My status becomes `PENDING`.
- As a Loan Officer, I review and activate or decline pending members.
- As an Admin, I bulk-load existing members from Excel/CSV using a template, with a dry-run preview. Imported members receive an activation invitation to verify their phone and set a password.
- As a member, I request changes to my contact or KYC details, and I download a copy of the personal data held about me.

**Rules: invitations**
- Who can send, resend and revoke: Admin, GMD and Secretary. Every other role gets 403.
- An invitation holds: invitee full name, phone (required), email (optional), remittance source (optional), sender, type (`REGISTRATION` for new members, `ACTIVATION` for bulk-imported members), status and expiry.
- The link carries a random single-use token of at least 32 bytes. Only its SHA-256 hash is stored. The link expires after 7 days (setting). Resending issues a new token and invalidates the old one. Revoking invalidates it at once.
- Statuses: `SENT → DELIVERED / FAILED` (from the SMS provider) → `OPENED → REGISTERED`, or `EXPIRED` / `REVOKED`.
- The phone verified at registration must be the invited phone. To change it, the sender revokes the invitation and sends a new one.
- An invitation is refused if the phone or MOAUM ID already belongs to a member, a pending applicant or another open invitation.
- Bulk invitations: upload a list (name, phone, optional email and remittance source) with a dry-run preview and per-row error log; valid rows are sent.
- Limits: at most 50 invitations per sender per day and 3 per phone number per 7 days (settings), to control SMS cost and abuse.
- The member record stores `invited_by`. An invitation never activates anyone; the Loan Officer still activates or declines.
- **Open registration:** the public application link without an invitation is controlled by the setting `open_registration_enabled`, **off by default**. When on, it behaves like a REGISTRATION invitation without a sender, and is rate limited.
- ACTIVATION invitations are sent automatically when a member import is committed. Admin, GMD and Secretary can resend them.

**Rules: member data**
- KYC fields: full name, phone, email (optional), address, MOAUM ID card number (unique), ID card scan, next of kin (name and phone), remittance source (one of the configured sources, or "None — pays directly").
- No BVN or NIN is collected.
- **Profile changes:** a member requests changes in the portal. A phone change also needs an SMS code sent to the new phone. Every change is approved by the Loan Officer; changes to name, MOAUM ID number or ID scan also need evidence. The audit trail keeps the before and after values.
- **Copy of personal data (NDPA):** a member can download their personal data (profile, KYC fields, consents, loans, statements) as PDF and JSON. Each download is logged.
- A consent notice under the Nigeria Data Protection Act (NDPA 2023) is shown, and consent is recorded at registration (and at first sign-in for imported members).
- Member status values: `PENDING → ACTIVE → EXITED`, plus `DECLINED` from PENDING. Bulk-imported members are created `ACTIVE`.
- A member whose ID card scan is missing (possible for bulk imports) is flagged **KYC incomplete** and cannot apply for a loan until the Loan Officer attaches it.
- A member may exit only when all their loans are `CLOSED` and their Overpayment Credit balance is zero.
- An `EXITED` member returns to `ACTIVE` automatically if a recompute reopens one of their loans (F6).

**DoD**
- [ ] **[AT-q]** Only Admin, GMD and Secretary can send invitations (others get 403). An invitation link registers exactly one `PENDING` member with a verified phone and `invited_by` set, and Loan Officers are notified. A used, expired or revoked link is refused.
- [ ] With `open_registration_enabled` off, registration without an invitation is refused.
- [ ] Bulk invitations have a dry-run, a per-row error log and the sending limits.
- [ ] A duplicate MOAUM ID number is rejected.
- [ ] The bulk import provides a downloadable template, dry-run preview, a per-row error log, all-or-nothing commit, and ACTIVATION invitations.
- [ ] Profile change requests and the personal-data download work and are audited.
- [ ] Exit is blocked while any loan is not `CLOSED` or the Overpayment Credit balance is above zero.
- [ ] A KYC-incomplete member cannot submit a loan application.

### F6 — Loan Engine: Calculator, Schedule, Interest, Allocation, Recompute (1b)

**Stories**
- As a member or Loan Officer, I see an **indicative** repayment schedule for any amount and a tenure of 1–12 months.
- As the system, I generate the **binding** schedule from the approved amount, approved tenure and approved rate only.
- As the system, I keep every loan's state correct whatever order its payments arrive in.

**Rules: dates**
- d0 is the disbursement date: the value date of the transfer on the verified disbursement voucher (F7). For legacy loans, the original disbursement date.
- Anniversary k falls on d0's day of the month, k months after d0. When a month has fewer days, it falls on that month's last day; the next anniversary returns to d0's day. Example: d0 = 31 Jan → 28/29 Feb → 31 Mar → 30 Apr → 31 May.
- Cycle 1 runs from d0 to A₁ inclusive. Cycle k (k ≥ 2) runs from the day after Aₖ₋₁ to Aₖ inclusive. A payment dated on an anniversary belongs to the cycle that ends that day.
- **Payment timing is by `payment_date`, never by upload or posting date.** A schedule uploaded after its month has ended still counts on the dates of its rows, so it covers the month it relates to.

**Rules: planned schedule (at approval)**
- Rate: **7.5% per month on the reducing balance**, stored as **750 bps** in settings with an effective date. Each loan stores the rate it was approved at.
- Principal per installment is `round_half_up(P / n)` to the kobo. The **final installment absorbs the rounding remainder**, so total principal equals P exactly.
- Interest for installment k is `round_half_up(rate × opening_principal_k)` to the kobo, computed in integers as `(principal_kobo × bps + 5000) div 10000`.
- Installment k = principal_k + interest_k, due on Aₖ.
- There is no minimum or maximum loan amount (must be > ₦0). Tenure is an integer from 1 to 12.

**Rules: interest charged per cycle**
- Interest is charged **once per cycle**, with no daily or part-month interest. Interest is charged on **principal only**: never on unpaid interest. There are no penalties and no late fees.
- **Interest for cycle k** = `round_half_up(rate × Bₖ)`, where Bₖ (the cycle's interest base) is:
  - P,
  - minus all principal paid with a `payment_date` on or before Aₖ₋₁ (for cycle 1, nothing),
  - minus principal paid with a `payment_date` inside cycle k **that clears principal arrears of installments 1 to k−1** (the grace window).
- Principal paid inside cycle k towards installment k, or as a prepayment, does **not** reduce Bₖ. It reduces Bₖ₊₁ onwards.
- Consequences:
  - **Delay alone adds no interest:** an installment paid late, but within the next cycle, adds nothing.
  - **Underpayment not made up** by the end of the next cycle leaves principal in Bₖ, so that cycle's interest is higher.
  - **Overpayment** lowers interest from the next cycle onward.
- **Minimum interest:** every disbursed loan is charged at least cycle 1 interest (rate × P), even if it is fully repaid on d0.
- **Early payoff:** paying all outstanding principal, all interest arrears and the current cycle's interest (if not already paid) closes the loan. No later cycle is charged.
- **Past the tenure:** if principal is still owed after Aₙ, cycles continue monthly (cycle n+1, n+2, …) at the loan's rate on the outstanding principal, with the same grace window, until the loan is cleared. In those cycles the amount due is all outstanding principal plus interest arrears plus that cycle's interest.
- **Provisional interest:** the current cycle's interest is shown as *provisional* on statements, because a catch-up payment dated inside the cycle can still lower it. A cycle's interest can also change after the cycle ends if a payment, correction or reversal dated inside it is posted later. Recompute handles both.
- **Amount due for installment k** = scheduled principal_k + principal arrears + interest arrears + cycle k interest.
- **Payoff quote:** a member (for their own loans) or a staff user can request a payoff quote: outstanding principal + interest arrears + current cycle interest (if unpaid). It is valid for payments dated up to the end of the current cycle, and shows that date. Quotes are stored. A payment of the quoted amount dated within validity closes the loan, unless another posting or reversal changes the loan first.

**Rules: allocation of each payment**

Payments for a loan are processed in `payment_date` order, then by posting sequence (schedule `posted_at`, then row number). For a payment dated in cycle k:
1. **Arrears first:** clear interest and principal arrears of installments 1 to k−1, oldest installment first, interest before principal within each installment.
2. **Current installment:** cycle k interest, then scheduled principal_k. (Past the tenure: cycle interest, then all outstanding principal.)
3. **Excess reduces principal (prepayment).** The remaining principal is re-spread equally over the remaining installments k+1 to n, using `round_half_up`, with the final installment absorbing the kobo remainder. The final due date Aₙ is unchanged. If no installments remain, the excess reduces outstanding principal directly.
4. **Closure and Overpayment Credit:** when outstanding principal and all interest charged so far are zero, the loan closes. Any remaining amount becomes the member's Overpayment Credit (`DEPOSIT_CREDITED`).
- `period_covered` on a row is stored for reference only. It never changes the allocation. A payment cannot be earmarked for a future installment; any amount beyond the current installment is a prepayment (step 3).

**Rules: recompute (append-only)**
- A loan's state is a pure function: `state = f(loan terms, opening balance (legacy loans only), all non-reversed payments, as-of date)`.
- After **every** posting, reversal, correction or reclassification that affects a loan, the system recomputes that loan's full state and compares the resulting allocations with those already in the ledger. Any difference is posted, in the same DB transaction, as **reversing events** for the superseded allocations and **replacement events** for the new ones. The events carry the triggering posting's source and evidence, with `metadata.recompute_of` naming the trigger.
- Ledger interest income therefore always equals interest actually paid under the current state.
- If a recompute leaves an amount owing on a CLOSED loan (e.g. after a reversal), the system reopens it (CLOSED → ACTIVE, F7) and notifies the member and the Treasurer. If a recompute closes a loan, any excess moves to the Overpayment Credit.
- For legacy loans, the computation starts from the opening balance at the go-live date (F8). Payments dated before the go-live date are already inside the opening balance and are never replayed.

**Worked examples (₦100,000 / 10 months, d0 = 1 March; A₁ = 1 April, A₂ = 1 May, A₁₀ = 1 January)**

| Case | Payments | Result |
|---|---|---|
| A — On time | ₦17,500 paid by 1 April | Cycle 2 interest ₦6,750 |
| B — Late within the next cycle | ₦17,500 paid 15 April | Cycle 2 interest ₦6,750 (no extra) |
| C — Underpaid, not made up | ₦12,500 paid by 1 April (₦7,500 interest, ₦5,000 principal; ₦5,000 principal short); nothing more by 1 May | Cycle 2 interest ₦7,125 (on ₦95,000) |
| D — Underpaid, then made up | ₦12,500 paid by 1 April; ₦5,000 paid 20 April | Cycle 2 interest ₦6,750 (no extra) |
| E — Overpaid | ₦27,500 paid by 1 April (₦10,000 prepayment) | Cycle 2 interest ₦6,000 (on ₦80,000). Remaining ₦80,000 re-spread as ₦8,888.89 for installments 2–9 and ₦8,888.88 for installment 10. Installment 2 (due 1 May) = ₦14,888.89 |
| F — Past tenure | ₦10,000 principal still owed after A₁₀ (1 January), not paid by A₁₁ (1 February) | Cycle 11 interest ₦750; continues monthly until cleared |
| G — Payoff on the disbursement day | ₦107,500 paid on 1 March | Loan closes. Cycle 1 interest ₦7,500 is the minimum charge |
| H — Payoff mid-loan | Installments 1–2 paid on time; full payoff on 10 May (in cycle 3) | ₦80,000 principal + ₦6,000 cycle 3 interest = ₦86,000. Loan closes |
| I — Backdated catch-up uploaded late | As case D, but the ₦5,000 dated 20 April arrives on a schedule uploaded 10 May | Recompute lowers cycle 2 interest from ₦7,125 to ₦6,750. Any interest already allocated above ₦6,750 is moved to principal by reversing and replacement events |

- All loan calculation lives in pure modules under `src/modules/credit/domain/` (`schedule.ts`, `allocation.ts`, `recompute.ts`), with no I/O, used by both the UI and the server.

**DoD**
- [ ] **[AT-a]** ₦100,000 over 10 months gives installments 17,500.00; 16,750.00; 16,000.00; 15,250.00; 14,500.00; 13,750.00; 13,000.00; 12,250.00; 11,500.00; 10,750.00, total interest 41,250.00 and total 141,250.00, exact to the kobo.
- [ ] ₦100,000 over 3 months gives principal 33,333.33 / 33,333.33 / 33,333.34, summing to exactly 100,000.00.
- [ ] Cases A–I each pass as an automated test, exact to the kobo.
- [ ] **[AT-o]** Case G: payoff on d0 costs ₦107,500; no loan closes with less than cycle 1 interest charged.
- [ ] **[AT-s]** For case H, the payoff quote on 10 May is ₦86,000.00, and a payment of that amount dated within the quote's validity closes the loan.
- [ ] **[AT-m]** Case I: a backdated payment posted after its cycle ended triggers recompute; ledger interest income equals interest actually paid; no ledger row is updated.
- [ ] Recompute is deterministic: posting the same payments in any order gives the same final state.
- [ ] Anniversaries for d0 = 31 January fall on 28/29 Feb, 31 Mar, 30 Apr, 31 May.
- [ ] Interest is never charged on unpaid interest (principal-only base, tested across 3 consecutive underpaid cycles).
- [ ] A reversal that leaves an amount owing reopens a CLOSED loan.
- [ ] The calculator is labelled "Indicative". The binding schedule is shown only after approval.
- [ ] No floating-point arithmetic is used anywhere in money or rate code (lint rule and test guard).

### F7 — Loan Workflow (1b)

**Stories**
- As a member, I apply with my requested amount, preferred tenure, purpose and **one guarantor**.
- As a Loan Officer, I capture an assisted application for a member who applied on paper, with the signed form as evidence.
- As a Loan Officer, I verify KYC and the guarantor, then recommend or decline with comments.
- As Management, I approve (an equal or reduced amount, with tenure possibly adjusted) or reject, with comments.
- As a Cashier, I prepare a disbursement voucher with transfer evidence. As a Finance Manager, I verify it, and the loan becomes `ACTIVE` with its binding schedule.
- As the system, I close the loan automatically when outstanding principal and all interest charged reach zero.

**Rules: states and transitions**

| From | To | By | Notes |
|---|---|---|---|
| — | DRAFT | Member | |
| DRAFT | SUBMITTED | Member | Or created directly as SUBMITTED by the Loan Officer for an assisted application |
| SUBMITTED | VERIFIED | Loan Officer | KYC and guarantor verified |
| VERIFIED | RECOMMENDED | Loan Officer | |
| SUBMITTED / VERIFIED | DECLINED | Loan Officer | |
| RECOMMENDED | APPROVED | Management | Sets `amount_approved`, `tenure_approved`, rate |
| RECOMMENDED | REJECTED | Management | |
| APPROVED | DISBURSEMENT_PENDING | Cashier | Voucher prepared with transfer evidence and value date |
| DISBURSEMENT_PENDING | ACTIVE | Finance Manager | Voucher verified; d0 = transfer value date; posts `CASH_OUT`; binding schedule generated |
| DISBURSEMENT_PENDING | APPROVED | Finance Manager | Voucher returned with a reason; Cashier prepares a new one |
| DRAFT / SUBMITTED | CANCELLED | Member | |
| APPROVED | CANCELLED | Management | Before any voucher is prepared |
| ACTIVE | CLOSED | System | Outstanding principal and all interest charged are zero |
| CLOSED | ACTIVE | System only | Recompute after a reversal or correction leaves an amount owing (F6) |
| — | ACTIVE | System | Legacy loan import committed (F8) |

- `amount_requested` and `amount_approved` are stored separately, as are `tenure_requested` and `tenure_approved`.
- **A member may hold more than one active loan.** Each loan has its own `loan_account_no` (format `CSS-YYYY-NNNNN`, where YYYY is the year the number is issued and NNNNN runs per year).
- Guarantor fields: name, phone, address, relationship, MOAUM ID number if a member, and a signed guarantor form as evidence. The guarantor may be a member or a non-member.
- **Exposure panel:** at verification and approval, the Loan Officer and Management see the applicant's active loans, outstanding principal, arrears, Overpayment Credit and past loan history, plus the guarantor's current guarantees (number of loans and their outstanding principal) when the guarantor is a member. The panel also shows both limits below and how close the applicant and guarantor are to them.
- **Borrowing and guarantee limits** (financial settings, F2):
  - `max_open_loans_per_member` = **2**. An **open loan** is any loan from SUBMITTED to ACTIVE (SUBMITTED, VERIFIED, RECOMMENDED, APPROVED, DISBURSEMENT_PENDING, ACTIVE).
  - `max_open_guarantees_per_guarantor` = **2**: the number of open loans a person guarantees. Member guarantors are identified by MOAUM ID, non-member guarantors by phone number.
  - Both are checked when an application is submitted and again when Management approves it. If either limit would be exceeded, the action is refused with the reason; there is no override.
  - Legacy loans count towards the limits but are never refused by them at import. A member or guarantor already above a limit at go-live can't add another open loan or guarantee until they are back below it.
  - Changing either value is a financial setting change (F2): Admin proposes, Management approves, and the new value applies to applications submitted from its effective date.
- Every transition records user, timestamp and comment, and is written to the audit trail.
- Disbursement posts `CASH_OUT` (source `DISBURSEMENT_VOUCHER`) only after Finance Manager verification. The full approved amount is disbursed, with **no deductions**.

**DoD**
- [ ] Each transition is allowed only for the role and prior status in the table above (state-machine unit tests).
- [ ] The same user cannot both prepare and verify a disbursement voucher.
- [ ] **[AT-u]** A member with 2 open loans can't submit a third, and a guarantor on 2 open loans can't guarantee a third; both are refused at submission and again at approval, with the reason shown.
- [ ] The binding schedule uses only the approved amount, tenure and rate, with d0 from the verified voucher.
- [ ] Member, guarantor and approver receive status notifications (from 1d).

### F8 — Legacy Loan Import (1b)

**Stories**
- As an Admin, I upload existing members' ongoing loans from Excel using the provided template.
- As a Finance Manager, I review the dry-run reconciliation, resolve flagged mismatches, and commit.

**Template header:** `go_live_date, control_total_original_principal, control_total_outstanding_principal, row_count`.
**Template columns:** `member_moaum_id, legacy_account_no, original_principal, interest_rate_monthly_percent, tenure_months, disbursement_date, installments_paid, total_paid, outstanding_principal, arrears_amount, next_due_date, next_installment_amount, evidence_reference`.

**Rules (per row)**
1. `member_moaum_id` must match an ACTIVE member (load members first, F5). `go_live_date` must equal the go-live date setting.
2. Regenerate the original schedule from principal, rate, tenure and disbursement date (F6), with anniversaries anchored to the disbursement day.
3. Apply `total_paid` to the regenerated schedule oldest installment first, interest before principal.
4. Compare the stated `outstanding_principal`, `arrears_amount`, `next_due_date` and `next_installment_amount` against the regenerated position as at the go-live date.
5. Each mismatch is flagged and must be resolved before commit, either:
   - **accepted with a reason** by the Finance Manager: the stated figures become the opening balance, and the remaining principal (outstanding less arrears) is re-spread over the remaining installments with the final due date unchanged; or
   - **rejected**: the Admin corrects the file and uploads it again as a new import batch.
6. On commit:
   - the system issues a new `CSS-YYYY-NNNNN` number to every legacy loan and stores the old number as `legacy_account_no`;
   - the loan is created `ACTIVE`;
   - **one `OPENING_BALANCE` event** is posted per loan (source `LEGACY_IMPORT`, `principal_amount` = outstanding principal, `metadata` = principal arrears, interest arrears, next due date), with the import file as evidence;
   - **no historic events are posted.** Interest earned before the go-live date never appears as revenue.
7. After go-live, legacy loans run under F6 from their opening balance. Interest arrears at go-live are owed and become `INTEREST_INCOME` when paid.
8. Remittance rows may identify a legacy loan by its new number or its `legacy_account_no` (F9). Statements, receipts and SMS show the new number, with the legacy number alongside.

**DoD**
- [ ] **[AT-b]** A loan imported mid-life (₦100,000 / 10 months / 7.5%, 4 installments paid before go-live) shows outstanding principal ₦60,000.00 and next installment ₦14,500.00, then accepts the next remittance correctly.
- [ ] A control total mismatch rejects the whole file.
- [ ] Commit is all-or-nothing, with a per-row log.
- [ ] Uploader (Admin) and committer (Finance Manager) must be different users.
- [ ] Every committed legacy loan has a new `CSS-YYYY-NNNNN` number and exactly one OPENING_BALANCE event, and no historic INTEREST_INCOME exists.

### F9 — Remittance Schedule Ingestion: Track A (1b; direct payment rows from 1c)

**Stories**
- As the Finance Manager, I upload the Source Advice that I obtained directly from each remittance source for the month.
- As the Treasurer, I upload the monthly remittance schedule for a source, preview a dry run, and commit.
- As a member, I see my repayments on my statement, and get an SMS with the amount applied, as soon as the schedule posts.

**Source Advice (uploaded by the Finance Manager)**
- Header: `remittance_source, month_covered, advice_reference, control_total, row_count`, plus the original document received from the source as evidence.
- Rows: `member_moaum_id, member_name, amount`. One row per member.
- Each Source Advice is matched by exactly one schedule. A superseding advice (with evidence and reason) may replace one that no schedule has used yet, or one being corrected (see Corrections).

**Remittance schedule (uploaded by the Treasurer)**
- Header: `schedule_reference, remittance_source, month_covered, schedule_type (REGULAR | SUPPLEMENTARY), advice_reference, submitted_by, control_total, row_count`, plus the schedule file as evidence. There is one REGULAR schedule per source per month; SUPPLEMENTARY schedules cover later additions.
- **Rows sheet:** `row_type (PAYROLL | DIRECT), member_moaum_id, member_name, loan_account_no (new or legacy number; may be blank), amount_paid, payment_date, period_covered (optional, reference only), receipt_no (optional), bank_credit_ref (required for DIRECT rows), row_note`.
- **Lodgements sheet** (payroll money paid into MOAUM's bank): `bank_account, deposit_date, reference (slip number or transfer reference), amount, depositor, note`, plus a slip or transfer advice file where one exists. The remittance sheet itself is the lodgement's evidence. Lines may total more or less than the payroll rows; the difference is shown on the dry run and handled by Track A reconciliation (F11). Zero lines are allowed (nothing paid yet).

**Validation (all mandatory; any failure rejects the whole batch with a per-row reason log)**
- Row sum equals `control_total`. Row count equals `row_count`.
- `schedule_reference` has not been used before for the same source. No duplicate rows (`schedule_reference + row_hash`).
- Every row's member exists and is ACTIVE or EXITED. Unknown or PENDING members reject the batch.
- Loan resolution per row:
  - `loan_account_no` given: the loan must belong to the member and be ACTIVE (allocated per F6) or CLOSED (posted to Overpayment Credit). Any other status rejects the batch.
  - `loan_account_no` blank: if the member has no ACTIVE loan, the row posts to Overpayment Credit; if exactly one ACTIVE loan, the row is allocated to it; if more than one, the batch is rejected ("loan_account_no required").
- `amount_paid > 0`.
- `payment_date` is not after the commit date, not after the last day of `month_covered`, not before the loan's d0, and not before the go-live date.
- **Payroll rows match the Source Advice:** for the referenced `advice_reference` (same source and month, not used by another schedule), each member's total of payroll rows equals that member's advice amount. A member on the advice but missing from the schedule, or on the schedule but missing from the advice, rejects the batch.
- **Direct payment rows match a tagged bank credit:** `bank_credit_ref` names a bank statement credit that the Finance Manager has tagged to that member (F10), that no other row has used, and whose amount equals `amount_paid`.
- Lodgement lines: the lodgement uniqueness key (F10) has not been used before.
- A dry-run preview is required before commit, showing the per-row allocation, Overpayment Credits, the Source Advice match and the lodgement total against the payroll total. The commit re-runs every validation.

**Posting (one DB transaction)**
- Each row is allocated per F6 and triggers a recompute of its loan. Each row posts `PRINCIPAL_RECOVERY`, `INTEREST_INCOME` and `DEPOSIT_CREDITED` events as applicable (source `REMITTANCE_SCHEDULE`). The batch posts `SCHEDULE_ACCEPTED` and `SCHEDULE_POSTED`.
- Lodgement lines are stored as Unverified Lodgements linked to the schedule. Direct payment rows create a BANK_VERIFIED lodgement from their tagged credit.
- **No second-human approval** of the schedule is needed. The Source Advice and the tagged bank credits are independent records created by the Finance Manager, so the Treasurer cannot move money between members or invent amounts. Posting is allowed before the bank lodgement is verified (reconciled in F11).

**Corrections**
- Only by a **correction batch** referencing the original schedule: reversing entries for the affected rows plus any replacement rows, with a reason and evidence. Prepared by the Treasurer, verified by the Finance Manager. Posting triggers recompute of every affected loan.
- After a correction, the schedule's payroll rows must still match its Source Advice. If the advice itself was wrong, the Finance Manager first uploads a superseding advice with the source's corrected document as evidence.

**DoD**
- [ ] **[AT-c]** A valid schedule posts to loan balances with no human verification gate and appears on each member's statement.
- [ ] **[AT-d]** A schedule whose rows don't sum to the control total is rejected as a whole, with a per-row reason log.
- [ ] **[AT-e]** A row with an unknown member, or a loan that does not belong to the member, rejects the whole batch atomically. No partial writes exist after rejection.
- [ ] **[AT-p]** A row on a CLOSED loan, and a row for a member with no ACTIVE loan, each post to that member's Overpayment Credit (`DEPOSIT_CREDITED`) and the rest of the batch posts normally.
- [ ] **[AT-l]** A schedule whose total matches but whose per-member payroll amounts differ from the Source Advice (₦2,500 moved from member X to member Y) is rejected as a whole with a per-member mismatch log.
- [ ] **[AT-i]** A duplicate schedule row is rejected.
- [ ] A direct payment row without a matching member-tagged bank credit is rejected.
- [ ] Overpayment re-spread and Overpayment Credit creation are covered by unit tests.
- [ ] The whole commit runs in one DB transaction. A forced failure mid-batch rolls back everything.
- [ ] The accepted batch is logged with uploader, checksum and timestamp.

### F10 — Bank Accounts, Statements & Lodgement Verification: Track B (1c)

**Stories**
- As an Admin, I configure MOAUM bank accounts and upload their opening balances at the go-live date. As a Finance Manager, I verify and commit them.
- As a Finance Manager, I upload the monthly bank statement for each MOAUM bank account.
- As a Finance Manager, I match each statement credit to its lodgement and mark the lodgement `BANK_VERIFIED`, and I tag members' direct payment credits to the member.
- As a Cashier, I record and apply **only** BANK_VERIFIED lodgements, and record bank charges, bank interest and internal transfers from statement lines.

**Rules: accounts and statements**
- Bank accounts (bank name, branch, account number, NGN) are configured by Admin. Bank names are to be supplied (Section 10).
- **Opening balances:** Admin uploads one opening balance per account as at the go-live date, with the bank statement showing it as evidence. The Finance Manager verifies and commits it, posting `OPENING_BALANCE` (`cash_amount`, `bank_account_id`, source `LEGACY_IMPORT`). Uploader and committer must differ.
- Statement import uses a standard MOAUM template **plus a saved column mapping per bank account**, so each bank's own export can be mapped once and reused.
- **Continuity:** a statement's opening balance must equal the previous imported statement's closing balance for that account (the first statement continues from the go-live opening balance). Otherwise the import is rejected.
- **Line uniqueness:** a statement line is identified by `bank_account + transaction_date + direction + amount + reference + running_balance`. Lines already imported from an overlapping statement are skipped, not duplicated.

**Rules: credits and lodgements**
- Mandatory verification order for a payroll lodgement:
  1. A statement credit line exists.
  2. The lodgement exists as a line on a posted remittance schedule (F9), with the sheet as evidence plus any slip or transfer advice.
  3. The Finance Manager confirms amount (equal), date (within ±3 days) and reference, and marks it `BANK_VERIFIED`. The system proposes matches; it never verifies on its own.
  4. The Cashier records and applies it to its schedule, posting `CASH_IN` and `LODGEMENT_APPLIED`.
- **Direct member payments:** when a member pays directly into a MOAUM bank account, the Finance Manager tags that statement credit to the member, with evidence (the statement narration and, where available, the member's transfer receipt). The tagged credit is BANK_VERIFIED. The Treasurer then adds it as a DIRECT row on the month's remittance schedule (F9), and after posting the Cashier records and applies it (`CASH_IN`, `LODGEMENT_APPLIED`).
- A statement credit with no matched lodgement and no member tag is an **Unapplied Bank Credit**. A lodgement with no matched credit stays an **Unverified Lodgement**. Both have ageing reports (0–30, 31–60, 61–90, 90+ days).
- In Phase 1, a lodgement can only back a remittance schedule.
- Lodgement uniqueness key: `bank_account + reference + amount + deposit_date`. Receipt uniqueness key, when a receipt number is given on a row: `receipt_series + receipt_number`.
- Nothing is auto-allocated across members.

**Rules: debits and other bank lines**
- The Finance Manager matches statement debits to verified disbursement and refund vouchers (amount equal, date within ±3 days, reference).
- **Bank line entries:** bank charges, bank interest and transfers between MOAUM accounts are recorded by the Cashier from the statement line (statement as evidence) and verified by the Finance Manager. They post `CASH_OUT` or `CASH_IN` (source `BANK_STATEMENT`) with `metadata.category` = `BANK_CHARGE | BANK_INTEREST | INTERNAL_TRANSFER`. Bank interest is shown as "Other bank credits" and is not module revenue.

**DoD**
- [ ] **[AT-f]** A Cashier's attempt to record or apply a lodgement that is not BANK_VERIFIED is blocked at the API (403 plus an audit entry).
- [ ] **[AT-g]** A bank credit with no matching lodgement and no member tag appears in Unapplied Bank Credits and on the ageing report.
- [ ] **[AT-i]** A duplicate lodgement (same uniqueness key) is rejected.
- [ ] A Cashier cannot create a lodgement or receipt from nothing. There is no "new receipt" endpoint for the Cashier role.
- [ ] A statement that breaks continuity is rejected; an overlapping statement does not duplicate lines.
- [ ] Opening balance uploader and committer must be different users.

### F11 — Reconciliation & Exceptions (1c)

The Finance Manager runs reconciliation for a month after the statements covering that month (plus 3 days) are imported for every account.

**Track A reconciliation (schedule vs bank)**
- For each posted schedule: `difference = schedule total − BANK_VERIFIED lodgements of that schedule`.
- Before the month's run, a positive difference is shown as **Recorded, not yet paid**. At the run, a positive difference raises a **SHORTFALL** exception against the remittance source, and a negative one raises an **EXCESS** exception. Totals are also shown per source per month.
- If a later lodgement is verified for the schedule, the exception amount updates and, at zero, the exception is marked "ready to close".
- **Loan balances are never changed by reconciliation.** There is no reversal of member repayments.

**Track B reconciliation (bank vs records)**
- Statement lines are matched to lodgements, tagged credits, vouchers and bank line entries. Unmatched items raise exceptions of one of these types: `IN_BANK_NOT_IN_SYSTEM` (unapplied credits, unrecorded debits), `IN_SYSTEM_NOT_IN_BANK` (Unverified Lodgements and verified vouchers with no statement line), `AMOUNT_MISMATCH` (reference matches, amount differs), `DUPLICATE` (two records claim the same line, or a line appears twice).

**Joint reconciliation (monthly, per bank account and in total)**

Two equations must hold. Every reconciling item is listed with ageing, and any remaining difference raises a `LEDGER_BANK_DIFFERENCE` exception.

```
(1) Bank ↔ ledger, per account, at month end
Statement closing balance
  = Ledger cash   (OPENING_BALANCE cash + CASH_IN − CASH_OUT for the account, occurred_at ≤ month end)
  + Unapplied Bank Credits
  + Tagged direct payment credits not yet on a posted schedule
  + BANK_VERIFIED lodgements not yet recorded by the Cashier
  − Statement debits not yet recorded (no verified voucher or bank line entry)
  + Recorded debits not yet on the statement

(2) Repayments ↔ bank, all schedules posted up to month end
Repayments recorded  (sum of posted schedule totals, net of corrections)
  = BANK_VERIFIED lodgements of those schedules
  + Recorded, not yet paid  (sum of positive schedule differences)
  − Excess                  (sum of negative schedule differences)
```

There is no cash-in-transit: money is either BANK_VERIFIED or Recorded, not yet paid.

**Exception lifecycle**
- Types: `SHORTFALL`, `EXCESS`, `IN_BANK_NOT_IN_SYSTEM`, `IN_SYSTEM_NOT_IN_BANK`, `AMOUNT_MISMATCH`, `DUPLICATE`, `LEDGER_BANK_DIFFERENCE`, `DUPLICATE_EVIDENCE`.
- `OPEN` (raised by the system) → `UNDER_REVIEW` (Finance Manager, adding notes and supporting evidence) → `CLOSED`.
- Only the **GMD** can close an exception, and only when it is **confirmed**: either matching bank evidence has arrived, or a documented explanation is attached as evidence. A reason is mandatory.
- Closing an exception never changes loan balances or the ledger. If the explanation needs a correction, the correction is posted first (F9) through its own dual control.
- Every exception shows ageing days from the date it was raised.

**Monthly close**
- After the month's joint reconciliation, the Finance Manager closes the month. The month's reports are saved as PDF snapshots (stored as evidence) at that moment.
- Ledger events posted after a month is closed but with an `occurred_at` inside it (backdated payments, recomputes, corrections) are never hidden. The closed month's reports stay as snapshotted, and these events appear in the next open month as **prior-period adjustments**, listed separately.
- Months close in order. A closed month is never reopened; later changes reach it only as prior-period adjustments.

**DoD**
- [ ] **[AT-h]** A ₦500,000 schedule backed by only ₦480,000 of BANK_VERIFIED lodgements leaves loan balances as per the schedule, raises a ₦20,000 SHORTFALL exception against the source, and reverses no member repayment.
- [ ] **[AT-k]** Equations (1) and (2) hold to the kobo for a test month with opening balances, verified and unverified lodgements, an unapplied credit, a disbursement, a bank charge and a shortfall; every reconciling item and exception is listed with ageing.
- [ ] An exception cannot be closed without evidence and a reason, or by anyone other than the GMD.
- [ ] **[AT-t]** After a month is closed, a backdated payment dated inside it leaves that month's snapshotted reports unchanged and appears as a prior-period adjustment in the next open month.

### F12 — Overpayment Credits & Refunds (1c)

**Stories**
- As a member, I can request a refund of my Overpayment Credit, or, before the next REGULAR schedule for my remittance source posts, request that a prepayment be refunded instead of reducing principal.
- As Management, I approve the refund. As a Cashier, I prepare the refund voucher. As a Finance Manager, I verify it.

**Rules**
- An Overpayment Credit arises from: an excess after the loan is fully paid (F6); a row on a CLOSED loan; a row for a member with no ACTIVE loan (F9); a reclassified prepayment (below). Each posts `DEPOSIT_CREDITED`.
- Overpayment Credits are only ever refunded. They are never applied to another loan in Phase 1.
- **Refund:** member request (in the portal, or a signed request captured by the Loan Officer) → Management approves → Cashier prepares a refund voucher with transfer evidence → Finance Manager verifies (different user) → posts `CASH_OUT` (source `REFUND_VOUCHER`) and `DEPOSIT_REFUNDED`.
- **Refund instead of principal reduction:** the Treasurer prepares a reclassification of the prepayment into Overpayment Credit, with the member's request as evidence; the Finance Manager verifies it. The system recomputes the loan, undoing the principal reduction and re-spread through reversing and replacement events and posting `DEPOSIT_CREDITED`. The refund then follows the steps above.

**DoD**
- [ ] Each refund requires a Management approval, a voucher with evidence, and verification by a different user.
- [ ] The member's statement shows the overpayment, the refund and the resulting balances.
- [ ] A reclassification restores the loan's schedule to what it would have been without the prepayment.

### F13 — Statements, Receipts & Reports (1d)

**Member-facing**
- Loan statement per loan: schedule, payments, allocations, provisional current-cycle interest, balances, and Overpayment Credit. Downloadable as PDF.
- PDF receipt for each posted repayment row, showing the receipt number, the schedule reference, the loan number(s), and a QR code or checksum for verification.
- Payoff quote (F6), downloadable as PDF.
- Public **receipt verification page**: scanning a receipt's QR code opens a page that shows only whether the receipt is genuine, its number, amount and date, and a masked member name. Rate limited.

**Staff reports (all exportable to Excel and PDF)**
1. Active loans register (per member, per loan).
2. Expected vs actual collections, per month and per source.
3. Interest income, per month.
4. Arrears listing (amount only; no overdue classification).
5. Legacy import reconciliation and opening balances.
6. Schedule-vs-bank reconciliation (Track A), incl. Recorded, not yet paid.
7. Unapplied Bank Credits, with ageing.
8. Unverified Lodgements, with ageing.
9. Joint reconciliation and exceptions.
10. Overpayment Credits and refunds.
11. Audit trail extract.
12. Ledger export: every ledger event with its evidence references for a date range (Excel/CSV), for auditors.
13. Prior-period adjustments per closed month.
14. Invitations sent, by sender and status, with conversion to registered and activated members.

**DoD**
- [ ] Every report figure ties back to ledger totals (a test compares report totals with ledger sums). For a closed month, the snapshot plus its listed prior-period adjustments equals the current ledger total.
- [ ] PDFs render correctly in NGN format, e.g. ₦141,250.00.

### F14 — GMD Consolidated Dashboard (1d)

- **Cash Position:** bank balances (latest statements), verified money in and out (`CASH_IN` / `CASH_OUT`), Unapplied Bank Credits, Unverified Lodgements, Recorded, not yet paid. Recorded and verified figures are shown separately. Any figure can be drilled down to its transaction and evidence.
- **Revenue Earned:** recognised revenue per module per period (`INTEREST_INCOME` net of reversals for Credit). It **excludes** principal recovery, opening balances, Overpayment Credits, bank interest (shown separately as Other bank credits), and any unearned amounts from other modules.
- **Also shown:** module status, Track A shortfall and excess exceptions, exception summary with ageing, payment trends, and per-module leaderboards (Credit only in Phase 1).

**DoD**
- [ ] **[AT-j]** The revenue view excludes `PRINCIPAL_RECOVERY`, `OPENING_BALANCE`, `DEPOSIT_CREDITED` and bank interest.
- [ ] The dashboard is read-only for financial data. The GMD's only financial write action is closing exceptions (F11); the GMD's only other writes are invitations and announcements. Every other GMD write is rejected at the API.
- [ ] Data is near real time, re-queried from the ledger on load with ≤ 60 s caching.

### F15 — Notification Triggers (1d)

- **Member:** invitation (registration or activation link); registration received or activated; profile change approved or declined; loan status changes; schedule posted (amount applied per loan, and any amount sent to Overpayment Credit); loan closed or reopened; refund processed; sign-in from a new device.
- **Member reminders:** for members whose remittance source is "None — pays directly", a reminder 5 days before each installment is due; for every member with arrears, a reminder 3 days after the due date, repeated each cycle while arrears remain. Day counts are settings.
- **Staff:** new application; items awaiting verification; new exception; exception ageing over 30 days; duplicate evidence flagged; loan reopened; invitee registered (to the sender); financial setting change awaiting approval (to Management).
- **Admin:** SMS provider balance below a set threshold; failed scheduled job; repeated notification provider failures.
- **Announcements:** the GMD and the Secretary can send an SMS and/or email announcement (for example an AGM notice) to all ACTIVE members or to the ACTIVE members of one remittance source. Before sending, the screen shows the recipient count and the number of SMS units, and the sender confirms. Each announcement is logged with its recipients and delivery status.
- Channels are SMS (Termii) and email (Resend), live since 1a. Each user can set a preferred channel. One-time codes always go by SMS for members and by email for staff.
- The per-row "schedule posted" SMS is a stated control: it lets each member see exactly what was applied for them.

**DoD**
- [ ] Each trigger sends once (idempotent key per trigger and entity), and is logged with delivery status.
- [ ] An announcement can't be sent without the confirmation step, and only ACTIVE members receive it.

---

## 5. Technical Constraints

| Area | Decision |
|---|---|
| Runtime | Node.js **24 LTS** (pinned in `.nvmrc` and `package.json` `engines`) |
| Framework | Next.js (latest stable), **App Router**, Server Components + Server Actions; Route Handlers for the public REST API |
| Language | TypeScript, `"strict": true`, `noUncheckedIndexedAccess: true`; no `any` (ESLint error) |
| Styling | Tailwind CSS; shadcn/ui components; neutral placeholder theme until branding is decided |
| Database | PostgreSQL on **Neon, Free plan** to start, separate Postgres schemas: `shell`, `ledger`, `evidence`, `credit`. Region: an AWS Europe region (London or Frankfurt), with Vercel functions in the same region. Neon's Data API is not enabled |
| DB roles | A migration role (owner, used only by `prisma migrate`) and a runtime role `app_runtime` used by the app. `app_runtime` has only `INSERT` and `SELECT` on ledger and audit tables |
| ORM | Prisma with `multiSchema`; migrations committed to Git; the app connects through Neon's pooled connection string (as `app_runtime`) and migrations use the direct connection string (as the owner role); interactive transaction timeout set explicitly for schedule and import commits (the default is 5 s) |
| Money | Integer kobo stored as `BigInt`; a single `Money` helper for arithmetic, half-up rounding, formatting and JSON serialization; rates stored as integer basis points; no JS `number` for money or rates |
| Validation | Zod on every server action and API input |
| Auth | Better Auth (email/password for staff, phone-number plugin for members with SMS verification and reset, TOTP two-factor plugin), with roles stored in the `shell` schema |
| File storage | Cloudflare R2 (free tier), private bucket, presigned URLs (5 min); SHA-256 computed server-side; a bucket lock rule keeps every object for 7 years, and the app has no delete code path |
| Excel | `exceljs` for reading templates and writing exports |
| PDF | `@react-pdf/renderer` |
| SMS / Email | Termii / Resend, behind a `NotificationProvider` interface so providers can be swapped; live from Milestone 1a |
| Testing | Jest + React Testing Library; an integration test DB (Docker Postgres locally; a temporary Neon branch in CI, deleted after the run); every acceptance test (AT-a to AT-u) is an automated test |
| CI | GitHub Actions: `lint`, `tsc --noEmit`, `jest` on every push and PR to `main` |
| Hosting | Vercel (production + preview deployments); secrets only in Vercel environment variables, never committed |
| Imports | Imports and schedule commits (including recompute) run in a single DB transaction. At about 150 members, batches stay well inside Vercel function time limits |
| Security | API-level role-based access control and self-dealing checks on every action; the app DB role has no UPDATE/DELETE on ledger and audit tables; rate limiting on auth and public endpoints; NDPA 2023 consent and data-access logging |
| Data retention | Evidence, ledger and audit kept for 7 years minimum; no hard deletes |
| Locale | `en-NG`, NGN, Africa/Lagos timezone for all dates, anniversaries and month boundaries |
| Scheduled jobs | Vercel Cron for invitation expiry, notification retries, reminders, exception ageing alerts and SMS balance checks. Every job is idempotent and logs each run |
| Backups | A nightly encrypted `pg_dump` of the production database, run by a scheduled GitHub Actions workflow and stored in a separate R2 bucket: daily copies kept 35 days, month-end copies kept 7 years. Neon's own restore window is short on the Free plan and is not relied on. Recovery point ≤ 24 hours and recovery time ≤ 8 hours while on Free; recovery point ≤ 1 hour after upgrading. A restore test every quarter, with the result recorded |
| Monitoring | Error tracking (e.g. Sentry) with personal data scrubbed; uptime check on `/api/v1/health`; alerts to Admin |
| Environments | Production and staging use separate Neon projects (and separate R2 buckets). Staging and preview deployments only ever hold seeded or anonymized data |
| Neon Free guardrails | The Free plan gives each project a monthly compute allowance (100 CU-hours) and suspends compute when it runs out, which would take the app offline. So: compute is capped at 0.25 CU with scale-to-zero after 5 idle minutes; the uptime check on `/api/v1/health` does not query the database; scheduled jobs run in one batch at most twice a day; database size, compute hours and branch count (10 on Free) are shown to Admin, with an alert at 80% of any limit |
| Upgrade triggers | Move to a paid Neon plan when any of these happens: usage passes 80% of a Free limit for two months running; MOAUM wants a recovery point under 24 hours; or the free plan's terms change. The upgrade needs no code change |
| Member portal | Mobile-first, usable at 360 px width on slow connections; WCAG 2.1 AA for staff and member pages; English |

---

## 6. File / Folder Structure

```
dommus-negotii/
├─ PRD.md
├─ .nvmrc
├─ .env.example
├─ .github/workflows/ci.yml
├─ prisma/
│  ├─ schema.prisma              # multiSchema: shell, ledger, evidence, credit
│  ├─ migrations/                # incl. app_runtime role grants
│  └─ seed.ts                    # roles, settings, demo users (dev only)
├─ templates/                    # downloadable Excel templates
│  ├─ remittance-schedule.xlsx   # Rows sheet + Lodgements sheet
│  ├─ source-advice.xlsx
│  ├─ bank-statement.xlsx
│  ├─ bank-opening-balances.xlsx
│  ├─ legacy-loans.xlsx
│  ├─ members.xlsx
│  └─ invitations.xlsx
├─ docs/
│  ├─ api/                       # OpenAPI spec for REST endpoints
│  ├─ integration-contracts.md   # auth API, ledger event schema, evidence API
│  └─ module-registration-guide.md
├─ src/
│  ├─ app/
│  │  ├─ (public)/               # landing, invitation link (/join/[token]), open registration, receipt verification (/verify/[code])
│  │  ├─ (auth)/                 # login, 2FA, phone verification, reset, sessions
│  │  ├─ (member)/               # member portal: loans, statements, receipts, refunds, payoff quotes, profile, data copy
│  │  ├─ (staff)/
│  │  │  ├─ members/             # invitations, announcements, member directory, profile change approvals
│  │  │  ├─ credit/              # applications, loans, schedules, source advice, lodgements, bank, reconciliation
│  │  │  ├─ reports/
│  │  │  ├─ gmd/                 # read-only dashboard + exception closing
│  │  │  ├─ audit/
│  │  │  └─ admin/               # users, roles, settings, sources, bank accounts, modules
│  │  └─ api/v1/                 # REST route handlers (documented contracts)
│  ├─ shell/                     # portal shell (shared layer)
│  │  ├─ auth/
│  │  ├─ rbac/                   # permissions matrix, requireRole(), SoD and self-dealing rules
│  │  ├─ audit/
│  │  ├─ notifications/
│  │  ├─ registry/
│  │  ├─ settings/               # settings, approval of financial settings
│  │  └─ jobs/                   # scheduled jobs (Vercel Cron handlers)
│  ├─ ledger/                    # shared ledger (contract)
│  │  ├─ events.ts               # event types, sources, Zod schemas (schema_version 2)
│  │  ├─ post.ts                 # idempotent append + reversal
│  │  └─ queries.ts
│  ├─ evidence/                  # evidence repository (contract), duplicate-evidence flag
│  ├─ modules/
│  │  └─ credit/
│  │     ├─ domain/              # PURE logic, no I/O
│  │     │  ├─ schedule.ts       # dates, planned schedule, cycle interest
│  │     │  ├─ allocation.ts     # payment allocation, re-spread, closure
│  │     │  ├─ recompute.ts      # full-state rebuild + ledger diff
│  │     │  ├─ loan-state.ts     # workflow state machine
│  │     │  └─ reconciliation.ts # Track A, Track B, joint equations
│  │     ├─ imports/             # remittance, source advice, bank statement, opening balances, legacy, members, invitations
│  │     ├─ actions/             # server actions (role-checked)
│  │     ├─ repo/                # Prisma data access
│  │     └─ components/          # module UI components
│  ├─ components/ui/             # shared UI primitives
│  └─ lib/
│     ├─ money.ts                # kobo Money type, bps rates
│     ├─ dates.ts                # WAT-aware anniversaries and cycles
│     └─ hash.ts                 # SHA-256, row_hash
└─ tests/
   ├─ unit/                      # domain logic (schedule, allocation, recompute, state machine)
   ├─ integration/               # server actions against test DB
   └─ acceptance/                # AT-a … AT-u, one file each
```

**Rule:** `modules/credit` may import from `shell`, `ledger`, `evidence` and `lib`. Those shared layers must **never** import from a module. An ESLint `no-restricted-imports` rule enforces this.

---

## 7. Data Model (outline; finalised during data-model design before the Milestone 1a build)

- **shell:** `PortalUser, Session, TwoFactor, Role, UserModuleRole, Module, AuditLog, Notification, Announcement, Setting, SettingChangeRequest, JobRun` (settings include `interest_rate_bps` with effective date, `go_live_date`)
- **evidence:** `EvidenceFile`, `EvidenceLink (entity_type, entity_id, evidence_id, kind: PRIMARY | SUPPORTING, submission_id)`
- **ledger:** `LedgerEvent` (fields as in F4)
- **credit:** `Member, Invitation, ProfileChangeRequest, Guarantor, LoanApplication, Loan (incl. legacy_account_no), Installment, LoanTransition, RemittanceSource, SourceAdvice, SourceAdviceRow, RemittanceSchedule, RemittanceRow, CorrectionBatch, Allocation, BankAccount, BankStatement, BankStatementLine, DirectPaymentTag, Lodgement, Voucher (DISBURSEMENT | REFUND), BankLineEntry, ReconciliationRun, ReconciliationException, OverpaymentCredit, Reclassification, Refund, ImportBatch, ImportRowLog, PayoffQuote, PeriodClose`

---

## 8. Integration Contracts (delivered for Modules 2–7)

1. **Auth API:** session lookup, `hasPermission(user, module, action)`, user-to-entity linking, self-dealing check.
2. **Ledger event schema:** versioned Zod/JSON Schema (`schema_version` 2); `postEvent()` and `reverseEvent()`; idempotency rules; sign convention (positive originals, negated reversals).
3. **Evidence API:** upload, link (primary or supporting), retrieve with checksum verification, duplicate-evidence flag.
4. **Module registration:** module code, status endpoint, list of emitted event types.

A new module plugs in by registering itself, owning its own Postgres schema, and talking only to these contracts.

---

## 9. Acceptance Tests (automated; all must pass for Phase 1 sign-off)

| ID | Test | Milestone |
|---|---|---|
| AT-a | ₦100,000 / 10 months schedule correct to the kobo (₦41,250 interest; ₦141,250 total) | 1b |
| AT-b | Legacy loan imported mid-life with an opening balance reconciles and resumes correctly | 1b |
| AT-c | Valid remittance schedule posts with no human gate and appears on each member's statement | 1b |
| AT-d | Control-total mismatch rejects the whole batch with a per-row reason log | 1b |
| AT-e | Unknown member, or a loan not belonging to the member, rejects the batch atomically | 1b |
| AT-f | Cashier cannot record or apply a lodgement before it is BANK_VERIFIED | 1c |
| AT-g | Bank credit with no lodgement and no member tag sits in Unapplied Bank Credits and appears on the ageing report | 1c |
| AT-h | ₦500,000 schedule vs ₦480,000 BANK_VERIFIED lodgements gives a ₦20,000 SHORTFALL exception, with no loan reversal | 1c |
| AT-i | Duplicate lodgement rejected (1c); duplicate schedule row rejected (1b) | 1b / 1c |
| AT-j | GMD revenue excludes principal recovery, opening balances, Overpayment Credits and bank interest | 1d |
| AT-k | Joint reconciliation equations (1) and (2) hold to the kobo; all reconciling items and exceptions listed and aged | 1c |
| AT-l | Schedule with the right total but per-member amounts that differ from the Source Advice is rejected (Treasurer cannot move money between members) | 1b |
| AT-m | Backdated payment posted after its cycle ended is recomputed through reversing and replacement events; interest income equals interest paid | 1b |
| AT-n | Same file as primary evidence for two submissions opens a DUPLICATE_EVIDENCE exception | 1a |
| AT-o | Payoff on the disbursement day costs principal + cycle 1 interest (₦107,500 on ₦100,000) | 1b |
| AT-p | Rows on a CLOSED loan or for a member with no ACTIVE loan post to Overpayment Credit without rejecting the batch | 1b |
| AT-q | Only Admin, GMD and Secretary can send invitations; a link registers one PENDING member and is refused once used, expired or revoked | 1a |
| AT-r | A financial setting change has no effect until Management approves it; a backdated effective date is rejected | 1a |
| AT-s | Payoff quote equals the amount that actually closes the loan (case H: ₦86,000) | 1b |
| AT-t | A closed month's reports are unchanged by later backdated events, which appear as prior-period adjustments | 1c |
| AT-u | A third open loan per member, or a third open guarantee per guarantor, is refused at submission and at approval | 1b |

**Global Definition of Done (every feature):** `npm run lint`, `npx tsc --noEmit` and `npm test` pass in CI; role and self-dealing checks are covered by tests; actions are audited; no money or rate calculated with `number`; the feature is reviewed against this PRD section.

---

## 10. Decisions, Accepted Risks & Open Items

**Confirmed decisions**
1. Interest is charged once per monthly cycle from the disbursement date, at 7.5% per month on the reducing principal (F6).
2. A late installment paid within the next cycle adds no interest. Underpayment not made up by then raises the next interest through the higher principal. Overpayment reduces principal and lowers interest from the next cycle.
3. Every loan pays at least cycle 1 interest, even if repaid on the disbursement day. Early payoff = outstanding principal + interest arrears + current cycle interest.
4. Interest continues monthly past the tenure until the loan is cleared, with the same grace window.
5. Due dates anchor to the disbursement day of the month, clamped to month end. Payment timing is by payment date, so a late-uploaded schedule still covers its month.
6. Every posting, reversal, correction or reclassification triggers a full recompute; differences are posted as reversing and replacement events.
7. Rows on CLOSED loans or for members with no ACTIVE loan go to Overpayment Credit. Overpayment Credits are only refunded.
8. Any excess reduces principal; `period_covered` is reference only. A member may ask, before the next REGULAR schedule for their source posts, for a prepayment to be refunded instead (F12).
9. There is no cash-in-transit. Money is either BANK_VERIFIED or Recorded, not yet paid.
10. Legacy loans: interest-rate column included; one opening balance per loan; new loan numbers issued to all loans.
11. Lodgements are declared and recorded on the remittance sheet.
12. Direct member payments are added as rows on the monthly remittance schedule, each bound to a bank credit the Finance Manager has tagged to that member.
13. The Treasurer cannot move money between members within a schedule total (Source Advice match, F9).
14. The GMD and the General Manager are the same person. The GMD closes exceptions and is otherwise read-only for financial data.
15. Admin, GMD and Secretary can send member invitation links. The Secretary is a separate, non-financial role.
16. The database starts on Neon's Free plan; evidence files are stored in Cloudflare R2.
17. Borrowing limits: at most 2 open loans per member and 2 open guarantees per guarantor, with no override.
18. Personal data of declined applicants and expired invitations is kept, with access logging, until MOAUM sets a retention period.
19. Reminders: 5 days before the due date for members who pay directly; 3 days after the due date for arrears, repeated each cycle while arrears remain.

**Accepted risks (to be accepted by MOAUM in writing at sign-off)**
1. **One person per role is maintained.** When a role holder is absent, that role's actions (for example Finance Manager verifications, or GMD exception closing) pause until they return. There is no deputy.
2. **The Admin (developer/IT support) uploads legacy loan and bank opening balance files.** The Finance Manager reviews and commits them, and uploader and committer must be different users.
3. **The GMD is the sole person who can close exceptions.**

**Working assumptions (correct if wrong)**
1. The two remittance sources are two payroll offices, and the **Treasurer uploads schedules for both**.
2. **Each remittance source can supply a per-member advice every month**, sent directly to the Finance Manager. The Treasurer control (AT-l) depends on this.
3. The guarantor may be a member or a non-member.
4. Registration is by invitation; the open public link stays off unless MOAUM asks for it.

**Accepted risk added in v1.5**
4. **Neon Free plan:** recovery point is up to 24 hours (nightly backup), and the app goes offline if the monthly compute allowance runs out. The guardrails and upgrade triggers in Section 5 manage this.

**Still to supply**
| Item | Needed before |
|---|---|
| Secretary's name, email and phone for the staff account | Milestone 1a |
| Go-live date | Milestone 1b (legacy import) |
| A sample remittance schedule and a sample Source Advice from each source (anonymized) | Milestone 1b (templates) |
| A sample legacy loan file (anonymized) | Milestone 1b |
| Bank names, number of MOAUM bank accounts, and a sample statement export per bank | Milestone 1c (column mappings) |
| Opening bank balance per account at the go-live date, with statements | Milestone 1c |
| Branding: logo, colours, domain | Milestone 1d |
