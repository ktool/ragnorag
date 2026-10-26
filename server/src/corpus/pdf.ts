import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Extracts text per page (index 0 = PDF page 1), preserving line breaks reported by PDF.js. */
export async function extractPdfPages(data: Uint8Array): Promise<string[]> {
  const task = getDocument({ data, verbosity: 0 });
  const doc = await task.promise;
  const pages: string[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '');
      }
      pages.push(text);
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return pages;
}

export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}
