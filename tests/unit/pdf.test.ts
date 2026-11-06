import { PDFDocument, StandardFonts } from "pdf-lib";
import { PdfWriter } from "@/lib/pdf";
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
});
