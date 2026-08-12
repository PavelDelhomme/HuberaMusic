/**
 * Générateur PDF texte minimal (PDF 1.4, Helvetica) — sans dépendance externe.
 * Suffisant pour joindre un dump télémétrie lisible aux emails d’alerte.
 */
export function buildTextPdf(opts: {
  title: string;
  sections: Array<{ heading: string; body: string }>;
}): Buffer {
  const lines: string[] = [];
  const pushWrapped = (text: string, max = 92) => {
    const raw = String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n');
    for (const line of raw) {
      const s = line.replace(/\t/g, '  ');
      if (s.length <= max) {
        lines.push(s);
        continue;
      }
      let rest = s;
      while (rest.length > max) {
        let cut = rest.lastIndexOf(' ', max);
        if (cut < max * 0.6) cut = max;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\s+/, '');
      }
      if (rest) lines.push(rest);
    }
  };

  pushWrapped(opts.title);
  lines.push('');
  for (const sec of opts.sections) {
    lines.push(`## ${sec.heading}`);
    lines.push('');
    pushWrapped(sec.body || '(vide)');
    lines.push('');
  }

  const pageHeight = 842; // A4
  const pageWidth = 595;
  const margin = 40;
  const fontSize = 9;
  const leading = 11;
  const usable = pageHeight - margin * 2;
  const linesPerPage = Math.max(20, Math.floor(usable / leading) - 2);

  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage));
  }
  if (pages.length === 0) pages.push(['(vide)']);

  const esc = (s: string) =>
    s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  const contentStreams: string[] = pages.map((pageLines, pageIdx) => {
    const ops: string[] = ['BT', `/F1 ${fontSize} Tf`, `${margin} ${pageHeight - margin} Td`, `${leading} TL`];
    pageLines.forEach((ln, i) => {
      if (i === 0) ops.push(`(${esc(ln)}) Tj`);
      else ops.push(`T* (${esc(ln)}) Tj`);
    });
    ops.push('ET');
    // footer
    ops.push('BT', `/F1 8 Tf`, `${margin} 24 Td`, `(${esc(`PLM telemetry · page ${pageIdx + 1}/${pages.length}`)}) Tj`, 'ET');
    return ops.join('\n');
  });

  const objs: string[] = [];
  const offsets: number[] = [0];

  const addObj = (body: string) => {
    objs.push(body);
    return objs.length;
  };

  const fontId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const contentIds = contentStreams.map((stream) => {
    const bytes = Buffer.from(stream, 'utf8');
    return addObj(`<< /Length ${bytes.length} >>\nstream\n${stream}\nendstream`);
  });
  const pageIds = contentIds.map((cid) =>
    addObj(
      `<< /Type /Page /Parent 0 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents ${cid} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    ),
  );
  const pagesId = addObj(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
  );
  // patch Parent refs
  for (let i = 0; i < pageIds.length; i++) {
    const idx = pageIds[i]! - 1;
    objs[idx] = objs[idx]!.replace('/Parent 0 0 R', `/Parent ${pagesId} 0 R`);
  }
  const catalogId = addObj(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let pdf = '%PDF-1.4\n';
  const absOffsets: number[] = [0];
  for (let i = 0; i < objs.length; i++) {
    absOffsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objs.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objs.length; i++) {
    pdf += `${String(absOffsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}
