import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";

/**
 * A4 PDF writer for statements, receipts and reports (PRD F13). Uses Noto
 * Sans, embedded, because the standard PDF fonts have no ₦ sign.
 */
const A4: [number, number] = [595.28, 841.89];
const MARGIN = 48;
const INK = rgb(0.137, 0.122, 0.125); // brand foreground #231f20
const MUTED = rgb(0.42, 0.42, 0.45);
const ACCENT = rgb(0.239, 0.329, 0.643); // brand accent #3d54a4
const RULE = rgb(0.85, 0.85, 0.88);

let fonts: Promise<[Uint8Array, Uint8Array]> | null = null;
function fontBytes() {
  fonts ??= Promise.all([
    readFile(path.resolve(/*turbopackIgnore: true*/ process.cwd(), "assets/fonts/NotoSans-Regular.ttf")),
    readFile(path.resolve(/*turbopackIgnore: true*/ process.cwd(), "assets/fonts/NotoSans-Bold.ttf")),
  ]);
  return fonts;
}

export interface Column {
  header: string;
  /** Share of the usable width; widths are normalised. */
  width: number;
  align?: "left" | "right";
}

export class PdfWriter {
  private page!: PDFPage;
  private y = 0;
  private constructor(
    readonly doc: PDFDocument,
    private readonly font: PDFFont,
    private readonly bold: PDFFont,
    private readonly footer: string,
    private readonly size: [number, number],
  ) {}

  static async create(title: string, footer = "Dommus Negotii · MOAUM Credit Super Store", options: { landscape?: boolean } = {}): Promise<PdfWriter> {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    doc.setTitle(title);
    doc.setCreator("Dommus Negotii");
    const [regular, bold] = await fontBytes();
    const size: [number, number] = options.landscape ? [A4[1], A4[0]] : A4;
    const writer = new PdfWriter(doc, await doc.embedFont(regular, { subset: true }), await doc.embedFont(bold, { subset: true }), footer, size);
    writer.newPage();
    return writer;
  }

  get width() {
    return this.size[0] - MARGIN * 2;
  }

  private newPage() {
    this.page = this.doc.addPage(this.size);
    this.y = this.size[1] - MARGIN;
    this.page.drawText(this.footer, { x: MARGIN, y: MARGIN / 2, size: 7.5, font: this.font, color: MUTED });
  }

  /** Starts a new page when fewer than `height` points remain. */
  ensure(height: number) {
    if (this.y - height < MARGIN) this.newPage();
  }

  private wrap(text: string, f: PDFFont, size: number, width: number): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split("\n")) {
      let line = "";
      for (const word of paragraph.split(" ")) {
        const next = line ? `${line} ${word}` : word;
        if (f.widthOfTextAtSize(next, size) > width && line) {
          lines.push(line);
          line = word;
        } else line = next;
      }
      lines.push(line);
    }
    return lines;
  }

  title(text: string, subtitle?: string) {
    this.ensure(48);
    this.page.drawRectangle({ x: MARGIN, y: this.y - 3, width: 36, height: 3, color: ACCENT });
    this.y -= 22;
    this.page.drawText(text, { x: MARGIN, y: this.y, size: 17, font: this.bold, color: INK });
    this.y -= 16;
    if (subtitle) {
      for (const line of this.wrap(subtitle, this.font, 9.5, this.width)) {
        this.page.drawText(line, { x: MARGIN, y: this.y, size: 9.5, font: this.font, color: MUTED });
        this.y -= 13;
      }
    }
    this.y -= 6;
  }

  heading(text: string) {
    this.ensure(30);
    this.y -= 8;
    this.page.drawText(text, { x: MARGIN, y: this.y, size: 11.5, font: this.bold, color: INK });
    this.y -= 15;
  }

  paragraph(text: string, size = 9.5, muted = false) {
    for (const line of this.wrap(text, this.font, size, this.width)) {
      this.ensure(size + 4);
      this.page.drawText(line, { x: MARGIN, y: this.y, size, font: this.font, color: muted ? MUTED : INK });
      this.y -= size + 4;
    }
  }

  /** Label/value pairs in two columns. */
  facts(rows: Array<[string, string]>, labelWidth = 170) {
    for (const [label, value] of rows) {
      const lines = this.wrap(value, this.font, 9.5, this.width - labelWidth);
      this.ensure(lines.length * 13 + 2);
      this.page.drawText(label, { x: MARGIN, y: this.y, size: 9.5, font: this.font, color: MUTED });
      for (const line of lines) {
        this.page.drawText(line, { x: MARGIN + labelWidth, y: this.y, size: 9.5, font: this.font, color: INK });
        this.y -= 13;
      }
    }
    this.y -= 4;
  }

  /** A table; the header repeats on each new page. The last row can be bold (a total). */
  table(columns: Column[], rows: string[][], options: { totalRow?: boolean; size?: number } = {}) {
    const size = options.size ?? 8.5;
    const total = columns.reduce((t, c) => t + c.width, 0);
    const widths = columns.map((c) => (c.width / total) * this.width);
    const drawRow = (cells: string[], f: PDFFont, color = INK) => {
      this.ensure(size + 8);
      let x = MARGIN;
      cells.forEach((cell, i) => {
        const w = widths[i] ?? 0;
        let text = cell;
        while (text.length > 1 && f.widthOfTextAtSize(text, size) > w - 4) text = `${text.slice(0, -2)}…`;
        const tw = f.widthOfTextAtSize(text, size);
        const cx = columns[i]?.align === "right" ? x + w - tw - 2 : x + 2;
        this.page.drawText(text, { x: cx, y: this.y, size, font: f, color });
        x += w;
      });
      this.y -= size + 5;
    };
    const header = () => {
      drawRow(columns.map((c) => c.header), this.bold, MUTED);
      this.page.drawLine({ start: { x: MARGIN, y: this.y + size - 1 }, end: { x: MARGIN + this.width, y: this.y + size - 1 }, thickness: 0.5, color: RULE });
    };
    header();
    rows.forEach((r, i) => {
      if (this.y - (size + 8) < MARGIN) {
        this.newPage();
        header();
      }
      const last = options.totalRow && i === rows.length - 1;
      if (last) this.page.drawLine({ start: { x: MARGIN, y: this.y + size + 1 }, end: { x: MARGIN + this.width, y: this.y + size + 1 }, thickness: 0.5, color: RULE });
      drawRow(r, last ? this.bold : this.font);
    });
    this.y -= 6;
  }

  async image(png: Uint8Array, size: number): Promise<PDFImage> {
    const img = await this.doc.embedPng(png);
    this.ensure(size + 6);
    this.page.drawImage(img, { x: MARGIN, y: this.y - size, width: size, height: size });
    this.y -= size + 8;
    return img;
  }

  async bytes(): Promise<Uint8Array> {
    return this.doc.save();
  }
}

/** PDF download headers. */
export function pdfHeaders(filename: string): Record<string, string> {
  return { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" };
}
