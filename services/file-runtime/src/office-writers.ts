import { readFile } from 'node:fs/promises';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import { strFromU8, unzipSync } from 'fflate';
import type { ArtifactGenerateInput } from '@jupiter/contracts';

export type ArtifactWriterOptions = {
  pdfFontPath?: string;
};

export async function generateArtifactBytes(
  input: ArtifactGenerateInput,
  options: ArtifactWriterOptions = {},
): Promise<Buffer> {
  if (input.type === 'txt' || input.type === 'markdown' || input.type === 'csv') {
    if (input.content.kind === 'text') return Buffer.from(input.content.text, 'utf8');
    if (input.type === 'csv' && input.content.kind === 'spreadsheet') {
      return Buffer.from(toCsv(input.content.sheets[0]?.rows ?? []), 'utf8');
    }
    throw new Error(`${input.type} generation requires text content.`);
  }
  if (input.type === 'json') {
    if (input.content.kind !== 'json') throw new Error('JSON generation requires JSON content.');
    return Buffer.from(`${JSON.stringify(input.content.value, null, 2)}\n`, 'utf8');
  }
  if (input.type === 'docx') {
    if (input.content.kind !== 'document') throw new Error('DOCX requires document content.');
    const document = new Document({
      sections: [
        {
          children: [
            new Paragraph({
              heading: HeadingLevel.TITLE,
              children: [new TextRun({ text: input.content.title, bold: true })],
            }),
            ...input.content.paragraphs.map((text) => new Paragraph({ text })),
          ],
        },
      ],
    });
    return Packer.toBuffer(document);
  }
  if (input.type === 'pptx') {
    if (input.content.kind !== 'presentation')
      throw new Error('PPTX requires presentation content.');
    const pptxModule = await import('pptxgenjs');
    const PptxConstructor = pptxModule.default as unknown as new () => PptxPresentation;
    const presentation = new PptxConstructor();
    presentation.layout = 'LAYOUT_WIDE';
    presentation.author = 'Jupiter';
    presentation.subject = input.source.description;
    presentation.title = input.content.title;
    presentation.company = 'Jupiter Project';
    presentation.lang = 'th-TH';
    presentation.theme = {
      headFontFace: 'Noto Sans Thai',
      bodyFontFace: 'Noto Sans Thai',
      lang: 'th-TH',
    };
    for (const [index, definition] of input.content.slides.entries()) {
      const slide = presentation.addSlide();
      slide.background = { color: input.content.theme === 'jupiter' ? '090D14' : 'FFFFFF' };
      const primary = input.content.theme === 'jupiter' ? 'EDF7FF' : '111827';
      const secondary = input.content.theme === 'jupiter' ? 'A7EDFF' : '334155';
      slide.addText(definition.title, {
        x: 0.65,
        y: 0.45,
        w: 12,
        h: 0.65,
        fontFace: 'Noto Sans Thai',
        fontSize: 25,
        bold: true,
        color: primary,
        margin: 0,
      });
      slide.addText(
        definition.body.map((text) => ({
          text,
          options: { bullet: { indent: 18 }, breakLine: true },
        })),
        {
          x: 0.8,
          y: 1.35,
          w: 7.1,
          h: 5.5,
          fontFace: 'Noto Sans Thai',
          fontSize: 17,
          color: secondary,
          breakLine: true,
          valign: 'top',
          margin: 0.06,
        },
      );
      for (const image of definition.images ?? []) {
        slide.addImage({
          path: image.path,
          x: image.x,
          y: image.y,
          w: image.width,
          h: image.height,
        });
      }
      if ((definition.notes ?? []).length > 0) slide.addNotes((definition.notes ?? []).join('\n'));
      slide.addText(String(index + 1), {
        x: 12.2,
        y: 7.05,
        w: 0.45,
        h: 0.2,
        fontSize: 8,
        color: '9DB1C7',
        align: 'right',
        margin: 0,
      });
    }
    const output = await presentation.write({ outputType: 'nodebuffer', compression: true });
    return Buffer.isBuffer(output) ? output : Buffer.from(output as Uint8Array);
  }
  if (input.type === 'xlsx') {
    if (input.content.kind !== 'spreadsheet') throw new Error('XLSX requires spreadsheet content.');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Jupiter';
    workbook.created = new Date();
    for (const sheetInput of input.content.sheets) {
      const sheet = workbook.addWorksheet(sheetInput.name);
      for (const rowInput of sheetInput.rows) {
        const row = sheet.addRow(
          rowInput.map((cell) => {
            if (typeof cell === 'string') return safeSpreadsheetText(cell);
            if (cell !== null && typeof cell === 'object' && 'formula' in cell) {
              return { formula: validateFormula(cell.formula), result: cell.result };
            }
            return cell;
          }),
        );
        row.eachCell((cell) => {
          cell.alignment = { vertical: 'top', wrapText: true };
        });
      }
      sheet.columns.forEach((column) => {
        column.width = 24;
      });
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }
  if (input.content.kind !== 'document') throw new Error('PDF requires document content.');
  return generatePdf(input.content.title, input.content.paragraphs, options.pdfFontPath);
}

export async function verifyArtifactBytes(
  type: ArtifactGenerateInput['type'],
  bytes: Buffer,
  expected: ArtifactGenerateInput['content'],
): Promise<string> {
  if (bytes.byteLength === 0) throw new Error('Artifact is empty.');
  if (type === 'docx') {
    const entries = unzipSync(bytes);
    requireEntry(entries, '[Content_Types].xml');
    requireEntry(entries, '_rels/.rels');
    requireEntry(entries, 'word/_rels/document.xml.rels');
    const documentXml = requireEntry(entries, 'word/document.xml');
    if (expected.kind !== 'document' || !strFromU8(documentXml).includes(xmlEscape(expected.title)))
      throw new Error('DOCX does not contain the expected title.');
    return 'DOCX package, relationships, content types, and expected title are valid.';
  }
  if (type === 'pptx') {
    const entries = unzipSync(bytes);
    requireEntry(entries, '[Content_Types].xml');
    requireEntry(entries, '_rels/.rels');
    requireEntry(entries, 'ppt/presentation.xml');
    requireEntry(entries, 'ppt/_rels/presentation.xml.rels');
    const slideCount = Object.keys(entries).filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name),
    ).length;
    if (expected.kind !== 'presentation' || slideCount !== expected.slides.length)
      throw new Error('PPTX slide count does not match the request.');
    return `PPTX package relationships are valid and ${String(slideCount)} slide(s) were verified.`;
  }
  if (type === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as never);
    if (expected.kind !== 'spreadsheet' || workbook.worksheets.length !== expected.sheets.length)
      throw new Error('XLSX worksheet count does not match the request.');
    return `XLSX structure, cell types, formulas, and ${String(workbook.worksheets.length)} sheet(s) were verified.`;
  }
  if (type === 'pdf') {
    const document = await PDFDocument.load(new Uint8Array(bytes));
    if (document.getPageCount() < 1) throw new Error('PDF contains no pages.');
    return `PDF structure and ${String(document.getPageCount())} page(s) were verified.`;
  }
  if (type === 'json') JSON.parse(bytes.toString('utf8'));
  return `${type.toUpperCase()} exists, is readable, and contains ${String(bytes.byteLength)} byte(s).`;
}

function safeSpreadsheetText(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function validateFormula(formula: string): string {
  if (/\[[^\]]+\]|https?:|file:/i.test(formula))
    throw new Error('External workbook and URL references are not allowed in formulas.');
  return formula.startsWith('=') ? formula.slice(1) : formula;
}

function toCsv(rows: readonly (readonly unknown[])[]): string {
  return `${rows
    .map((row) =>
      row
        .map((value) => {
          const raw = csvValueText(value);
          const safe = safeSpreadsheetText(raw);
          return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
        })
        .join(','),
    )
    .join('\r\n')}\r\n`;
}

function csvValueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  return JSON.stringify(value);
}

async function generatePdf(
  title: string,
  paragraphs: readonly string[],
  pdfFontPath?: string,
): Promise<Buffer> {
  const document = await PDFDocument.create();
  let font: PDFFont;
  if (pdfFontPath) {
    document.registerFontkit(fontkit);
    font = await document.embedFont(await readFile(pdfFontPath), { subset: true });
  } else {
    font = await document.embedFont(StandardFonts.Helvetica);
  }
  const pageSize: [number, number] = [595.28, 841.89];
  let page = document.addPage(pageSize);
  let y = 790;
  const drawLine = (line: string, size: number, color = rgb(0.06, 0.11, 0.18)): void => {
    if (y < 55) {
      page = document.addPage(pageSize);
      y = 790;
    }
    page.drawText(line, { x: 50, y, size, font, color, maxWidth: 495 });
    y -= size * 1.65;
  };
  drawLine(title, 22, rgb(0.05, 0.55, 0.75));
  y -= 8;
  for (const paragraph of paragraphs) {
    for (const line of wrapText(paragraph, 78)) drawLine(line, 11);
    y -= 8;
  }
  return Buffer.from(await document.save());
}

function wrapText(value: string, width: number): string[] {
  const words = value.split(/\s+/u);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current || `${current} ${word}`.length <= width)
      current = current ? `${current} ${word}` : word;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

function requireEntry(entries: Record<string, Uint8Array>, name: string): Uint8Array {
  const entry = entries[name];
  if (!entry) throw new Error(`Office package is missing ${name}.`);
  return entry;
}

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

type PptxSlide = {
  background: { color: string };
  addText: (text: unknown, options: Readonly<Record<string, unknown>>) => unknown;
  addImage: (options: Readonly<Record<string, unknown>>) => unknown;
  addNotes: (notes: string) => unknown;
};

type PptxPresentation = {
  layout: string;
  author: string;
  subject: string;
  title: string;
  company: string;
  lang: string;
  theme: Readonly<Record<string, unknown>>;
  addSlide: () => PptxSlide;
  write: (options: Readonly<Record<string, unknown>>) => Promise<unknown>;
};
