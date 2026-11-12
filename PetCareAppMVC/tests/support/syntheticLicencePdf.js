function syntheticLicencePdf(pages) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  pages.forEach((items, index) => {
    const stream = items === null ? 'q 400 0 0 400 40 300 cm /Im0 Do Q' : items.map(({ x, y, text, rotated }) =>
      `BT /F1 ${rotated ? 50 : 12} Tf ${rotated ? '0.866 0.5 -0.5 0.866' : '1 0 0 1'} ${x} ${y} Tm (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`
    ).join('\n');
    const imageResource = items === null ? `/XObject << /Im0 ${4 + pages.length * 2} 0 R >>` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> ${imageResource} >> /Contents ${5 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  if (pages.includes(null)) {
    objects.push('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nFFFFFF>\nendstream');
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

module.exports = { syntheticLicencePdf };
