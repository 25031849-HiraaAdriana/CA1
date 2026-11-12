const { PDFParse } = require('pdf-parse');

const FIELD_LABEL_PATTERN = /(^|\s)((?:(?:AVS\s+)?licen[cs]e\s+(?:number|no\.?)|microchip\s+(?:id|number|no\.?)|MID))\s*[:：#-]?\s*/gi;
const FIELD_LABEL_LINE_PATTERN = /(^|\s)((?:(?:AVS\s+)?licen[cs]e\s+(?:number|no\.?)|microchip\s+(?:id|number|no\.?)|MID))\s*[:：#-]?\s*/i;

function extractIdentifiersFromText(text) {
  const found = {
    avsLicenceNumbers: [],
    microchipIds: []
  };
  const lines = text.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const labels = Array.from(line.matchAll(FIELD_LABEL_PATTERN));

    labels.forEach((label, labelIndex) => {
      const field = /microchip|MID/i.test(label[2]) ? 'microchipIds' : 'avsLicenceNumbers';
      const valueStart = label.index + label[0].length;
      const valueEnd = labelIndex + 1 < labels.length ? labels[labelIndex + 1].index : line.length;
      let value = getIdentifierValue(line.slice(valueStart, valueEnd));

      if (!value && labelIndex + 1 === labels.length) {
        let nextLineIndex = lineIndex + 1;
        while (nextLineIndex < lines.length && !lines[nextLineIndex].trim()) {
          nextLineIndex += 1;
        }

        if (nextLineIndex < lines.length && !FIELD_LABEL_LINE_PATTERN.test(lines[nextLineIndex])) {
          value = getIdentifierValue(lines[nextLineIndex]);
        }
      }

      if (value) found[field].push(value);
    });
  }

  return {
    avsLicenceNumber: getSingleIdentifier(found.avsLicenceNumbers),
    microchipId: getSingleIdentifier(found.microchipIds)
  };
}

function getSingleIdentifier(values) {
  const uniqueValues = [...new Set(values)];
  return uniqueValues.length === 1 ? uniqueValues[0] : null;
}

function getIdentifierValue(value) {
  const candidate = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(candidate) || !/\d/.test(candidate)) {
    return null;
  }
  return candidate;
}

const SECTION_PATTERN = /\b((?:dog|cat|rabbit|hamster|guinea[ \t]+pig|pet|animal|licen[cs]ee|owner|keeper|holder|applicant|licen[cs]e|registration)[ \t]+(?:particulars|information|info|details|profile)|(?:licen[cs]ee|owner|keeper|holder|applicant)(?=[ \t]*\r?$)|(?:[A-Za-z]+[ \t]+){1,3}(?:particulars|information|info|details|profile)(?=[ \t]*\r?$))\b/gim;
const PET_SECTION = /^(?:dog|cat|rabbit|hamster|guinea[ \t]+pig|pet|animal)[ \t]+(?:particulars|information|info|details|profile)$/i;
const PET_LABELS = /\b((?:owner|licen[cs]ee|keeper|holder|applicant)[ \t]+(?:full[ \t]+)?name|name[ \t]+of[ \t]+(?:owner|licen[cs]ee|keeper|holder|applicant)|(?:pet|animal|dog|cat|rabbit|hamster)[ \t]+name|name[ \t]+of[ \t]+(?:pet|animal|dog|cat|rabbit|hamster)|name|micro[ \t-]?chip[ \t]+(?:id|number|no\.?)|MID|(?:AVS[ \t]+)?licen[cs](?:e|ing)[ \t]+(?:reference[ \t]+)?(?:number|no\.?|id)|issue[ \t]+date|expiry[ \t]+date|breed|colou?r|sex|species)(?=$|[\s:：#])[ \t]*[:：#]?[ \t]*/gi;
const LICENCE_LABELS = /\b((?:AVS[ \t]+)?licen[cs](?:e|ing)[ \t]+(?:reference[ \t]+)?(?:number|no\.?|id)|(?:AVS[ \t]+)?licen[cs]e(?=[ \t]*#)|issue[ \t]+date|expiry[ \t]+date)(?=$|[\s:：#])[ \t]*[:：#]?[ \t]*/gi;
const MICROCHIP_LABELS = PET_LABELS;

function getSection(text, sectionName) {
  const sections = Array.from(text.matchAll(SECTION_PATTERN));
  const matches = sections.filter(section => sectionName.test(section[1]));
  if (matches.length !== 1) return null;
  const index = sections.indexOf(matches[0]);
  return text.slice(matches[0].index + matches[0][0].length,
    index + 1 < sections.length ? sections[index + 1].index : text.length);
}

function getUnownedText(text) {
  const sections = Array.from(text.matchAll(SECTION_PATTERN));
  let result = text.slice(0, sections.length ? sections[0].index : text.length);
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    if (/^(?:licen[cs]ee|owner|keeper|holder|applicant)\b/i.test(section[1])) continue;
    result += `\n${text.slice(section.index + section[0].length,
      index + 1 < sections.length ? sections[index + 1].index : text.length)}`;
  }
  return result;
}

function getSectionValues(section, labelPattern, wantedLabel, validate) {
  if (section === null) return null;
  const lines = section.split(/\r?\n/);
  const values = [];
  for (let index = 0; index < lines.length; index += 1) {
    const labels = Array.from(lines[index].matchAll(labelPattern));
    for (let labelIndex = 0; labelIndex < labels.length; labelIndex += 1) {
      const label = labels[labelIndex];
      if (!wantedLabel.test(label[1])) continue;
      if (labelPattern === LICENCE_LABELS && labelIndex === 0) {
        const prefix = lines[index].slice(0, label.index);
        const sections = Array.from(prefix.matchAll(SECTION_PATTERN));
        const endsWithSection = sections.some(section =>
          !prefix.slice(section.index + section[0].length).trim());
        if (prefix.trim() && !prefix.includes('\t') && !endsWithSection) continue;
      }
      const start = label.index + label[0].length;
      const end = labelIndex + 1 < labels.length ? labels[labelIndex + 1].index : lines[index].length;
      let value = lines[index].slice(start, end).trim();
      if (!value && labels.length > 1 && lines[index].includes('\t')) {
        const cells = lines[index].split('\t').map(cell => cell.trim()).filter(Boolean);
        const nextCells = (lines[index + 1] || '').split('\t').map(cell => cell.trim()).filter(Boolean);
        if (cells.length === labels.length && nextCells.length === cells.length &&
            cells.every(cell => Array.from(cell.matchAll(labelPattern)).length === 1) &&
            nextCells.every(cell => !Array.from(cell.matchAll(labelPattern)).length)) {
          value = nextCells[labelIndex];
        }
      } else if (!value && labelIndex === labels.length - 1) {
        let next = index + 1;
        while (next < lines.length && !lines[next].trim()) next += 1;
        if (next < lines.length &&
            !Array.from(lines[next].matchAll(PET_LABELS)).length &&
            !Array.from(lines[next].matchAll(LICENCE_LABELS)).length &&
            !Array.from(lines[next].matchAll(SECTION_PATTERN)).length) {
          value = lines[next].trim();
        }
      }
      values.push(validate(value));
    }
  }
  return values.length === 1 ? values[0] : null;
}

function extractRegistrationFieldsFromText(text) {
  const pet = getSection(text, PET_SECTION);
  const sections = Array.from(text.matchAll(SECTION_PATTERN));
  const petCount = sections.filter(section => PET_SECTION.test(section[1])).length;
  const unownedText = getUnownedText(text);
  const petFields = petCount === 0 ? unownedText : pet;
  const nameLabel = petCount === 0
    ? /^(?:(?:pet|animal|dog|cat|rabbit|hamster)[ \t]+name|name[ \t]+of[ \t]+(?:pet|animal|dog|cat|rabbit|hamster))$/i
    : /^(?:name|(?:pet|animal|dog|cat|rabbit|hamster)[ \t]+name|name[ \t]+of[ \t]+(?:pet|animal|dog|cat|rabbit|hamster))$/i;
  return {
    petName: getSectionValues(petFields, PET_LABELS, nameLabel, value =>
      value && value.length <= 80 && !/[\x00-\x1f\x7f]/.test(value) ? value : null),
    microchipId: getSectionValues(unownedText, MICROCHIP_LABELS, /^(?:micro[ \t-]?chip|MID)/i, value =>
      /^[0-9]{15}$/.test(value) ? value : null),
    avsLicenceNumber: getSectionValues(text, LICENCE_LABELS, /^(?:AVS[ \t]+)?licen[cs]/i, value =>
      value.length <= 50 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ? value : null)
  };
}

async function extractPdfText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Invalid PDF data');
  }

  const header = buffer.subarray(0, 1024).toString('latin1');
  if (!header.includes('%PDF-')) {
    throw new Error('Invalid PDF data');
  }

  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text || '';
  } finally {
    await parser.destroy();
  }
}

async function extractIdentifiers(buffer) {
  return extractIdentifiersFromText(await extractPdfText(buffer));
}

function layoutText(items, pageWidth) {
  const rows = [];
  for (const item of items) {
    if (typeof item.str !== 'string' || !item.str.trim()) continue;
    const [a, b, c, d, x, y] = item.transform;
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0 || d <= 0) {
      const isDecorative = (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) &&
        Math.hypot(c, d) >= 30 && item.width >= pageWidth * 0.5 &&
        !/\d/.test(item.str) &&
        !/\b(?:name|micro[\s-]?chip|mid|licen[cs](?:e|ee|ing)|pet|animal|owner|particulars|details|information|number|id)\b/i.test(item.str);
      if (isDecorative) continue;
      const error = new Error('Unsupported text orientation');
      error.code = 'PDF_LAYOUT_UNSUPPORTED';
      throw error;
    }
    let row = rows.find(candidate => Math.abs(candidate.y - y) < 2);
    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }
    row.items.push({ x, width: item.width, text: item.str });
  }
  rows.sort((a, b) => b.y - a.y);
  for (let index = 0; index + 1 < rows.length; index += 1) {
    const header = rows[index].items.slice().sort((a, b) => a.x - b.x);
    const values = rows[index + 1].items.slice().sort((a, b) => a.x - b.x);
    const isLabel = item => {
      const match = Array.from(item.text.matchAll(PET_LABELS));
      return match.length === 1 && match[0][0].trim() === item.text.trim();
    };
    if (header.length > 1 && header.every(isLabel)) {
      if (header.length !== values.length ||
          header.some((item, position) => Math.abs(item.x - values[position].x) > 10)) {
        const error = new Error('Ambiguous table alignment');
        error.code = 'PDF_LAYOUT_UNSUPPORTED';
        throw error;
      }
    }
  }
  return rows.map(row => {
    row.items.sort((a, b) => a.x - b.x);
    let text = '';
    let right = null;
    for (const item of row.items) {
      const gap = right === null ? 0 : item.x - right;
      if (right !== null && gap > 20) text += '\t';
      else if (right !== null && gap > 1 && !/\s$/.test(text) && !/^\s/.test(item.text)) text += ' ';
      text += item.text;
      right = item.x + item.width;
    }
    if (Array.from(text.matchAll(SECTION_PATTERN)).length > 1) {
      const error = new Error('Multiple sections on one row');
      error.code = 'PDF_LAYOUT_UNSUPPORTED';
      throw error;
    }
    return text;
  }).join('\n');
}

async function extractRegistrationFields(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 ||
      !buffer.subarray(0, 1024).toString('latin1').includes('%PDF-')) {
    throw new Error('Invalid PDF data');
  }
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    verbosity: pdfjs.VerbosityLevel.ERRORS
  });
  try {
    const document = await loadingTask.promise;
    if (!Number.isInteger(document.numPages) || document.numPages < 1 || document.numPages > 20) {
      const error = new Error('PDF page limit exceeded');
      error.code = 'PDF_PAGE_LIMIT';
      throw error;
    }
    const pages = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent();
        const text = layoutText(content.items, page.view[2] - page.view[0]);
        if (!text.trim()) {
          const error = new Error('PDF contains pages without extractable text');
          error.code = 'PDF_NO_TEXT';
          throw error;
        }
        pages.push(text);
      } finally {
        page.cleanup();
      }
    }
    return extractRegistrationFieldsFromText(pages.join('\n'));
  } finally {
    await loadingTask.destroy();
  }
}

module.exports = {
  extractIdentifiers,
  extractIdentifiersFromText,
  extractRegistrationFields,
  extractRegistrationFieldsFromText
};
