import { extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { strFromU8, unzipSync } from 'fflate';
import type { DocumentReadResult, FileFormat } from '@jupiter/contracts';

export type ExtractedDocument = Pick<DocumentReadResult, 'format' | 'text' | 'metadata'>;

const FORMAT_BY_EXTENSION: Readonly<Record<string, FileFormat>> = {
  '.txt': 'txt',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.pptx': 'pptx',
  '.xlsx': 'xlsx',
  '.csv': 'csv',
  '.json': 'json',
};

export async function extractDocument(
  path: string,
  maxBytes = 25 * 1024 * 1024,
): Promise<ExtractedDocument> {
  const bytes = await readFile(path);
  if (bytes.byteLength === 0) throw new Error('The document is empty.');
  if (bytes.byteLength > maxBytes)
    throw new Error(`The document exceeds the ${String(maxBytes)} byte parser limit.`);
  const format = FORMAT_BY_EXTENSION[extname(path).toLowerCase()];
  if (!format) throw new Error('The document format is unsupported.');
  if (['txt', 'markdown', 'csv'].includes(format)) {
    return { format, text: bytes.toString('utf8'), metadata: { size: bytes.byteLength } };
  }
  if (format === 'json') {
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    return {
      format,
      text: JSON.stringify(parsed, null, 2),
      metadata: { size: bytes.byteLength },
    };
  }
  if (format === 'docx') {
    const result = await mammoth.extractRawText({ buffer: bytes });
    return {
      format,
      text: result.value,
      metadata: { size: bytes.byteLength, warnings: result.messages.length },
    };
  }
  if (format === 'pdf') {
    const task = getDocument({
      data: new Uint8Array(bytes),
      useWorkerFetch: false,
    });
    const document = await task.promise;
    const pages: string[] = [];
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
      page.cleanup();
    }
    await task.destroy();
    return {
      format,
      text: pages.join('\n\n'),
      metadata: { size: bytes.byteLength, pages: pages.length },
    };
  }
  if (format === 'pptx') {
    const entries = unzipSync(bytes);
    if (!entries['ppt/presentation.xml'] || !entries['[Content_Types].xml'])
      throw new Error('The PPTX structure is corrupted.');
    const slideNames = Object.keys(entries)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort(numericOfficePartSort);
    const slides = slideNames.map((name) => {
      const entry = entries[name];
      if (!entry) throw new Error(`The PPTX slide entry ${name} is missing.`);
      return extractXmlText(strFromU8(entry));
    });
    return {
      format,
      text: slides.join('\n\n'),
      metadata: { size: bytes.byteLength, slides: slides.length },
    };
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as never);
  const lines: string[] = [];
  let formulaCount = 0;
  for (const sheet of workbook.worksheets) {
    lines.push(`# ${sheet.name}`);
    sheet.eachRow((row) => {
      const values = row.values;
      const cells = (Array.isArray(values) ? values.slice(1) : []).map((value) => {
        if (value && typeof value === 'object' && 'formula' in value) {
          formulaCount += 1;
          return `=${value.formula}`;
        }
        return cellValueText(value);
      });
      lines.push(cells.join('\t'));
    });
  }
  return {
    format,
    text: lines.join('\n'),
    metadata: {
      size: bytes.byteLength,
      sheets: workbook.worksheets.length,
      formulas: formulaCount,
    },
  };
}

function extractXmlText(xml: string): string {
  return [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
    .map((match) => decodeXml(match[1] ?? ''))
    .join('\n');
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function numericOfficePartSort(left: string, right: string): number {
  return officePartNumber(left) - officePartNumber(right);
}

function officePartNumber(value: string): number {
  return Number(/(\d+)\.xml$/.exec(value)?.[1] ?? 0);
}

function cellValueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && 'text' in value && typeof value.text === 'string')
    return value.text;
  return JSON.stringify(value);
}
