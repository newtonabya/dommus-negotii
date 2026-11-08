# Demo files for staging tests

Made for the staging demo data (source DEMO-PAYROLL, account 3099000001). Fake people; never use in production.

| File | Who uploads it | Where |
|---|---|---|
| 1-november-2026-salary-voucher.xlsx | Finance Manager (as Source Advice: month 2026-11, control total 218750, 5 rows) | Remittance → Upload a Source Advice |
| 2-november-2026-schedule-with-lodgement.xlsx | Treasurer (REGULAR, month 2026-11, advice = the one above, control total 218750, 5 rows) | Remittance → Upload a remittance schedule |
| 3-bank-statement-2026-11-01-to-07.csv | Finance Manager (period 2026-11-01 to 2026-11-07, opening 4313577.06, closing 4547274.56) | Bank → Import a statement |
| 4-member-import.csv | Admin | Import members |
| 5-invitations.csv | Secretary | Invitations → bulk |
| 6-sample-document.pdf, 7-sample-id-card.jpg | anyone asked for a document or ID scan | any upload field |
| x-voucher-wrong-month.xlsx | Finance Manager or Treasurer: must be refused (month) | |
| x-voucher-unknown-staff-number.xlsx | must be refused (staff number not linked) | |
| x-schedule-moves-2500-between-members.xlsx | Treasurer: dry run must refuse (advice mismatch, AT-l) | |
