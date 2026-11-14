import { PDFDocument, StandardFonts } from "pdf-lib";
import { PdfWriter } from "@/lib/pdf";
import { guarantorFormPdf } from "@/modules/credit/loans/guarantor-form";
import { formatNaira, kobo } from "@/lib/money";

describe("PDF writer", () => {
  it("writes naira amounts with the ₦ sign, which the standard PDF fonts can't encode", async () => {
    const amount = formatNaira(kobo(14_125_000n));
    expect(amount).toBe("₦141,250.00");

    const plain = await PDFDocument.create();
    const helvetica = await plain.embedFont(StandardFonts.Helvetica);
    expect(() => helvetica.encodeText(amount)).toThrow(/cannot encode/);

    const pdf = await PdfWriter.create("Test");
    pdf.title("Statement", "as at 2026-11-06");
    pdf.facts([["Outstanding", amount]]);
    pdf.table([{ header: "Amount", width: 1, align: "right" }], [[amount], [amount]], { totalRow: true });
    const bytes = await pdf.bytes();
    expect(bytes.length).toBeGreaterThan(1000);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it("embeds the whole (trimmed) font, so every letter and the naira sign can be drawn", async () => {
    const pdf = await PdfWriter.create("Glyphs");
    pdf.paragraph("Confirm the staff number: identification ﬀ ₦1,000.00 — Ọ̀ṣun · Ìbàdàn");
    const doc = await PDFDocument.load(await pdf.bytes());
    expect(doc.getPageCount()).toBe(1);
    // Subsetting by pdf-lib dropped glyphs (whole words printed blank); the fonts are trimmed ahead instead.
    expect((await pdf.bytes()).length).toBeLessThan(150_000);
  });

  it("prints the guarantor form on one A4 page, blank or with the applicant filled in", async () => {
    const blank = await PDFDocument.load(await guarantorFormPdf());
    expect(blank.getPageCount()).toBe(1);
    const filled = await PDFDocument.load(
      await guarantorFormPdf({ applicant: { fullName: "Aondo Tersoo", memberNo: "MOAUM/0014", pin: "A0217", phone: "+2348031234567", loanNo: "CSS-2026-00012", amount: 20_000_000n, tenure: 6, purpose: "School fees" } }),
    );
    expect(filled.getPageCount()).toBe(1);
  });
});
