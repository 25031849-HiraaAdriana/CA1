const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function createPreview() {
  const elements = {};
  function element() {
    return {
      hidden: true, listeners: {}, attributes: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
      removeAttribute(name) { delete this.attributes[name]; delete this[name]; }
    };
  }
  const input = element();
  input.files = [];
  input.form = { addEventListener() {}, querySelector() { return null; } };
  for (const name of ['original-preview', 'preview-image', 'preview-canvas', 'preview-controls',
    'preview-previous', 'preview-next', 'preview-page', 'preview-open', 'preview-message']) {
    elements[`[data-${name}]`] = element();
  }
  const revoked = [];
  let nextUrl = 0;
  const context = {
    document: {
      getElementById: () => input,
      querySelector: name => elements[name]
    },
    window: { addEventListener() {} },
    URL: {
      createObjectURL(blob) { elements.lastBlob = blob; return `blob:test-${++nextUrl}`; },
      revokeObjectURL(url) { revoked.push(url); }
    },
    TextDecoder, Uint8Array, console: { error() {} },
    Event, setTimeout
  };
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin-medical-upload.js'), 'utf8');
  vm.runInNewContext(script, context);
  return { input, elements, revoked };
}

function file(bytes, size = bytes.length) {
  return {
    size,
    slice(start, end, type) {
      const selected = bytes.subarray(start, end);
      return {
        type,
        arrayBuffer: async () => Uint8Array.from(selected).buffer
      };
    }
  };
}

test('local preview supports PNG and JPEG, replaces and revokes URLs, and rejects invalid or oversized files', async () => {
  const { input, elements, revoked } = createPreview();
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
  input.files = [file(png)];
  await input.listeners.change();
  assert.equal(elements['[data-preview-image]'].src, 'blob:test-1');
  assert.equal(elements['[data-preview-image]'].hidden, false);
  assert.equal(elements['[data-preview-open]'].href, 'blob:test-1');
  assert.equal(elements.lastBlob.type, 'image/png');

  input.files = [file(Buffer.from('ffd8ff00', 'hex'))];
  await input.listeners.change();
  assert.deepEqual(revoked, ['blob:test-1']);
  assert.equal(elements['[data-preview-image]'].src, 'blob:test-2');
  assert.equal(elements.lastBlob.type, 'image/jpeg');

  input.files = [file(Buffer.from('<html>'))];
  await input.listeners.change();
  assert.equal(elements['[data-preview-open]'].hidden, true);
  assert.match(elements['[data-preview-message]'].textContent, /not a supported/i);
  assert.deepEqual(revoked, ['blob:test-1', 'blob:test-2']);

  input.files = [file(png, 10 * 1024 * 1024 + 1)];
  await input.listeners.change();
  assert.match(elements['[data-preview-message]'].textContent, /exceeds 10 MB/i);
  assert.equal(elements['[data-preview-open]'].hidden, true);
});

test('PDF preview failure retains a safely typed local new-tab fallback', async () => {
  const { input, elements } = createPreview();
  input.files = [file(Buffer.from('%PDF-1.7\nsample'))];
  await input.listeners.change();
  assert.equal(elements.lastBlob.type, 'application/pdf');
  assert.equal(elements['[data-preview-open]'].href, 'blob:test-1');
  assert.equal(elements['[data-preview-open]'].hidden, false);
  assert.match(elements['[data-preview-message]'].textContent, /Open Selected Document/);
});

test('a slower previous selection cannot replace the current preview', async () => {
  const { input, elements } = createPreview();
  let resolveHeader;
  const slow = {
    size: 20,
    slice() { return { arrayBuffer: () => new Promise(resolve => { resolveHeader = resolve; }) }; }
  };
  input.files = [slow];
  const pending = input.listeners.change();
  input.files = [file(Buffer.from('ffd8ff00', 'hex'))];
  await input.listeners.change();
  resolveHeader(Uint8Array.from(Buffer.from('%PDF-1.7')).buffer);
  await pending;
  assert.equal(elements.lastBlob.type, 'image/jpeg');
  assert.equal(elements['[data-preview-image]'].src, 'blob:test-1');
});

test('open link uses a separate tab without an opener', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', 'views', 'adminMedicalRecords.ejs'), 'utf8');
  assert.match(template, /<a[^>]*data-preview-open[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
});
