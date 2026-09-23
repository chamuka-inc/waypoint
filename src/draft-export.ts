import fontURL from './assets/NotoSans-Regular.ttf?url';

function saveBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportDraftText(text: string, filename: string, format: 'txt' | 'docx' | 'pdf') {
  if (format === 'txt') { saveBlob(`${filename}.txt`, new Blob([text], { type: 'text/plain;charset=utf-8' })); return; }
  if (format === 'docx') {
    const { Document, Packer, Paragraph, TextRun } = await import('docx');
    const paragraphs = text.split(/\r?\n/).map(line => new Paragraph({ children: [new TextRun(line || ' ')], spacing: { after: line ? 90 : 170 } }));
    const document = new Document({ sections: [{ children: paragraphs }] });
    saveBlob(`${filename}.docx`, await Packer.toBlob(document));
    return;
  }
  const [{ PDFDocument, rgb }, fontkit] = await Promise.all([import('pdf-lib'), import('@pdf-lib/fontkit')]);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit.default);
  const fontBytes = await (await fetch(fontURL)).arrayBuffer();
  const font = await pdf.embedFont(fontBytes, { subset: true });
  const supported = new Set(font.getCharacterSet());
  if ([...text].some(character => !/\s/.test(character) && !supported.has(character.codePointAt(0)!))) throw new Error('This PDF font cannot show every character in the draft. Export DOCX or plain text instead.');
  const pageWidth = 595, pageHeight = 842, margin = 56, fontSize = 10.5, leading = 15;
  let page = pdf.addPage([pageWidth, pageHeight]), y = pageHeight - margin;
  const addLine = (line: string) => {
    if (y < margin + leading) { page = pdf.addPage([pageWidth, pageHeight]); y = pageHeight - margin; }
    if (line) page.drawText(line, { x: margin, y, font, size: fontSize, color: rgb(0.12, 0.16, 0.18) });
    y -= leading;
  };
  for (const paragraph of text.split(/\r?\n/)) {
    if (!paragraph) { addLine(''); continue; }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, fontSize) > pageWidth - 2 * margin && line) { addLine(line); line = word; }
      else line = candidate;
      if (font.widthOfTextAtSize(line, fontSize) > pageWidth - 2 * margin) {
        let chunk = '';
        for (const character of line) {
          if (font.widthOfTextAtSize(chunk + character, fontSize) > pageWidth - 2 * margin && chunk) { addLine(chunk); chunk = ''; }
          chunk += character;
        }
        line = chunk;
      }
    }
    addLine(line);
  }
  const bytes = await pdf.save();
  saveBlob(`${filename}.pdf`, new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }));
}
