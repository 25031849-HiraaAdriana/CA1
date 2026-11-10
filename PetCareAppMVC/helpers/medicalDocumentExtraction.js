const { loadImage } = require('@napi-rs/canvas');
const { PDFParse } = require('pdf-parse');
const { createWorker } = require('tesseract.js');
const englishLanguage = require('@tesseract.js-data/eng');

const MAX_IMAGE_DIMENSION = 10000;
const MAX_IMAGE_PIXELS = 40000000;
const MAX_PDF_PAGES = 50;
const MAX_OCR_PDF_PAGES = 10;

class InvalidMedicalDocumentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidMedicalDocumentError';
  }
}

function detectDocumentMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;

  const pdfHeader = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('latin1');
  if (pdfHeader.includes('%PDF-')) return 'application/pdf';

  if (
    buffer.length >= 24 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    buffer.toString('ascii', 12, 16) === 'IHDR'
  ) {
    return 'image/png';
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  return null;
}

function getJpegDimensions(buffer) {
  let offset = 2;
  const frameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
  ]);

  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return null;

    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > buffer.length) return null;

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;

    if (frameMarkers.has(marker)) {
      if (segmentLength < 7) return null;
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5)
      };
    }

    offset += segmentLength;
  }

  return null;
}

function getImageDimensions(buffer, mimeType) {
  if (mimeType === 'image/png') {
    if (buffer.length < 24) return null;
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    };
  }

  if (mimeType === 'image/jpeg') return getJpegDimensions(buffer);
  return null;
}

function hasMeaningfulText(text) {
  const normalized = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  const letters = normalized.match(/\p{L}/gu) || [];
  const lettersAndNumbers = normalized.match(/[\p{L}\p{N}]/gu) || [];
  return letters.length >= 2 && lettersAndNumbers.length >= 5;
}

function normalizeText(text) {
  return typeof text === 'string'
    ? text.replace(/\0/g, '').replace(/\r\n/g, '\n').trim()
    : '';
}

async function validateImage(buffer, mimeType) {
  if (mimeType === 'image/png') {
    let offset = 8;
    let hasImageData = false;
    let complete = false;
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      if (length > buffer.length - offset - 12) break;
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      if (type === 'IDAT') hasImageData = true;
      offset += length + 12;
      if (type === 'IEND') {
        complete = length === 0 && offset === buffer.length && hasImageData;
        break;
      }
    }
    if (!complete) throw new InvalidMedicalDocumentError('The uploaded image is malformed or incomplete.');
  } else if (mimeType === 'image/jpeg' &&
      (buffer.length < 4 || buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9)) {
    throw new InvalidMedicalDocumentError('The uploaded image is malformed or incomplete.');
  }
  const dimensions = getImageDimensions(buffer, mimeType);
  if (
    !dimensions ||
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    dimensions.width > MAX_IMAGE_DIMENSION ||
    dimensions.height > MAX_IMAGE_DIMENSION ||
    dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
  ) {
    throw new InvalidMedicalDocumentError('The image is malformed or exceeds safe image dimensions.');
  }

  let image;
  try {
    image = await loadImage(buffer);
  } catch {
    throw new InvalidMedicalDocumentError('The uploaded image is malformed or cannot be decoded.');
  }

  if (image.width !== dimensions.width || image.height !== dimensions.height) {
    throw new InvalidMedicalDocumentError('The uploaded image dimensions are inconsistent.');
  }
}

async function createOcrWorker() {
  return createWorker('eng', 1, {
    langPath: englishLanguage.langPath,
    gzip: englishLanguage.gzip,
    logger: () => {}
  });
}

async function extractImageText(buffer, mimeType) {
  await validateImage(buffer, mimeType);

  let worker;
  try {
    worker = await createOcrWorker();
    const result = await worker.recognize(buffer);
    const text = normalizeText(result.data.text);

    return {
      extractionStatus: hasMeaningfulText(text) ? 'successful' : 'failed_review_needed',
      text: text || null
    };
  } catch {
    return {
      extractionStatus: 'failed_review_needed',
      text: null
    };
  } finally {
    if (worker) await worker.terminate();
  }
}

function validatePdfStructure(buffer) {
  if (buffer.length < 16 || !buffer.includes(Buffer.from('%%EOF'))) {
    throw new InvalidMedicalDocumentError('The uploaded PDF appears incomplete or malformed.');
  }
}

async function validateMedicalDocument(buffer, mimeType) {
  if (mimeType === 'image/jpeg' || mimeType === 'image/png') {
    return validateImage(buffer, mimeType);
  }
  if (mimeType !== 'application/pdf') {
    throw new InvalidMedicalDocumentError('Only PDF, JPEG and PNG documents are supported.');
  }
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new InvalidMedicalDocumentError('The PDF header must be at the beginning of the file.');
  }
  validatePdfStructure(buffer);
  const parser = new PDFParse({ data: buffer });
  try {
    let info;
    try {
      info = await parser.getInfo();
    } catch {
      throw new InvalidMedicalDocumentError('The uploaded PDF is malformed or cannot be read.');
    }
    if (!Number.isInteger(info.total) || info.total < 1 || info.total > MAX_PDF_PAGES) {
      throw new InvalidMedicalDocumentError(`The uploaded PDF must contain between 1 and ${MAX_PDF_PAGES} readable pages.`);
    }
  } finally {
    await parser.destroy();
  }
}

async function extractPdfText(buffer) {
  validatePdfStructure(buffer);

  const parser = new PDFParse({ data: buffer });
  try {
    let info;
    try {
      info = await parser.getInfo();
    } catch {
      throw new InvalidMedicalDocumentError('The uploaded PDF is malformed or cannot be read.');
    }

    if (!Number.isInteger(info.total) || info.total < 1) {
      throw new InvalidMedicalDocumentError('The uploaded PDF does not contain readable pages.');
    }

    if (info.total > MAX_PDF_PAGES) {
      return {
        extractionStatus: 'failed_review_needed',
        text: null
      };
    }

    let textResult;
    try {
      textResult = await parser.getText({ lineEnforce: true });
    } catch {
      throw new InvalidMedicalDocumentError('The uploaded PDF is malformed or cannot be read.');
    }

    const pageTexts = new Map(
      textResult.pages.map(page => [page.num, normalizeText(page.text)])
    );

    const pagesNeedingOcr = [];
    for (let pageNumber = 1; pageNumber <= info.total; pageNumber += 1) {
      if (!hasMeaningfulText(pageTexts.get(pageNumber))) {
        pagesNeedingOcr.push(pageNumber);
      }
    }

    let ocrComplete = true;
    if (pagesNeedingOcr.length > 0) {
      if (pagesNeedingOcr.length > MAX_OCR_PDF_PAGES) {
        ocrComplete = false;
      } else {
        try {
          const screenshots = await parser.getScreenshot({
            partial: pagesNeedingOcr,
            scale: 2,
            imageBuffer: true,
            imageDataUrl: false
          });
          const screenshotByPage = new Map(screenshots.pages.map(page => [page.pageNumber, page]));
          const worker = await createOcrWorker();

          try {
            for (const pageNumber of pagesNeedingOcr) {
              const screenshot = screenshotByPage.get(pageNumber);
              if (!screenshot || !screenshot.data) {
                ocrComplete = false;
                continue;
              }

              const result = await worker.recognize(Buffer.from(screenshot.data));
              const extractedText = normalizeText(result.data.text);
              if (hasMeaningfulText(extractedText)) {
                pageTexts.set(pageNumber, extractedText);
              } else {
                ocrComplete = false;
              }
            }
          } finally {
            await worker.terminate();
          }
        } catch {
          ocrComplete = false;
        }
      }
    }

    const extractedPages = [];
    for (let pageNumber = 1; pageNumber <= info.total; pageNumber += 1) {
      const pageText = pageTexts.get(pageNumber);
      if (hasMeaningfulText(pageText)) {
        extractedPages.push(`Page ${pageNumber}\n${pageText}`);
      } else {
        ocrComplete = false;
      }
    }

    const text = extractedPages.join('\n\n');
    return {
      extractionStatus: ocrComplete && hasMeaningfulText(text)
        ? 'successful'
        : 'failed_review_needed',
      text: text || null
    };
  } finally {
    await parser.destroy();
  }
}

async function extractMedicalDocumentText(buffer, mimeType) {
  if (mimeType === 'application/pdf') return extractPdfText(buffer);
  if (mimeType === 'image/jpeg' || mimeType === 'image/png') {
    return extractImageText(buffer, mimeType);
  }
  throw new InvalidMedicalDocumentError('Only PDF, JPEG and PNG documents are supported.');
}

module.exports = {
  InvalidMedicalDocumentError,
  detectDocumentMimeType,
  validateMedicalDocument,
  extractMedicalDocumentText,
  hasMeaningfulText
};
