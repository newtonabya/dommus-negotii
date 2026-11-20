/**
 * Portal-wide SMS wording (sign-in and account codes). Credit messages (loan
 * approval and payout, repayment reminders, receipts for posted payroll
 * deductions) live in src/modules/credit/notices.ts, the Credit module's one
 * place for wording: shared code here never imports a module.
 *
 * Plain ASCII keeps each message to one 160-character SMS unit.
 */

export const APP_SMS_NAME = "MOAUM Credit";

export const smsTemplates = {
  /** Phone confirmation and sign-in code. */
  otp: (code: string) => `Your ${APP_SMS_NAME} code is ${code}. It expires in 5 minutes. Never share it.`,
  /** Password reset code. */
  passwordReset: (code: string) => `Your ${APP_SMS_NAME} password reset code is ${code}. It expires in 5 minutes. Never share it.`,
  /** Confirms a member's new phone number before a profile change. */
  phoneChange: (code: string) => `Your ${APP_SMS_NAME} code to confirm this number is ${code}. It expires in 10 minutes. Never share it.`,
  /** The test message sent by scripts/sms-test.mts when none is given. */
  test: () => `${APP_SMS_NAME}: test message from the portal set-up. No action needed.`,
} as const;
