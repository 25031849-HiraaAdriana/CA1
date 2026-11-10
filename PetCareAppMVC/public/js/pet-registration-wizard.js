document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('[data-registration-wizard]');
  if (!form) return;

  const panels = Array.from(form.querySelectorAll('[data-wizard-step]'));
  const progressSteps = Array.from(document.querySelectorAll('[data-progress-step]'));
  const maximumStep = panels.length;
  let currentStep = Number(form.dataset.initialStep) || 1;

  function updateSpeciesFields() {
    const species = form.elements.namedItem('species').value;
    const licensed = species === 'Dog' || species === 'Cat';
    const other = ['Rabbit', 'Hamster', 'Guinea Pig'].includes(species);
    const choice = form.querySelector('[data-microchip-choice]');
    const radios = choice.querySelectorAll('input');
    const hasMicrochip = form.elements.namedItem('has_microchip').value === 'yes';
    choice.hidden = !other;
    radios.forEach(radio => {
      radio.disabled = !other;
      radio.required = other;
    });
    const microchip = form.elements.namedItem('microchip_id');
    const showMicrochip = licensed || (other && hasMicrochip);
    form.querySelector('[data-microchip-field]').hidden = !showMicrochip;
    microchip.disabled = !showMicrochip;
    microchip.required = showMicrochip;

    const licenceFields = form.querySelector('[data-licence-fields]');
    licenceFields.hidden = !licensed;
    licenceFields.querySelectorAll('input').forEach(input => {
      input.disabled = !licensed;
      input.required = licensed;
    });
  }

  function showStep(step) {
    currentStep = Math.min(Math.max(step, 1), maximumStep);
    panels.forEach(panel => {
      const isCurrent = Number(panel.dataset.wizardStep) === currentStep;
      panel.hidden = !isCurrent;
      panel.setAttribute('aria-hidden', String(!isCurrent));
    });

    progressSteps.forEach(item => {
      const stepNumber = Number(item.dataset.progressStep);
      item.classList.toggle('is-complete', stepNumber < currentStep);
      item.classList.toggle('is-current', stepNumber === currentStep);
      if (stepNumber === currentStep) {
        item.setAttribute('aria-current', 'step');
      } else {
        item.removeAttribute('aria-current');
      }
    });

    const heading = panels.find(panel => Number(panel.dataset.wizardStep) === currentStep)
      .querySelector('h2');
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function validateCurrentStep() {
    const panel = panels.find(item => Number(item.dataset.wizardStep) === currentStep);
    const invalidField = Array.from(panel.querySelectorAll('[required]'))
      .find(field => !field.checkValidity());

    if (invalidField) {
      invalidField.reportValidity();
      invalidField.focus();
      return false;
    }
    return true;
  }

  function updateSummary() {
    ['pet_name', 'species', 'breed'].forEach(name => {
      const field = form.elements.namedItem(name);
      const output = document.querySelector(`[data-summary="${name}"]`);
      if (field && output) output.textContent = field.value.trim() || 'Not entered';
    });

    const age = form.elements.namedItem('age');
    const ageOutput = document.querySelector('[data-summary="age"]');
    if (ageOutput) ageOutput.textContent = age.value ? `${age.value} years` : 'Not entered';

    const photo = form.elements.namedItem('pet_image');
    const photoOutput = document.querySelector('[data-summary="pet_image"]');
    if (photoOutput) photoOutput.textContent = photo.files.length ? photo.files[0].name : 'No photo selected';

    const microchip = form.elements.namedItem('microchip_id');
    const confirmation = document.querySelector('[data-confirmation-mid]');
    if (confirmation) confirmation.textContent = microchip.disabled
      ? 'Not provided'
      : microchip.value.trim() || 'Not entered yet';
  }

  form.addEventListener('click', event => {
    const next = event.target.closest('[data-next]');
    const back = event.target.closest('[data-back]');

    if (next) {
      if (validateCurrentStep()) showStep(currentStep + 1);
    } else if (back) {
      showStep(currentStep - 1);
    }
  });

  form.addEventListener('input', () => { updateSpeciesFields(); updateSummary(); });
  form.addEventListener('change', () => { updateSpeciesFields(); updateSummary(); });
  form.addEventListener('submit', event => {
    for (let step = 1; step <= 4; step += 1) {
      showStep(step);
      if (!validateCurrentStep()) {
        event.preventDefault();
        return;
      }
    }
  });

  updateSpeciesFields();
  updateSummary();
  showStep(currentStep);
});
