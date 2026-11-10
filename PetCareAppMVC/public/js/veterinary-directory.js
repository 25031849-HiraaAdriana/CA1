(function () {
  if (typeof document === 'undefined') return;

  document.addEventListener('DOMContentLoaded', () => {
    const directory = document.querySelector('.veterinary-directory-page');
    if (!directory) return;

    const cards = Array.from(directory.querySelectorAll('[data-clinic-card]'));
    const sections = Array.from(directory.querySelectorAll('[data-clinic-category-section]'));
    let activeRegion = 'all';
    let activeService = 'all';

    function applyFilters() {
      cards.forEach(card => {
        const matchesRegion = activeRegion === 'all' || card.dataset.region === activeRegion;
        const matchesService = activeService === 'all' || card.dataset.category === activeService;
        card.hidden = !matchesRegion || !matchesService;
      });
      sections.forEach(section => {
        section.hidden = !Array.from(section.querySelectorAll('[data-clinic-card]'))
          .some(card => !card.hidden);
      });
    }

    directory.querySelectorAll('[data-region-filter]').forEach(button => {
      button.addEventListener('click', () => {
        activeRegion = button.dataset.regionFilter;
        directory.querySelectorAll('[data-region-filter]').forEach(filter => {
          const selected = filter === button;
          filter.classList.toggle('is-selected', selected);
          filter.setAttribute('aria-pressed', String(selected));
        });
        applyFilters();
      });
    });

    directory.querySelectorAll('[data-service-filter]').forEach(button => {
      button.addEventListener('click', () => {
        activeService = button.dataset.serviceFilter;
        directory.querySelectorAll('[data-service-filter]').forEach(filter => {
          const selected = filter === button;
          filter.classList.toggle('is-selected', selected);
          filter.setAttribute('aria-pressed', String(selected));
        });
        applyFilters();
      });
    });
  });
})();
