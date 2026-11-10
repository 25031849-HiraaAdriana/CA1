(() => {
  const input = document.getElementById('medical-document');
  const preview = document.querySelector('[data-original-preview]');
  const image = document.querySelector('[data-preview-image]');
  const canvas = document.querySelector('[data-preview-canvas]');
  const controls = document.querySelector('[data-preview-controls]');
  const previous = document.querySelector('[data-preview-previous]');
  const next = document.querySelector('[data-preview-next]');
  const pageLabel = document.querySelector('[data-preview-page]');
  const open = document.querySelector('[data-preview-open]');
  const message = document.querySelector('[data-preview-message]');
  if (!input || !preview || !image || !canvas || !controls ||
      !previous || !next || !pageLabel || !open || !message) return;

  let url;
  let selection = 0;
  let pdf;
  let loadingTask;
  let renderTask;
  let pageNumber = 1;

  function reset() {
    selection += 1;
    if (renderTask) renderTask.cancel();
    renderTask = null;
    if (loadingTask) loadingTask.destroy().catch(error => console.error('PDF preview cleanup failed:', error));
    loadingTask = null;
    pdf = null;
    if (url) URL.revokeObjectURL(url);
    url = null;
    image.removeAttribute('src');
    open.removeAttribute('href');
    preview.hidden = image.hidden = canvas.hidden = controls.hidden = open.hidden = true;
  }

  function documentType(bytes) {
    const header = new TextDecoder('latin1').decode(bytes);
    if (header.includes('%PDF-')) return 'application/pdf';
    const png = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length >= 24 && png.every((value, index) => bytes[index] === value) &&
        String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR') return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    return null;
  }

  async function renderPage(number, currentSelection) {
    if (!pdf) return;
    if (renderTask) renderTask.cancel();
    const document = pdf;
    previous.disabled = next.disabled = true;
    try {
      const page = await document.getPage(number);
      if (currentSelection !== selection || pdf !== document) return;
      const natural = page.getViewport({ scale: 1 });
      const scale = Math.min(1.5, 1200 / natural.width, Math.sqrt(4000000 / (natural.width * natural.height)));
      const viewport = page.getViewport({ scale });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport });
      await renderTask.promise;
      if (currentSelection !== selection || pdf !== document) return;
      renderTask = null;
      pageNumber = number;
      canvas.hidden = false;
      preview.hidden = false;
      controls.hidden = document.numPages <= 1;
      pageLabel.textContent = `Page ${number} of ${document.numPages}`;
      previous.disabled = number <= 1;
      next.disabled = number >= document.numPages;
      message.textContent = 'Review the selected document before publishing.';
    } catch (error) {
      if (currentSelection !== selection || error.name === 'RenderingCancelledException') return;
      console.error('PDF page preview failed:', error);
      canvas.hidden = controls.hidden = true;
      message.textContent = 'The PDF could not be displayed here. Use Open Selected Document to review it in a new tab.';
    }
  }

  previous.addEventListener('click', () => renderPage(pageNumber - 1, selection));
  next.addEventListener('click', () => renderPage(pageNumber + 1, selection));
  image.addEventListener('error', () => {
    image.hidden = true;
    message.textContent = 'The image could not be displayed here. Use Open Selected Document to review it in a new tab.';
  });

  input.addEventListener('change', async () => {
    reset();
    const currentSelection = selection;
    const file = input.files[0];
    if (!file) {
      message.textContent = 'Choose a document to preview it locally.';
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      message.textContent = 'The selected file exceeds 10 MB.';
      return;
    }
    try {
      const bytes = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
      if (currentSelection !== selection) return;
      const type = documentType(bytes);
      if (!type) {
        message.textContent = 'The selected file is not a supported PDF, JPEG or PNG document.';
        return;
      }
      url = URL.createObjectURL(file.slice(0, file.size, type));
      open.href = url;
      open.hidden = false;
      if (type !== 'application/pdf') {
        image.src = url;
        image.hidden = false;
        preview.hidden = false;
        message.textContent = 'Review the selected document before publishing.';
        return;
      }
      message.textContent = 'Loading PDF preview...';
      const pdfjs = await import('/admin/medical-preview/pdf.mjs');
      if (currentSelection !== selection) return;
      pdfjs.GlobalWorkerOptions.workerSrc = '/admin/medical-preview/pdf.worker.mjs';
      const data = await file.arrayBuffer();
      if (currentSelection !== selection) return;
      const task = pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true });
      loadingTask = task;
      const document = await task.promise;
      if (currentSelection !== selection) return;
      pdf = document;
      await renderPage(1, currentSelection);
    } catch (error) {
      if (currentSelection !== selection) return;
      console.error('Document preview failed:', error);
      message.textContent = url
        ? 'The document could not be displayed here. Use Open Selected Document to review it in a new tab.'
        : 'The selected document could not be read. Choose it again.';
    }
  });
  window.addEventListener('pagehide', reset);
  window.addEventListener('pageshow', event => {
    if (event.persisted && input.files.length) input.dispatchEvent(new Event('change'));
  });
  input.form.addEventListener('submit', event => {
    if (event.defaultPrevented) return;
    const button = input.form.querySelector('button[name="action"][value="publish"]');
    if (button) {
      button.textContent = 'Publishing...';
      setTimeout(() => { button.disabled = true; }, 0);
    }
  });
})();
