"""
Writes docs/testing-guide.html, the staging test guide (one card per actor, the
permission table, uploads and scenarios), from the app's own permission table
and docs/demo-files/logins-public.json. Edit the actors, uploads and scenarios
below when the app changes, then run from the project folder:
    python scripts/demo/make-testing-guide.py
The staff menu (MENU) mirrors src/app/(staff)/staff/layout.tsx: keep the two in step.
"""
import html, json, os, subprocess
P = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_out = subprocess.run("npx --yes tsx@4.23.15 scripts/demo/export-permissions.mts", cwd=P, shell=True, capture_output=True, text=True, encoding="utf-8", check=True).stdout
perms = json.loads(_out[_out.index("["):])
logins = json.load(open(os.path.join(P, "docs", "demo-files", "logins-public.json"), encoding="utf-8"))
e = html.escape
ROLES = ["MEMBER", "SECRETARY", "LOAN_OFFICER", "CASHIER", "TREASURER", "FINANCE_MANAGER", "MANAGEMENT", "AUDITOR", "ADMIN", "GMD"]
SHORT = {"MEMBER": "Member", "SECRETARY": "Sec", "LOAN_OFFICER": "LO", "CASHIER": "Cash", "TREASURER": "Treas", "FINANCE_MANAGER": "FM", "MANAGEMENT": "Mgmt", "AUDITOR": "Aud", "ADMIN": "Admin", "GMD": "GMD"}
has = {p["action"]: set(p["roles"]) for p in perms}
def can(role, action): return role in has.get(action, set())
def any_(role, *actions): return any(can(role, a) for a in actions)

# The staff menu, with the same visibility rules as src/app/(staff)/staff/layout.tsx.
MENU = [
    ("Home", lambda r: True),
    ("Dashboard", lambda r: can(r, "dashboard.gmd.read")),
    # Members
    ("Members", lambda r: any_(r, "member.directory.read", "member.kyc.read")),
    ("Invitations", lambda r: can(r, "invitation.send") and not any_(r, "member.directory.read", "member.kyc.read")),
    ("Profile changes", lambda r: can(r, "member.profileChange.approve")),
    ("Announcements", lambda r: can(r, "announcement.send")),
    # Loans
    ("Loans", lambda r: can(r, "credit.read")),
    ("Refunds", lambda r: can(r, "credit.read")),
    ("Legacy loans", lambda r: any_(r, "legacyImport.upload", "legacyImport.commit")),
    # Money
    ("Remittance", lambda r: any_(r, "credit.read", "sourceAdvice.upload", "schedule.upload")),
    ("Bank", lambda r: any_(r, "credit.read", "bankOpening.upload")),
    ("Reconciliation", lambda r: can(r, "credit.read")),
    ("Exceptions", lambda r: any_(r, "credit.read", "exception.close")),
    # Records
    ("Reports", lambda r: any_(r, "reports.read", "ledger.export", "invitation.read", "audit.read")),
    ("Evidence", lambda r: can(r, "evidence.read")),
    ("Audit trail", lambda r: can(r, "audit.read")),
    # Administration
    ("Users & roles", lambda r: can(r, "users.manage")),
    ("Import members", lambda r: can(r, "member.import.upload")),
    ("Bank accounts", lambda r: can(r, "bankAccounts.manage")),
    ("Remittance sources", lambda r: can(r, "sources.manage")),
    ("Settings", lambda r: can(r, "settings.read")),
    ("Modules", lambda r: can(r, "modules.manage")),
    ("Jobs", lambda r: can(r, "jobs.run")),
    ("Staging outbox", lambda r: can(r, "users.manage")),
    ("My account", lambda r: True),
]

def login_for(actor):
    for l in logins:
        if l["actor"].startswith(actor):
            return l
    return None

ACTORS = [
    # (key, title, login actor prefix, one line, does, cannot)
    ("applicant", "Applicant", "Applicant (invited", "Someone invited to join. Has no login until they register.",
     ["Opens the invitation link (find it in Staging outbox as Admin)", "Confirms their phone with a 6-digit code (also in the outbox)", "Enters their details, accepts the data protection notice, uploads an ID card scan, sets a password", "Gets an SMS with their MOAUM number (MOAUM/0001 onwards) once registered"],
     ["Sign in before registering", "Use a link meant for someone else, or one that has expired (7 days)", "On staging the demo invitation (Peter Agbo) expired on 15 November: the Secretary resends it from Invitations for a fresh 7-day link, or invite someone new (scenario 1)"]),
    ("pending", "Registered, waiting", "Registered, waiting", "Has registered; a Loan Officer must check the ID and activate them.",
     ["Signs in and sees that the membership is being reviewed, with their MOAUM number already shown"], ["Apply for a loan or see member pages until activated", "On staging the demo login (Fatima Danjuma) has since been activated, so it opens as an active member: to see this state, register someone new (scenario 1) and stop before the Loan Officer activates them"]),
    ("member", "Member", "Member with no loan", "An active member. Sees only their own records.",
     ["Applies for a loan online with their own bank account (the number is checked against the bank as it is typed); the guarantor accepts by an SMS link, and one who is not a member also signs the paper form", "Sees whether the guarantor has accepted, declined or not answered yet", "Sees their MOAUM number and PIN on Home, and every loan they have taken under Loan history", "Requests profile changes (a new phone is confirmed by code)", "Downloads a copy of their personal data", "Sees their Overpayment Credit and asks for it to be refunded (the account number is checked against the bank as it is typed)"],
     ["See anyone else's record", "Open any staff page", "Have more than 2 active (paid-out) loans at a time"]),
    ("borrower", "Borrower", "Borrower with an active loan", "A member repaying a loan through payroll.",
     ["Sees each active loan's next instalment on Home, worked out from what was actually repaid", "Sees the actual repayment schedule (paid, left, overdue) beside the plan fixed at payout, and every repayment with its interest/principal split", "Downloads the statement, a payoff quote and a receipt per repayment", "Checks a receipt with its QR code"],
     ["Change any figure: repayments come only from posted payroll schedules"]),
    ("SECRETARY", "Secretary", "Secretary", "Front desk: brings people in.",
     ["Sends invitations, one at a time or from a list", "Sees the member directory (no KYC details)", "Sends announcements"], ["See ID scans or addresses (KYC)", "Touch loans or money"]),
    ("LOAN_OFFICER", "Loan Officer", "Loan Officer", "Checks members and loan applications.",
     ["Activates or declines registrations, records payroll staff numbers", "Approves profile changes", "Captures paper applications, verifies, recommends or declines loans", "Prints the guarantor form for a guarantor who is not a member, and sends or resends the guarantor's SMS request", "Sees each member's loan history (Members → the member)", "Captures a member's signed refund request (account number checked against the bank as it is typed)"],
     ["Approve a loan (Management does)", "Verify a loan whose guarantor hasn't accepted by SMS", "Act on their own loan or membership"]),
    ("CASHIER", "Cashier", "Cashier", "Records money that the bank has confirmed.",
     ["Prepares disbursement and refund vouchers with the transfer evidence", "Records and applies lodgements the Finance Manager has verified", "Records bank charges, interest and transfers from statement lines"],
     ["Verify anything they prepared", "Pay a loan into an account other than the one on the application without writing why (the Finance Manager sees both)", "Pay out a loan whose guarantor hasn't accepted, or that would give the member a third active loan", "Record a lodgement the bank hasn't confirmed (refused, and logged)", "Create a lodgement or receipt from nothing"]),
    ("TREASURER", "Treasurer", "Treasurer", "Runs the monthly payroll schedules.",
     ["Uploads the payroll schedule (the voucher as it arrives, or the template), checks the dry run, posts it alone; the system numbers it SCH/REF/0001 onwards", "Produces the monthly deduction schedule for the bursary (Excel in the bursary's layout)", "Prepares corrections to schedules they posted", "Moves a prepayment to Overpayment Credit when a member asks for it back"],
     ["Upload the Source Advice (the Finance Manager does; it is optional)", "Verify their own corrections"]),
    ("FINANCE_MANAGER", "Finance Manager", "Finance Manager", "The second pair of eyes on money, and the bank.",
     ["Uploads the Source Advice obtained from the payroll office (optional: a schedule that names it must then match it member by member)", "Produces the deduction schedule for the bursary", "Verifies disbursement and refund vouchers, corrections, reclassifications and bank line entries", "Imports bank statements, verifies lodgements, tags direct payments, matches debits", "Commits bank opening balances", "Runs the monthly reconciliation, reviews exceptions, closes the month"],
     ["Verify anything they prepared themselves", "Approve loans"]),
    ("MANAGEMENT", "Management", "Management", "Decides loans and approves money settings.",
     ["Approves (possibly a smaller amount) or rejects recommended loans; cancels approved ones", "Approves or rejects refunds of Overpayment Credit", "Approves financial setting changes Admin proposes, such as the interest rate", "Reads loans, reports and member KYC"],
     ["Prepare or verify vouchers", "Verify loans (the Loan Officer does)"]),
    ("AUDITOR", "Auditor", "Auditor", "Reads everything, changes nothing.",
     ["Searches and exports the audit trail", "Exports the full ledger with evidence references", "Sees the dashboard, reports, members and evidence"], ["Change anything at all"]),
    ("ADMIN", "Admin", "Admin", "Sets the system up; handles no money or members' records.",
     ["Creates staff and assigns roles", "Sets up payroll sources and bank accounts, uploads bank opening balances", "Imports existing members from a list", "Proposes setting changes; sets module status; runs jobs", "Staging only: reads the outbox"],
     ["Commit an opening balance they uploaded", "Approve financial settings", "Hold any other role"]),
    ("GMD", "GMD", "GMD", "Oversight across the whole portal.",
     ["Reads the consolidated dashboard and drills into any figure", "Sends invitations and announcements", "Closes exceptions the Finance Manager has reviewed, with evidence and a reason"],
     ["Change any financial record", "Hold any other role"]),
]

def actor_card(a):
    key, title, prefix, line, does, cannot = a
    l = login_for(prefix)
    if key in ROLES:
        menu = [m for m, f in MENU if f(key)]
        menu_html = "".join(f"<li>{e(m)}</li>" for m in menu) or "<li>Home, My account</li>"
        seen = f'<div class="sees"><span class="label">Staff menu</span><ul class="chips">{menu_html}</ul></div>'
        role = f'<span class="role">{e(key)}</span>'
    else:
        seen = '<div class="sees"><span class="label">Member menu</span><ul class="chips"><li>Home</li><li>Loans</li><li>Loan history</li><li>My details</li></ul></div>' if key in ("member", "borrower") else ""
        role = '<span class="role">MEMBER</span>' if key in ("member", "borrower") else '<span class="role muted">no role yet</span>'
    login = f'<div class="login"><span class="label">Demo login</span><code>{e(l["signIn"])}</code> <span class="tab">{e(l["tab"])} tab</span></div>' if l else ""
    dos = "".join(f"<li>{e(x)}</li>" for x in does)
    cants = "".join(f"<li>{e(x)}</li>" for x in cannot)
    return f'''<article class="actor" id="actor-{e(key.lower())}">
  <header><h3>{e(title)}</h3>{role}</header>
  <p class="line">{e(line)}</p>
  {login}
  <div class="cols"><div><span class="label">Does</span><ul>{dos}</ul></div><div><span class="label">Cannot</span><ul class="no">{cants}</ul></div></div>
  {seen}
</article>'''

GROUPS = [
    ("Portal and setup", ["users.manage", "sources.manage", "bankAccounts.manage", "modules.manage", "jobs.run", "settings.read", "settings.change", "settings.financial.propose", "settings.financial.approve", "audit.read", "announcement.send", "dashboard.gmd.read", "evidence.upload", "evidence.read"]),
    ("Members", ["invitation.send", "invitation.read", "member.directory.read", "member.kyc.read", "member.import.upload", "member.activate", "member.profileChange.approve", "self.loan.apply", "self.profileChange.request", "self.refund.request", "self.read"]),
    ("Loans", ["guarantorForm.print", "loan.application.captureAssisted", "loan.verify", "loan.recommend", "loan.decline", "loan.approve", "loan.reject", "loan.cancelApproved", "voucher.disbursement.prepare", "voucher.disbursement.verify", "payoffQuote.issue"]),
    ("Payroll schedules (Track A)", ["deductionSchedule.read", "sourceAdvice.upload", "schedule.upload", "schedule.commit", "correction.prepare", "correction.verify", "reclassification.prepare", "reclassification.verify"]),
    ("Bank (Track B)", ["bankOpening.upload", "bankOpening.commit", "bankStatement.upload", "bankCredit.tagMember", "lodgement.verify", "bankDebit.match", "lodgement.record", "bankLineEntry.record", "bankLineEntry.verify"]),
    ("Reconciliation and refunds", ["reconciliation.run", "exception.review", "exception.close", "month.close", "refund.captureRequest", "refund.approve", "voucher.refund.prepare", "voucher.refund.verify"]),
    ("Reading and reports", ["credit.read", "reports.read", "ledger.export", "legacyImport.upload", "legacyImport.commit"]),
]
listed = {a for _, acts in GROUPS for a in acts}
missing = [p["action"] for p in perms if p["action"] not in listed]
if missing:
    GROUPS.append(("Other", missing))

def matrix():
    head = "".join(f'<th scope="col" title="{e(r)}">{e(SHORT[r])}</th>' for r in ROLES)
    body = []
    for name, acts in GROUPS:
        body.append(f'<tr class="group"><th scope="rowgroup" colspan="{len(ROLES) + 1}">{e(name)}</th></tr>')
        for a in acts:
            cells = "".join(f'<td>{"<span class=yes aria-label=yes>●</span>" if can(r, a) else "<span class=no-cell aria-label=no>·</span>"}</td>' for r in ROLES)
            body.append(f'<tr><th scope="row"><code>{e(a)}</code></th>{cells}</tr>')
    return f'<div class="scroll"><table class="matrix"><thead><tr><th scope="col">Action</th>{head}</tr></thead><tbody>{"".join(body)}</tbody></table></div>'

UPLOADS = [
    ("Applicant / member", "ID card scan (registration, or a name change)", "JPG, PNG or PDF", "10 MB", "7-sample-id-card.jpg"),
    ("Member", "Signed guarantor form, only for a guarantor who is not a member (online loan application; the Loan Officer prints the blank form). A member guarantor accepts by SMS instead", "PDF, JPG or PNG", "10 MB", "6-sample-document.pdf"),
    ("Loan Officer", "Signed application form + guarantor form (paper application)", "PDF, JPG or PNG", "10 MB", "6-sample-document.pdf"),
    ("Cashier", "Transfer evidence for a disbursement voucher", "PDF, JPG or PNG", "10 MB", "6-sample-document.pdf"),
    ("Secretary", "Invitation list", "XLSX or CSV (UTF-8); template in the app", "2 MB, 2,000 rows", "5-invitations.csv"),
    ("Admin", "Member import list (includes payroll_staff_no; no ID card number: the system issues the MOAUM number)", "XLSX or CSV; template in the app", "2 MB, 2,000 rows", "4-member-import.csv"),
    ("Finance Manager", "Source Advice (optional): the payroll voucher as it arrives, or the advice template; plus the source's original document", "XLSX or CSV + PDF/image", "2 MB file, 10 MB document", "1-november-2026-salary-voucher.xlsx + 6-sample-document.pdf"),
    ("Treasurer", "Remittance schedule: the payroll voucher as it arrives (payment date on the form), or the template with Rows and Lodgements sheets; members by pin (payroll PIN); a line with no loan number for a member with several active loans is shared out oldest loan first", "XLSX (CSV = rows only)", "2 MB", "2-november-2026-schedule-with-lodgement.xlsx"),
    ("Treasurer", "Correction: replacement rows (optional) + the document explaining it", "XLSX/CSV + PDF/image", "2 MB / 10 MB", "6-sample-document.pdf"),
    ("Finance Manager", "Bank statement (the template, or the bank's export via a saved column mapping)", "XLSX or CSV", "2 MB", "3-bank-statement-2026-11-01-to-07.csv"),
    ("Finance Manager", "Member's transfer receipt when tagging a direct payment (optional)", "PDF, JPG or PNG", "10 MB", "6-sample-document.pdf"),
    ("Cashier", "Transfer evidence for a refund voucher", "PDF, JPG or PNG", "10 MB", "6-sample-document.pdf"),
    ("Loan Officer / Treasurer", "Member's signed refund request, or request to refund a prepayment", "PDF, JPG or PNG", "10 MB", "6-sample-document.pdf"),
    ("Admin", "Bank statement showing the go-live opening balance", "PDF, image or spreadsheet", "10 MB", "6-sample-document.pdf"),
    ("Admin", "Legacy loans: MOAUM's list as kept (SN, Name, PIN, Department, Tenure, Principal, Phone; optional rate_monthly_percent, legacy_account_no), with the payroll source chosen on the form; a PIN not yet a member is created from the row and needs its phone", "XLSX or CSV; template in the app", "2 MB", "8-legacy-loans.csv"),
]

def uploads():
    rows = "".join(f"<tr><td>{e(a)}</td><td>{e(b)}</td><td>{e(c)}</td><td>{e(d)}</td><td><code>{e(f)}</code></td></tr>" for a, b, c, d, f in UPLOADS)
    return f'<div class="scroll"><table class="plain"><thead><tr><th>Who</th><th>What</th><th>Format</th><th>Limit</th><th>Demo file</th></tr></thead><tbody>{rows}</tbody></table></div>'

# Scenarios: (title, actors, steps, expect, break-it)
SCEN = [
    ("From invitation to member", "Secretary → Applicant → Admin (outbox) → Loan Officer → Member",
     ["Secretary: Invitations → invite a new person (any 080… number) with source DEMO-PAYROLL.",
      "Admin: Staging outbox → copy the invitation link; open it in a private window.",
      "Applicant: fill the form (a wrong next-of-kin phone or a common password is refused before any code is sent), upload 7-sample-id-card.jpg, set a password, then enter the code from the outbox.",
      "Loan Officer: Members → record the payroll staff number (e.g. S05001) → Activate.",
      "Member: sign in on the Member tab."],
     "The member is ACTIVE with the next MOAUM number (MOAUM/00…); the “registration received” and welcome SMS both give it, and Home shows it with the PIN.",
     ["Loan Officer: try Activate before recording the staff number (refused).", "Applicant: open the same link again after registering (refused).", "Secretary: invite the same phone twice (refused)."]),
    ("Bring existing members in", "Admin, Secretary",
     ["Admin: Import members → 4-member-import.csv → check the dry run → Import.", "Admin: Staging outbox → each new member has a set-up link.", "Secretary: Invitations → upload 5-invitations.csv."],
     "Two ACTIVE members with the next MOAUM numbers and their staff numbers; two invitations sent.",
     ["Admin: import the same file again (every row refused: already a member).", "Admin: delete payroll_staff_no from a DEMO-PAYROLL row (refused)."]),
    ("A loan from application to payout", "Member → guarantor (outbox) → Loan Officer → Management → Cashier → Finance Manager",
     ["Member (Ngozi Eze, MOAUM/0005): Loans → Apply. Guarantor: a MOAUM member, PIN S03020 (Amina Bello). Your bank account: a bank and a 10-digit number; the line under the number says whether it fits that bank. Submit.",
      "Admin: Staging outbox → the SMS to Amina → open its link in a private window → I accept. Ngozi's loan page now reads “Guarantor's answer: Accepted on …”.",
      "Loan Officer: Loans → open it → Verify → Recommend. The panel shows “Active loans: 0 of 2 allowed”.",
      "Management: Approve (try a smaller amount than asked).",
      "Cashier: prepare the disbursement voucher; the beneficiary is filled in from Ngozi's application.",
      "Finance Manager: verify the voucher."],
     "The loan is ACTIVE with a binding schedule; Ngozi's Home shows a Next instalment card and Loan history 1 ongoing; a CASH_OUT appears on the dashboard drill-down.",
     ["Loan Officer: verify before Amina accepts (refused: not accepted by SMS yet).", "Guarantor: open the link again after answering (it can't be answered twice).", "Cashier: verify your own voucher (refused: someone else must verify).", "Cashier: pay an account other than the one on the application without a reason (refused); with a reason, the Finance Manager's Verify card shows both accounts and the reason in red.", "Management: approve more than requested (refused).", "With 2 active loans already: submitting, approving or paying out a third is refused."]),
    ("Loans already waiting at each desk", "Loan Officer, guarantor (outbox), Management, Cashier",
     ["The demo loans CSS-2026-00005 (Terver, verified), 00006 (Halima, recommended), 00007 (Emeka, approved) and 00008 (kennedy Keng Abya, submitted) were made before every guarantor had to accept by SMS: their Guarantor card shows “Not asked”.",
      "Loan Officer: open each → Guarantor → Send the request. Admin: Staging outbox → open each SMS link → I accept.",
      "Loan Officer: verify kennedy's application and recommend Terver's. Management: approve Halima's. Cashier: prepare the voucher for Emeka's."],
     "Each loan moves one step once its guarantor has accepted; its history lists who did what and when.",
     ["Management: approve Halima's loan before her guarantor accepts (refused).", "Cashier: prepare Emeka's voucher before his guarantor accepts (refused: “Don't pay out yet”).", "Loan Officer: try to approve (no button; the API refuses)."]),
    ("November bank statement in", "Finance Manager",
     ["Bank → First Bank (demo) → Import a statement → 3-bank-statement-2026-11-01-to-07.csv, with the period and balances given in docs/demo-files/README.md.",
      "Bank → Matching → the NIP-90112 credit (₦15,000 from Ngozi) → A member paid this directly → MOAUM/0005 (or PIN S03048) → Tag. Note its DP-… reference."],
     "Three new lines; the tagged payment waits under Direct payments not yet on a schedule.",
     ["Import with the wrong opening balance (refused: it doesn't continue the last statement).", "Import the same file again (refused: that period is already covered). A later statement that overlaps it imports, skipping the lines already in."]),
    ("Monthly payroll, the voucher as it arrives", "Finance Manager (optional) → Treasurer → Borrower",
     ["Finance Manager (optional): Remittance → Upload a Source Advice → DEMO-PAYROLL, month 2026-11, reference of your choice, control total 218,750, 5 members → 1-november-2026-salary-voucher.xlsx and 6-sample-document.pdf.",
      "Treasurer: open 2-november-2026-schedule-with-lodgement.xlsx and add one Rows line: DIRECT, pin S03048, Ngozi Eze, (blank), 15000, 2026-11-03, and the DP-… reference in bank_credit_ref. (Staging also holds an older unused tag for Ngozi, DP-EBB12FFEFD for NIP-77231 on 15 October; a DIRECT row must match its own tag's amount.)",
      "Treasurer: Remittance → upload it: month 2026-11, SUPPLEMENTARY (November's REGULAR schedule is already posted on staging), Source Advice the one above or None, control total 233,750, 6 rows. The reference box shows the next SCH/REF/… number. Read the dry run → Post.",
      "Borrower (Amina): Home → the next instalment has moved; Loans → the new repayment → download its receipt → open the QR link."],
     "Repayments split into interest and principal; Ngozi's rows go to Overpayment Credit (no loan); the DIRECT row's bank credit becomes a verified lodgement; the schedule is numbered SCH/REF/…; each member gets an SMS; the receipt check says genuine.",
     ["Treasurer: upload x-schedule-moves-2500-between-members.xlsx naming the advice above (refused: per-member totals don't match). With Source Advice None it posts: the advice is optional.", "Either: x-voucher-wrong-month.xlsx for 2026-11 (refused: wrong month).", "Either: x-voucher-unknown-staff-number.xlsx (refused: staff number not linked).", "Treasurer: use the DP- reference with another member or amount (refused).", "Treasurer: post a second REGULAR schedule for November (refused)."]),
    ("A payroll line shared across two loans", "Treasurer",
     ["Pick a member with two active loans (on staging, Newton Abya had two until 15 November; see SCH/REF/0002).",
      "Upload a payroll voucher line for them with no loan number → dry run."],
     "The line is not refused: Goes to shares it out oldest loan first, each loan up to its current instalment (never more than clears it), and anything beyond every instalment to Overpayment Credit. The schedule keeps one row; the receipt and SMS list each loan's part.",
     ["Give the loan number in the template's loan_account_no: the whole amount goes to that loan.", "A correction reversing the row undoes every loan's part and the credit."]),
    ("Deduction schedule for the bursary", "Treasurer or Finance Manager",
     ["Remittance → Deduction schedule for the bursary → DEMO-PAYROLL → Show schedule (the first month is the one after the last posted remittance).",
      "Download Excel for the bursary (this month only, or every remaining month)."],
     "One sheet with SN, NAME, PNO, AMOUNT, STARTDATE, ENDDATE and nothing else; one row per member per month (amounts fall every month on a reducing balance), one combined amount for a member with two loans, worked out from what was actually repaid. New and final deductions and members to stop deducting from are shown on the screen.",
     ["Type a month that has already been remitted (refused).", "Cashier or Loan Officer: look for the page (not there)."]),
    ("Correcting a posted schedule", "Treasurer → Finance Manager",
     ["Treasurer: open the November schedule you posted → Prepare a correction → tick a row, upload replacement rows if needed, give a reason and attach 6-sample-document.pdf.",
      "Finance Manager: open the same schedule → review the checks → Verify and post, or Return with a comment."],
     "Reversed rows are struck through and replacement rows added; every loan involved is recomputed.",
     ["Treasurer: correct a schedule someone else posted, such as September's (refused).", "Finance Manager: verify when per-member totals no longer match a named advice (refused until a replacement advice is uploaded).", "Treasurer: prepare a second correction while one waits (refused)."]),
    ("Legacy loans from MOAUM's records", "Admin → Finance Manager",
     ["Admin: Legacy loans → payroll source DEMO-PAYROLL, go-live date 2026-10-01 (the approved setting), total still owed 236,666.67, 3 loans → 8-legacy-loans.csv → Check.",
      "Read the dry run: each PIN matched to a member on that payroll, amounts rounded to the kobo, the first instalment, warnings.",
      "Fix the file as the dry run says, then the Finance Manager opens it and brings the loans in."],
     "Each loan gets a new CSS number with its old number beside it, starts on the go-live date and has one opening balance; no interest before go-live counts as revenue; the member's Loan history marks it “brought in at go-live”.",
     ["The third row's PIN belongs to nobody and gives no phone (refused: a new member is created from the row only with their phone).", "Type a wrong total still owed (refused).", "Admin: commit your own upload (refused)."]),
    ("Refunding Overpayment Credit", "Member → Management → Cashier → Finance Manager",
     ["Member (Ngozi): Overpayment Credit → ask for a refund: bank and 10-digit account number. The line under the number says whether it fits that bank (e.g. First Bank 3012345671 ✓; 3012345678 ✗).",
      "Management: Refunds → approve (or reject with a reason the member sees).",
      "Cashier: Refunds → prepare the refund voucher: account paid from, value date, transfer reference, 6-sample-document.pdf.",
      "Finance Manager: Refunds → verify and post (or return to the Cashier)."],
     "The refund is PAID; CASH_OUT and DEPOSIT_REFUNDED post; Ngozi's credit history shows the refund and the new balance, also on her loan statement PDF.",
     ["Member: ask for more than the credit (refused).", "Member: ask twice while one request is open (refused).", "Loan Officer: capture a refund to an account holder who isn't the member: Management, the Cashier and the Finance Manager all see a red notice (it warns; the signed request decides).", "Member or Loan Officer: type an account number with a wrong digit (the line turns red and names the listed bank it would fit, if any); choose Opay or another fintech (“can't be checked here”). It warns, never blocks: the account name still has to match the signed request.", "Cashier: verify your own voucher (refused)."]),
    ("Refunding a prepayment instead of reducing the loan", "Treasurer → Finance Manager",
     ["Treasurer: Refunds → enter a loan number that has a repayment above the instalment → choose the repayment, the amount to move, the reason, 6-sample-document.pdf as the member's request.",
      "Finance Manager: verify it."],
     "The loan's actual schedule goes back to what it would have been without the extra; the amount becomes Overpayment Credit, ready to refund.",
     ["Move more than went to principal (refused).", "Try it after the next regular schedule for the source has posted (refused: too late).", "Try it on a payroll line shared across several loans (refused)."]),
    ("Monthly reconciliation and exceptions", "Finance Manager → GMD",
     ["Finance Manager: make sure the bank statements reach the month's end plus 3 days (the November file in docs/demo-files does for October).",
      "Finance Manager: Reconciliation → choose the month → Run reconciliation. Read bank against ledger per account and the repayments against the bank.",
      "Finance Manager: Exceptions → add a review note (and evidence) to the shortfall raised against DEMO-PAYROLL.",
      "GMD: Exceptions → close it with a reason and the confirming document."],
     "Every difference is listed; whatever isn't explained raises an exception; loan balances never change. The exception closes only after review, by the GMD, with evidence.",
     ["Run a month whose statements don't reach month end + 3 days (refused, with what's missing).", "GMD: close an exception nobody has reviewed (refused).", "GMD: close without evidence or a reason (refused).", "Finance Manager: try to close an exception (no button; the API refuses)."]),
    ("Closing the month", "Finance Manager",
     ["Reconciliation → the earliest open month → run it → Close the month.", "Open the saved report PDFs listed under Closed months.", "Post something dated inside the closed month (for example a correction), then Reports → Prior-period adjustments."],
     "The closed month's saved reports stay as they were; the late posting shows as a prior-period adjustment.",
     ["Close a later month before an earlier one (refused: months close in order).", "Close the current month (refused: it hasn't ended).", "Reopen a closed month (not possible)."]),
    ("Member self-service", "Member → Loan Officer",
     ["Member: Home (MOAUM number, PIN, a Next instalment card per active loan), Loans (each loan's actual repayment schedule and guarantor's answer) and Loan history (every loan taken, oldest first, completed or ongoing).", "Member: My details → request a new phone (code in the outbox) or a name change (needs a document).", "Loan Officer: Profile changes → approve; Members → the member → the same loan history.", "Member: download a copy of your data (PDF)."],
     "The record changes only after approval; every step is in the audit trail.", ["Member: open another member's loan by changing the address bar (refused)."]),
    ("Oversight", "GMD, Auditor",
     ["GMD: Dashboard → select any figure to see its transactions and evidence.", "Auditor: Reports → Period: This month, Last month or This year (Apply shows “Applying…”, then “Showing …”) → any report; Audit trail → filter by a demo user; Reports → Ledger export (Excel)."],
     "Totals tie to the ledger; Overpayment Credits and principal are never counted as revenue.", ["GMD: look for any button that changes money (there is none; the API refuses)."]),
    ("Settings and opening balances", "Admin → Management → Finance Manager",
     ["Admin: Settings → propose a new monthly interest rate (or Active loans per member) with a future date and a reason.", "Management: approve it.", "Admin: Bank accounts → add an account → Bank → upload its opening balance.", "Finance Manager: commit the opening balance."],
     "The new rate applies from its date (existing loans keep their rate); OPENING_BALANCE posts.",
     ["Admin: approve your own proposal (not possible).", "Admin: commit the opening balance you uploaded (refused)."]),
    ("Paying more or less than the instalment", "Treasurer → Borrower → Loan Officer",
     ["Treasurer: post a SUPPLEMENTARY payroll schedule for DEMO-PAYROLL (2026-11, Source Advice None) with two lines: one borrower paying well above their next instalment (e.g. Amina, S03020), another paying less than theirs (e.g. Tunde, S03027).",
      "Borrower (Amina): Home → the Next instalment card; Loans → her loan → Actual repayment schedule.",
      "Loan Officer: Loans → Tunde's loan → Actual repayment schedule; Reports → Arrears listing."],
     "Amina's extra went to principal: her later instalments are smaller (the payout plan's amounts are struck through beside them) and the schedule says how much was paid ahead. Tunde's unpaid part stays due: his next payment includes it, marked overdue once its date passes, and he appears on the arrears listing. The deduction schedule for the next month follows both.",
     ["Look for the old fixed amount on Home: it shows only the live figure.", "Refund Amina's prepayment instead (scenario 12): her schedule goes back to the plan."]),
    ("The two-active-loan limit", "Member → guarantor (outbox) → Loan Officer → Management → Cashier",
     ["Member with one active loan (e.g. Amina): apply twice more; both are submitted (applications in review don't count).",
      "Guarantor: accept both by the SMS links in the outbox. Loan Officer: verify and recommend both. The panel reads “Active loans: 1 of 2 allowed”.",
      "Management: approve the first; approve the second.",
      "Management: cancel the approved loan and reject the other, so nothing is paid out."],
     "The second approval is refused: “The member already has 1 active loan and 1 approved loan waiting to be paid; the limit is 2 active loans.” The setting is Active loans per member (default 2); guarantors are limited the same way.",
     ["With 2 active loans: submit a new application (refused: a loan must be fully repaid first).", "Cashier: prepare a payout that would make a third active loan (refused).", "A guarantor already standing for 2 active loans: name them again (refused: choose another guarantor)."]),
    ("Payout and refund warnings", "Cashier → Finance Manager; Member → Management",
     ["Payout: take the loan from scenario 3 (Ngozi's, applied with her bank account) once it is approved. Cashier: on the disbursement voucher change the account number to another bank's account. A red box appears: this is not the account on the application; enter a “Reason for paying a different account” (at least 10 characters) and send.",
      "Finance Manager: open the loan → Verify the disbursement voucher. Read the red notice, then Return the voucher (“Pay the account on the application”) instead of verifying.",
      "Refund: Member (Ngozi): Credit → ask for ₦1,000 into an account holder who isn't her (e.g. Kendy Abya), Zenith Bank 1234567890. Read the line under the number, then send.",
      "Management: Refunds → read the notices under the request → Reject (reason: “Test only: not Ngozi's account”)."],
     "The Verify card shows the application's account, the voucher's account and the Cashier's reason in red, plus notices if the name differs from the member's or the number fails the bank check. The refund shows two red notices (account holder isn't the member; not a valid Zenith number, it would fit Ecobank or FCMB) to Management, and would to the Cashier and Finance Manager too. Nothing is paid; Ngozi keeps her credit.",
     ["Cashier: send the changed account without a reason, or with a reason under 10 characters (refused).", "Cashier: type the same account as “First Bank of Nigeria” or with spaces in the number (not a change: no box).", "The demo loans of scenario 4 were applied for before bank details were asked, so their vouchers have no application account to compare: the warning applies to loans applied for since 14 November."]),
    ("Announcements", "GMD or Secretary",
     ["Announcements → write a message, choose who receives it and how → Preview (counts and SMS units) → Send.", "Admin: Staging outbox → the messages."],
     "Only active members receive it; each delivery is listed against the announcement.",
     ["Change the text after Preview and press Send (refused: preview again).", "Loan Officer: look for Announcements (not in the menu)."]),
    ("Checking the SMS account (Termii)", "You, on your own computer (not a portal role)",
     ["Create .env.termii.local in the dommus-negotii folder (git-ignored; type the key in yourself, never into a chat or a document): TERMII_API_KEY, TERMII_SENDER_ID (e.g. MOAUM), TERMII_BASE_URL (as your Termii dashboard shows it), TERMII_ROUTE=dnd.",
      "Run: npx --yes tsx@4.23.15 scripts/termii-check.mts (free; sends nothing).",
      "Once the sender ID is approved: npx --yes tsx@4.23.15 scripts/termii-check.mts --send 0803XXXXXXX, first to your own phone, then to a phone on DND."],
     "“✓ The key works. Wallet balance: NGN …”, “✓ Sender ID … is approved”, and after --send “✓ Termii accepted the SMS”, with the message arriving from your sender ID, on the DND phone too. The key is never printed. Staging itself still sends nothing: every message stays in the Staging outbox.",
     ["Put a wrong key in the file (“✗ The key was not accepted”, and nothing else runs).", "Use a sender ID Termii hasn't approved yet (it says so: wait before sending).", "--send with a number that isn't Nigerian (refused before anything is sent)."]),
]

def scenarios():
    out = []
    for i, (t, who, steps, expect, brk) in enumerate(SCEN, 1):
        st = "".join(f"<li>{e(s)}</li>" for s in steps)
        bk = "".join(f"<li>{e(b)}</li>" for b in brk)
        out.append(f'''<article class="scenario" id="scenario-{i}">
  <header><span class="num">{i}</span><div><h3>{e(t)}</h3><p class="who">{e(who)}</p></div></header>
  <ol>{st}</ol>
  <p class="expect"><span class="label">Expect</span>{e(expect)}</p>
  <div class="break"><span class="label">Try to break it</span><ul>{bk}</ul></div>
</article>''')
    return "".join(out)

CSS = """
:root {
  /* Layout: a single readable column; wide tables scroll in their own frame. Brand: MOAUM letterhead blue, ink and green. */
  --bg: #f6f7fb; --surface: #ffffff; --ink: #231f20; --muted: #5b5f6e; --line: #dfe2ec;
  --accent: #3d54a4; --accent-soft: #e8ecf8; --ok: #00753a; --ok-soft: #e3f3ea; --bad: #b8141b; --bad-soft: #fbe9ea;
  --display: "Montserrat", "Segoe UI", system-ui, sans-serif; --body: "Montserrat", "Segoe UI", system-ui, sans-serif; --mono: "JetBrains Mono", ui-monospace, Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #12141b; --surface: #1b1e28; --ink: #eceef5; --muted: #a2a7b8; --line: #2e3242;
  --accent: #8fa2ea; --accent-soft: #232a45; --ok: #5cc98d; --ok-soft: #173326; --bad: #f08a8f; --bad-soft: #3a1c1f; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #12141b; --surface: #1b1e28; --ink: #eceef5; --muted: #a2a7b8; --line: #2e3242;
  --accent: #8fa2ea; --accent-soft: #232a45; --ok: #5cc98d; --ok-soft: #173326; --bad: #f08a8f; --bad-soft: #3a1c1f; color-scheme: dark }
body { background: var(--bg); color: var(--ink); font-family: var(--body); font-size: 15px; line-height: 1.55; }
.page { max-width: 1040px; margin: 0 auto; padding-block: 32px 64px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); display: flex; flex-direction: column; gap: 40px; }
h1, h2, h3 { font-family: var(--display); text-wrap: balance; margin: 0; }
h1 { font-size: clamp(26px, 4vw, 36px); font-weight: 800; letter-spacing: -0.01em; }
h2 { font-size: 22px; font-weight: 800; }
h3 { font-size: 16px; font-weight: 700; }
p { margin: 0; }
.intro { display: flex; flex-direction: column; gap: 14px; }
.intro p { max-width: 68ch; color: var(--muted); }
.rule { height: 4px; width: 120px; background: linear-gradient(90deg, var(--accent) 0 33%, var(--bad) 33% 66%, var(--ok) 66%); border-radius: 2px; }
.label { display: block; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin-bottom: 4px; }
code { font-family: var(--mono); font-size: 0.86em; background: var(--accent-soft); color: var(--ink); padding: 1px 6px; border-radius: 4px; overflow-wrap: anywhere; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
.fact { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.fact strong { font-family: var(--display); }
section { display: flex; flex-direction: column; gap: 16px; }
section > p { color: var(--muted); max-width: 72ch; }
nav.toc { display: flex; flex-wrap: wrap; gap: 8px; }
nav.toc a { color: var(--accent); text-decoration: none; border: 1px solid var(--line); background: var(--surface); padding: 6px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; }
nav.toc a:hover, nav.toc a:focus-visible { border-color: var(--accent); outline: none; }
.actors { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.actor { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.actor header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.role { font-family: var(--mono); font-size: 11px; font-weight: 600; color: var(--accent); background: var(--accent-soft); padding: 2px 8px; border-radius: 999px; }
.role.muted { color: var(--muted); }
.line { color: var(--muted); font-size: 14px; }
.login { font-size: 13px; }
.tab { color: var(--muted); font-size: 12px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 420px) { .cols { grid-template-columns: 1fr; } }
.cols ul, .scenario ul, .scenario ol { margin: 0; padding-left: 18px; font-size: 13.5px; display: flex; flex-direction: column; gap: 4px; }
ul.no li::marker { content: "✕  "; color: var(--bad); }
.chips { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 5px; }
.chips li { font-size: 12px; border: 1px solid var(--line); border-radius: 6px; padding: 1px 7px; }
.pairs { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
.pairs .fact ul { margin: 0; padding-left: 18px; font-size: 14px; }
.scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
table { border-collapse: collapse; width: 100%; font-size: 13px; font-variant-numeric: tabular-nums; }
th, td { padding: 6px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
thead th { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); background: var(--surface); position: sticky; top: 0; }
.matrix td { text-align: center; }
.matrix thead th:not(:first-child) { text-align: center; }
.matrix tr.group th { background: var(--accent-soft); font-family: var(--display); font-size: 12px; font-weight: 700; color: var(--ink); text-transform: none; letter-spacing: 0; }
.matrix tbody tr:not(.group) th { font-weight: 400; white-space: nowrap; }
.yes { color: var(--ok); font-size: 14px; }
.no-cell { color: var(--line); }
table.plain { min-width: 760px; }
.scenarios { display: flex; flex-direction: column; gap: 14px; }
.scenario { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; }
.scenario header { display: flex; gap: 12px; align-items: flex-start; }
.num { flex: none; width: 28px; height: 28px; border-radius: 50%; background: var(--accent); color: var(--surface); display: grid; place-items: center; font-weight: 800; font-size: 13px; }
.who { color: var(--muted); font-size: 13px; }
.expect { background: var(--ok-soft); border-radius: 8px; padding: 8px 12px; font-size: 13.5px; }
.break { background: var(--bad-soft); border-radius: 8px; padding: 8px 12px; }
.later ul { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
footer { color: var(--muted); font-size: 12.5px; }
a { color: var(--accent); }
"""

page = f"""<title>Dommus Staging Test Guide</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap">
<style>{CSS}</style>
<main class="page">
  <div class="intro">
    <div class="rule" aria-hidden="true"></div>
    <h1>Dommus staging: test every actor</h1>
    <p>One demo login per actor, from someone who has only been invited up to the GMD, on the staging site of the MOAUM Credit Super Store portal. Each login holds a single role, so you see exactly what that person sees and where a second person has to step in. Nothing here is real money and staging never sends an SMS or email.</p>
    <div class="facts">
      <div class="fact"><span class="label">Site</span><strong><code>dommus-negotii-staging.vercel.app</code></strong><span class="line">Staff sign in on the Staff tab with their email; members on the Member tab with their phone.</span></div>
      <div class="fact"><span class="label">Passwords</span><strong>Shared privately</strong><span class="line">Kept in the project's private logins file (.env.demo.local), never on this page. Ask the person who set up the demo.</span></div>
      <div class="fact"><span class="label">First staff sign-in</span><strong>Authenticator app</strong><span class="line">Every staff login must set up a code app (Google or Microsoft Authenticator): one entry per login.</span></div>
      <div class="fact"><span class="label">Links and codes</span><strong>Admin → Staging outbox</strong><span class="line">Invitation links, phone codes and staff password links appear there for 24 hours instead of being sent.</span></div>
    </div>
    <nav class="toc" aria-label="Sections"><a href="#actors">Actors</a><a href="#pairs">Two-person rules</a><a href="#matrix">Who can do what</a><a href="#uploads">Uploads and file formats</a><a href="#scenarios">Scenarios</a><a href="#walkthrough">Launch walkthrough</a><a href="#later">Not built yet</a></nav>
  </div>

  <section id="actors">
    <h2>The actors</h2>
    <p>From the least access to the most oversight. The staff menu lists the pages each role sees; a page that isn't listed also refuses that role if the address is typed in.</p>
    <div class="actors">{"".join(actor_card(a) for a in ACTORS)}</div>
  </section>

  <section id="pairs">
    <h2>Two-person rules and roles that can't be combined</h2>
    <div class="pairs">
      <div class="fact"><span class="label">One prepares, another verifies</span><ul>
        <li>Loan: Loan Officer verifies and recommends → Management approves</li>
        <li>Disbursement voucher: Cashier → Finance Manager</li>
        <li>Schedule correction: Treasurer → Finance Manager</li>
        <li>Source Advice (Finance Manager), when given, is checked against the schedule (Treasurer)</li>
        <li>Guarantee: the guarantor accepts by their own SMS link before the loan is verified, approved or paid out</li>
        <li>Bank charge, interest or transfer: Cashier → Finance Manager</li>
        <li>Bank opening balance: Admin → Finance Manager</li>
        <li>Financial setting: Admin proposes → Management approves</li>
        <li>Lodgement: Finance Manager verifies at the bank → Cashier records</li>
      </ul></div>
      <div class="fact"><span class="label">Never the same person</span><ul>
        <li>Cashier + Finance Manager</li><li>Treasurer + Finance Manager</li><li>Management + Cashier</li><li>Management + Loan Officer</li><li>Secretary + Loan Officer</li><li>Admin or GMD with any other role</li>
        <li>Staff never act on their own loan or membership</li>
      </ul></div>
    </div>
  </section>

  <section id="matrix">
    <h2>Who can do what</h2>
    <p>Generated from the permission table the app enforces on every action. ● allowed, · refused.</p>
    {matrix()}
  </section>

  <section id="uploads">
    <h2>Uploads and file formats</h2>
    <p>Lists and schedules are checked in a dry run before anything is saved, and any error rejects the whole file with a reason per row. Templates download from each upload page in the app. The demo files are in the project under <code>docs/demo-files/</code>, with the exact figures to type in its README.</p>
    {uploads()}
  </section>

  <section id="scenarios">
    <h2>Scenarios to test</h2>
    <p>Each follows a real situation across the actors involved, with what should happen and the mistakes the system must refuse.</p>
    <div class="scenarios">{scenarios()}</div>
  </section>

  <section id="walkthrough">
    <h2>The launch walkthrough</h2>
    <p>This guide tests each role on the DEMO-PAYROLL data. The <a href="https://claude.ai/artifact/CXmDwCJDmdokg9Whcwq47L">launch walkthrough</a> takes the portal live in order on its own launch data (files in <code>docs/launch-files</code>), and covers what this guide doesn't:</p>
    <ul>
      <li>Setting the go-live date and the bank's go-live opening balance, then reconciling and closing October to the kobo (bank ₦2,008,395.00, ledger ₦1,995,895.00, difference ₦0.00).</li>
      <li>The legacy loan list creating its borrowers as members, each finishing their own set-up (address, next of kin) from the SMS link.</li>
      <li>A November payroll where one member overpays, one underpays and one clears a loan, with every figure rehearsed on the development database.</li>
      <li>December's deduction schedule after that payroll, and the loan limit, all with exact figures to check.</li>
      <li>A real payroll line shared across two loans on staging (SCH/REF/0002, Newton Abya), and a member's history with one loan completed (Phase 10).</li>
      <li>The account-number check on the loan application, the payout voucher and both refund forms, step by step.</li>
    </ul>
    <p>Its steps can be ticked as you go; ticks stay in your browser.</p>
  </section>
  <section id="later" class="later">
    <h2>Not built yet</h2>
    <ul>
      <li>Real SMS and email delivery: staging writes every message to the Staging outbox instead. The Termii account can be checked from your computer first (scenario 22); production then gets its four values, and Resend's for email.</li>
      <li>A name check of a bank account with the bank (needs a payment provider); the account number is only checked against the bank's check digit.</li>
    </ul>
  </section>
  <footer>Demo data on staging is permanent (the ledger can't be edited) and will not exist in production, which starts from a clean database.</footer>
</main>
"""
open(os.path.join(P, "docs", "testing-guide.html"), "w", encoding="utf-8", newline="\n").write(page)
print("ok", len(page))
