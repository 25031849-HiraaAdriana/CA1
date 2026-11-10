(() => {
  const canvas = document.getElementById('signaturePad');
  const hiddenInput = document.getElementById('signature-data-url');
  const form = canvas ? canvas.closest('form') : null;
  const clearButton = document.querySelector('[data-signature-clear]');
  const statusText = document.querySelector('[data-signature-status]');

  if (!canvas || !hiddenInput || !form) return;

  const context = canvas.getContext('2d');
  if (!context) return;

  let isDrawing = false;
  let lastPoint = null;

  function setStatus(message, isError = false) {
    if (!statusText) return;
    statusText.textContent = message;
    statusText.style.color = isError ? '#b42318' : '#2e4a62';
  }

  function drawLine(fromX, fromY, toX, toY) {
    context.lineWidth = 2.5;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#111827';
    context.beginPath();
    context.moveTo(fromX, fromY);
    context.lineTo(toX, toY);
    context.stroke();
  }

  function getCanvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;
    return { x, y };
  }

  function beginStroke(event) {
    event.preventDefault();
    isDrawing = true;
    const point = getCanvasPoint(event);
    lastPoint = point;
    context.beginPath();
    context.moveTo(point.x, point.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    setStatus('Signature captured…');
  }

  function continueStroke(event) {
    if (!isDrawing || !lastPoint) return;
    event.preventDefault();
    const point = getCanvasPoint(event);
    drawLine(lastPoint.x, lastPoint.y, point.x, point.y);
    lastPoint = point;
  }

  function endStroke(event) {
    if (!isDrawing) return;
    event.preventDefault();
    isDrawing = false;
    lastPoint = null;
    hiddenInput.value = canvas.toDataURL('image/png');
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let hasSignature = false;
    for (let index = 3; index < imageData.length; index += 4) {
      if (imageData[index] > 0) {
        hasSignature = true;
        break;
      }
    }
    setStatus(hasSignature ? 'Signature ready for review.' : 'Waiting for signature…');
  }

  function clearCanvas() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    hiddenInput.value = '';
    setStatus('Waiting for signature…');
  }

  canvas.addEventListener('pointerdown', beginStroke);
  canvas.addEventListener('pointermove', continueStroke);
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointerleave', endStroke);
  canvas.addEventListener('pointercancel', endStroke);

  clearButton.addEventListener('click', clearCanvas);

  form.addEventListener('submit', (event) => {
    const submitButton = form.querySelector('button[type="submit"][name="action"][value="publish"]');
    const isPublishAction = submitButton && !event.submitter ? true : event.submitter && event.submitter.value === 'publish';
    if (isPublishAction) {
      const isEmpty = !hiddenInput.value || hiddenInput.value === 'data:,';
      if (isEmpty) {
        event.preventDefault();
        setStatus('Please draw your signature before publishing.', true);
        return;
      }
    }
  });

  clearCanvas();
})();
