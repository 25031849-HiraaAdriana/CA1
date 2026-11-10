(() => {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  if (reduceMotion || !finePointer) return;

  document.querySelectorAll('[data-pomi-parallax]').forEach((visual) => {
    let frame = 0;
    let shiftX = 0;
    let shiftY = 0;

    visual.addEventListener('pointermove', (event) => {
      const bounds = visual.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width - 0.5;
      const y = (event.clientY - bounds.top) / bounds.height - 0.5;
      shiftX = `${(x * -9).toFixed(2)}px`;
      shiftY = `${(y * -7).toFixed(2)}px`;

      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        visual.style.setProperty('--pomi-shift-x', shiftX);
        visual.style.setProperty('--pomi-shift-y', shiftY);
        frame = 0;
      });
    });

    visual.addEventListener('pointerleave', () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      visual.style.setProperty('--pomi-shift-x', '0px');
      visual.style.setProperty('--pomi-shift-y', '0px');
    });
  });
})();
