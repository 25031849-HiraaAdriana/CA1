document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.querySelector('[data-pethub-nav-toggle]');
  const menu = document.querySelector('[data-pethub-nav-menu]');

  if (!toggle || !menu) return;

  function setMenuOpen(isOpen) {
    toggle.setAttribute('aria-expanded', String(isOpen));
    menu.classList.toggle('is-open', isOpen);
  }

  toggle.addEventListener('click', () => {
    setMenuOpen(toggle.getAttribute('aria-expanded') !== 'true');
  });

  document.addEventListener('click', event => {
    if (!event.target.closest('.portal-navbar')) setMenuOpen(false);
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      setMenuOpen(false);
      toggle.focus();
    }
  });

  menu.addEventListener('click', event => {
    if (event.target.closest('a') && window.matchMedia('(max-width: 760px)').matches) {
      setMenuOpen(false);
    }
  });

  window.matchMedia('(min-width: 761px)').addEventListener('change', () => setMenuOpen(false));
});
