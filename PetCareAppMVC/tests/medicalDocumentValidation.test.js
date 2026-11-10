const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createCanvas } = require('@napi-rs/canvas');
const { detectDocumentMimeType, validateMedicalDocument } = require('../helpers/medicalDocumentExtraction');

function samplePdf() {
  let contents = '%PDF-1.4\n';
  const offsets = [0];
  const object = (id, value) => {
    offsets[id] = Buffer.byteLength(contents);
    contents += `${id} 0 obj\n${value}\nendobj\n`;
  };
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>');
  const xref = Buffer.byteLength(contents);
  contents += 'xref\n0 4\n0000000000 65535 f \n';
  for (let id = 1; id <= 3; id += 1) contents += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  contents += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(contents);
}

test('valid PDF, JPEG and PNG are validated without text extraction', async () => {
  const canvas = createCanvas(2, 2);
  for (const [mime, bytes] of [
    ['application/pdf', samplePdf()],
    ['image/jpeg', canvas.toBuffer('image/jpeg')],
    ['image/png', canvas.toBuffer('image/png')]
  ]) {
    assert.equal(detectDocumentMimeType(bytes), mime);
    await validateMedicalDocument(bytes, mime);
  }
});

test('malformed, unsupported and executable-prefixed documents are rejected', async () => {
  assert.equal(detectDocumentMimeType(Buffer.from('MZ executable')), null);
  await assert.rejects(validateMedicalDocument(Buffer.from('MZ%PDF-1.7\n%%EOF'), 'application/pdf'), /header/);
  await assert.rejects(validateMedicalDocument(Buffer.from('%PDF-1.7\n%%EOF'), 'application/pdf'), /malformed|unreadable/i);
  await assert.rejects(validateMedicalDocument(Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex'), 'image/png'), /malformed|decoded/i);
  await assert.rejects(validateMedicalDocument(Buffer.from('x'), 'application/octet-stream'), /Only PDF/);
});
