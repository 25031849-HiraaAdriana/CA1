const assert = require('node:assert/strict');
const { test } = require('node:test');
const { extractRegistrationFields, extractRegistrationFieldsFromText } = require('../helpers/avsLicenceDocument');
const { syntheticLicencePdf } = require('./support/syntheticLicencePdf');

const text = `Licensee Particulars
Name: Synthetic Owner
Dog Particulars
Name: Milo
Microchip No.: 000000000001234
Breed: Mixed
Colour: Brown
Sex: Female
Licence Info
Licence No.: 0009876
Issue Date: 01/01/2025
Expiry Date: 01/01/2026`;

test('extracts the dog name and identifiers from their own sections as strings', () => {
  assert.deepEqual(extractRegistrationFieldsFromText(text), {
    petName: 'Milo', microchipId: '000000000001234', avsLicenceNumber: '0009876'
  });
  assert.deepEqual(extractRegistrationFieldsFromText(
    'Licensee Particulars Name: Owner Dog Particulars Name: Milo Microchip No.: 000000000001234 Breed: Mixed Licence Info Licence No.: 0009876 Issue Date: 01/01/2025'
  ), { petName: 'Milo', microchipId: '000000000001234', avsLicenceNumber: '0009876' });
});

test('fails closed on absent, repeated, misplaced or unreadable fields', () => {
  for (const [document, field] of [
    [text.replace('Name: Milo\n', ''), 'petName'],
    [text.replace('Name: Milo', 'Name: Milo\nName: Other'), 'petName'],
    [text.replace('Name: Milo', 'Name:\nBreed: Mixed'), 'petName'],
    [text.replace('Microchip No.: 000000000001234\n', ''), 'microchipId'],
    [text.replace('Microchip No.: 000000000001234', 'Microchip No.: 000000000001234\nMicrochip No.: 000000000005678'), 'microchipId'],
    [text.replace('Licence No.: 0009876\n', ''), 'avsLicenceNumber'],
    [text.replace('Licence No.: 0009876', 'Licence No.: 0009876\nLicence No.: 0005432'), 'avsLicenceNumber'],
    [text.replace('Licence No.: 0009876', 'Licence No.: ???'), 'avsLicenceNumber'],
    [text.replace('Dog Particulars', 'Other Particulars'), 'petName'],
    [text.replace('Licence No.: 0009876', 'Other No.: 0009876'), 'avsLicenceNumber'],
    [text.replace('Dog Particulars', 'Dog Particulars\nDog Particulars'), 'petName']
  ]) {
    assert.equal(extractRegistrationFieldsFromText(document)[field], null, field);
  }
});

test('reads labelled values on the next line without converting identifiers to numbers', () => {
  const document = text.replace('Name: Milo', 'Name:\nMilo')
    .replace('Microchip No.: 000000000001234', 'Microchip No.:\n000000000001234')
    .replace('Licence No.: 0009876', 'Licence No.:\n0009876');
  assert.deepEqual(extractRegistrationFieldsFromText(document), {
    petName: 'Milo', microchipId: '000000000001234', avsLicenceNumber: '0009876'
  });
});

test('recognizes animal-specific and generic sections with alternate labels', () => {
  for (const section of ['Cat Particulars', 'Pet Particulars', 'Animal Particulars',
    'Rabbit Details', 'Animal Information', 'Pet Profile']) {
    const document = text.replace('Dog Particulars', section)
      .replace('Name: Milo', 'Pet Name: Milo')
      .replace('Microchip No.:', 'MID:')
      .replace('Licence Info', 'Licence Details')
      .replace('Licence No.:', 'AVS Licence Number:');
    assert.deepEqual(extractRegistrationFieldsFromText(document), {
      petName: 'Milo', microchipId: '000000000001234', avsLicenceNumber: '0009876'
    }, section);
  }
  assert.equal(extractRegistrationFieldsFromText(text.replace('0009876', 'ABCDEF')).avsLicenceNumber, 'ABCDEF');
});

test('accepts explicit animal labels without section headings but not a human name', () => {
  const document = `Licensee Details
Name: Synthetic Owner
Animal Name: Milo
Microchip Number: 000000000001234
Licence No.: 0009876`;
  assert.equal(extractRegistrationFieldsFromText(document).petName, null);
  const fields = `Animal Name: Milo
Microchip Number: 000000000001234
Licence No.: 0009876
Owner Details
Name: Synthetic Owner`;
  assert.deepEqual(extractRegistrationFieldsFromText(fields), {
    petName: 'Milo', microchipId: '000000000001234', avsLicenceNumber: '0009876'
  });
});

test('never substitutes an owner name and refuses invalid or ambiguous MIDs', () => {
  for (const document of [
    text.replace('Name: Milo', 'Owner Name: Synthetic Owner'),
    text.replace('Name: Milo', 'Owner Full Name: Synthetic Owner'),
    text.replace('Name: Milo', 'Name:\nOwner Details\nName: Synthetic Owner'),
    text.replace('Name: Milo', 'Owner\nName: Synthetic Owner'),
    text.replace('Name: Milo', 'Owner Contact Details\nName: Synthetic Owner'),
    text.replace('000000000001234', '00000000000123'),
    text.replace('000000000001234', '00000000000123X'),
    text.replace('000000000001234', '000000 000001234')
  ]) {
    const fields = extractRegistrationFieldsFromText(document);
    assert.ok(!fields.petName || !fields.microchipId);
  }
});

test('parses varying synthetic PDF layouts and multiple pages', async () => {
  const variants = [
    [
      { x: 40, y: 740, text: 'Owner Details' },
      { x: 40, y: 720, text: 'Name: Synthetic Owner' },
      { x: 40, y: 700, text: 'Animal Details' },
      { x: 40, y: 680, text: 'Name: Amber' },
      { x: 40, y: 660, text: 'Microchip Number: 001234567890123' },
      { x: 40, y: 640, text: 'Licence Details' },
      { x: 40, y: 620, text: 'Issue Date: 01/01/2025' },
      { x: 40, y: 600, text: 'Licence Reference Number: XY-0012' }
    ],
    [
      { x: 40, y: 740, text: 'Registration Details' },
      { x: 40, y: 720, text: 'Licence ID:' },
      { x: 40, y: 700, text: 'XY-0012' },
      { x: 40, y: 680, text: 'Pet Particulars' },
      { x: 40, y: 660, text: 'Pet Name:' },
      { x: 40, y: 640, text: 'Amber' },
      { x: 40, y: 620, text: 'MID:' },
      { x: 40, y: 600, text: '001234567890123' },
      { x: 40, y: 580, text: 'Licensee Particulars' },
      { x: 40, y: 560, text: 'Name: Synthetic Owner' }
    ],
    [
      { x: 40, y: 740, text: 'Animal Name: Amber' },
      { x: 40, y: 720, text: 'Micro-chip ID: 001234567890123' },
      { x: 40, y: 700, text: 'AVS License Number: XY-0012' },
      { x: 40, y: 680, text: 'Owner Details' },
      { x: 40, y: 660, text: 'Name: Synthetic Owner' }
    ]
  ];
  const expected = { petName: 'Amber', microchipId: '001234567890123', avsLicenceNumber: 'XY-0012' };
  for (const layout of variants) {
    assert.deepEqual(await extractRegistrationFields(syntheticLicencePdf([layout])), expected);
  }
  assert.deepEqual(await extractRegistrationFields(syntheticLicencePdf([
    variants[0].slice(0, 5), variants[0].slice(5)
  ])), expected);
});

test('rejects image-only or blank pages rather than guessing', async () => {
  await assert.rejects(extractRegistrationFields(syntheticLicencePdf([[]])), { code: 'PDF_NO_TEXT' });
  await assert.rejects(extractRegistrationFields(syntheticLicencePdf([null])), { code: 'PDF_NO_TEXT' });
  await assert.rejects(extractRegistrationFields(syntheticLicencePdf([
    [{ x: 40, y: 740, text: 'Pet Name: Amber' }], null
  ])), { code: 'PDF_NO_TEXT' });
});

test('reads clearly aligned table columns and rejects uncertain alignment', async () => {
  const table = [
    { x: 40, y: 740, text: 'Pet Details' },
    { x: 40, y: 720, text: 'Name' }, { x: 230, y: 720, text: 'Microchip No.' },
    { x: 40, y: 700, text: 'Amber' }, { x: 230, y: 700, text: '001234567890123' },
    { x: 40, y: 680, text: 'Licence Details' },
    { x: 40, y: 660, text: 'Licence No.' }, { x: 230, y: 660, text: 'Issue Date' },
    { x: 40, y: 640, text: 'XY-0012' }, { x: 230, y: 640, text: '01/01/2025' }
  ];
  assert.deepEqual(await extractRegistrationFields(syntheticLicencePdf([table])), {
    petName: 'Amber', microchipId: '001234567890123', avsLicenceNumber: 'XY-0012'
  });
  const misaligned = table.map(item => item.text === 'XY-0012' ? { ...item, x: 100 } : item);
  await assert.rejects(extractRegistrationFields(syntheticLicencePdf([misaligned])), { code: 'PDF_LAYOUT_UNSUPPORTED' });
});

test('rejects conflicting licence fields across sections and does not treat labels as values', async () => {
  const pages = [[
    { x: 40, y: 740, text: 'Pet Details' },
    { x: 40, y: 720, text: 'Name: Amber' },
    { x: 40, y: 700, text: 'Microchip No.: 001234567890123' },
    { x: 40, y: 680, text: 'Licence No.: XY-0012' },
    { x: 40, y: 660, text: 'Licence Details' },
    { x: 40, y: 640, text: 'Licence No.: XY-0099' }
  ]];
  assert.equal((await extractRegistrationFields(syntheticLicencePdf(pages))).avsLicenceNumber, null);
  const missing = `Pet Name: Amber
MID: 001234567890123
Licence No.:
Name
Synthetic Owner`;
  assert.equal(extractRegistrationFieldsFromText(missing).avsLicenceNumber, null);
});

test('handles decorative diagonal text and prose without ignoring actual field conflicts', async () => {
  const document = [
    { x: 40, y: 400, text: 'DECORATIVE OVERLAY FOR DOCUMENT', rotated: true },
    { x: 40, y: 740, text: 'Pet Particulars' },
    { x: 40, y: 720, text: 'Name: Amber' },
    { x: 40, y: 700, text: 'Microchip No.: 001234567890123' },
    { x: 40, y: 680, text: 'Licence Info' },
    { x: 40, y: 660, text: 'Licence No.: XY-0012' },
    { x: 40, y: 620, text: 'Please keep your licence number in a secure place.' }
  ];
  assert.deepEqual(await extractRegistrationFields(syntheticLicencePdf([document])), {
    petName: 'Amber', microchipId: '001234567890123', avsLicenceNumber: 'XY-0012'
  });
  const duplicated = [...document, { x: 40, y: 640, text: 'Licence No.: XY-0099' }];
  assert.equal((await extractRegistrationFields(syntheticLicencePdf([duplicated]))).avsLicenceNumber, null);
  for (const rotated of ['LICENCE NUMBER XY0012', 'IDENTIFIER 001234567890123', 'SMALL']) {
    const changed = document.map(item => item.rotated ? { ...item, text: rotated } : item);
    await assert.rejects(extractRegistrationFields(syntheticLicencePdf([changed])), {
      code: 'PDF_LAYOUT_UNSUPPORTED'
    });
  }
});
