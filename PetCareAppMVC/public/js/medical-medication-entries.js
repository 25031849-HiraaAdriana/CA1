(function () {
  const categorySelect = document.querySelector('[data-medication-category]');
  const section = document.querySelector('[data-medication-section]');
  const rows = document.querySelector('[data-medication-entry-rows]');
  const rowTemplate = document.querySelector('[data-medication-entry-template]');
  const addButton = document.querySelector('[data-add-medication]');
  if (!categorySelect || !section || !rows || !rowTemplate || !addButton) return;

  function updateVisibility() {
    section.hidden = categorySelect.value !== 'medication_history';
  }

  function updateRowIds(row, index) {
    row.querySelectorAll('input').forEach(input => {
      const field = input.name.replace(/\[\]$/, '');
      input.id = `${field}-${index}`;
      const label = row.querySelector(`label[for^="${field}-"]`);
      if (label) label.htmlFor = input.id;
    });
  }

  categorySelect.addEventListener('change', updateVisibility);
  addButton.addEventListener('click', () => {
    if (rows.querySelectorAll('[data-medication-entry-row]').length >= 10) return;
    const fragment = rowTemplate.content.cloneNode(true);
    const row = fragment.querySelector('.medication-entry-row');
    row.dataset.medicationEntryRow = '';
    updateRowIds(row, rows.querySelectorAll('[data-medication-entry-row]').length);
    rows.append(fragment);
  });

  rows.addEventListener('click', event => {
    const removeButton = event.target.closest('[data-remove-medication]');
    if (!removeButton) return;
    const row = removeButton.closest('[data-medication-entry-row]');
    if (row) row.remove();
  });

  rows.querySelectorAll('.medication-entry-row').forEach((row, index) => {
    row.dataset.medicationEntryRow = '';
    updateRowIds(row, index);
  });
  updateVisibility();
})();
