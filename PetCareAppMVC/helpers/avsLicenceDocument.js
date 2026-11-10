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

async function extractIdentifiers(buffer) {
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
    return extractIdentifiersFromText(result.text || '');
  } finally {
    await parser.destroy();
  }
}

module.exports = {
  extractIdentifiers,
  extractIdentifiersFromText
};
