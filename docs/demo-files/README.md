# Demo files for staging tests

Made for the staging demo data (source DEMO-PAYROLL, account 3099000001). Fake people; never use in production. Members are named by their payroll PIN (S03020 …); MOAUM numbers (MOAUM/0001 …) are issued by the system.

| File | Who uploads it | Where |
|---|---|---|
| 1-november-2026-salary-voucher.xlsx | Finance Manager, optional (as Source Advice: month 2026-11, control total 218750, 5 rows); or the Treasurer uploads it as the schedule itself (payment date 2026-11-05) | Remittance → Upload a Source Advice / Upload a remittance schedule |
| 2-november-2026-schedule-with-lodgement.xlsx | Treasurer (month 2026-11, control total 218750, 5 rows; members by PIN). REGULAR on a fresh staging; SUPPLEMENTARY once November's REGULAR is posted (it is, on staging since 14 November). Source Advice: the one above, or None | Remittance → Upload a remittance schedule (the reference is issued on posting) |
| 3-bank-statement-2026-11-01-to-07.csv | Finance Manager (period 2026-11-01 to 2026-11-07, opening 4313577.06, closing 4547274.56) | Bank → Import a statement |
| 4-member-import.csv | Admin (each new member gets the next MOAUM number and a set-up SMS) | Import members |
| 5-invitations.csv | Secretary | Invitations → bulk |
| 8-legacy-loans.csv | Admin (payroll source DEMO-PAYROLL, go-live date 2026-10-01, total still owed 236,666.67, 3 loans): the third row is refused, as its PIN is not on DEMO-PAYROLL and it gives no phone to create the member from (“Phone: enter a Nigerian mobile number for Unknown Person”); remove it, total 186,666.67, 2 loans. The Finance Manager brings them in | Legacy loans |
| 6-sample-document.pdf, 7-sample-id-card.jpg | anyone asked for a document or ID scan (the PDF also serves as a non-member guarantor's signed form) | any upload field |
| x-voucher-wrong-month.xlsx | Finance Manager or Treasurer: must be refused (month) | |
| x-voucher-unknown-staff-number.xlsx | must be refused (staff number not linked) | |
| x-schedule-moves-2500-between-members.xlsx | Treasurer, naming the Source Advice above: dry run must refuse (advice mismatch, AT-l). With Source Advice None it posts: the advice is optional | |
