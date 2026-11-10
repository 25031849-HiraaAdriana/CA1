document.addEventListener('DOMContentLoaded', () => {
  const body = document.body;
  const sidebar = document.querySelector('#pomiAdminSidebar');
  const openButton = document.querySelector('[data-admin-open]');
  const closeButton = document.querySelector('[data-admin-close]');
  const overlay = document.querySelector('[data-admin-overlay]');
  const collapseButton = document.querySelector('[data-admin-collapse]');

  if (!sidebar || !openButton || !closeButton || !overlay || !collapseButton) return;

  const mobileQuery = window.matchMedia('(max-width: 900px)');

  function closeDrawer(returnFocus = false) {
    body.classList.remove('pomi-admin-drawer-open');
    openButton.setAttribute('aria-expanded', 'false');
    if (returnFocus) openButton.focus();
  }

  openButton.addEventListener('click', () => {
    body.classList.add('pomi-admin-drawer-open');
    openButton.setAttribute('aria-expanded', 'true');
    const firstLink = sidebar.querySelector('.pomi-admin-link');
    if (firstLink) firstLink.focus();
  });

  closeButton.addEventListener('click', () => closeDrawer(true));
  overlay.addEventListener('click', () => closeDrawer(true));
  sidebar.querySelectorAll('.pomi-admin-link, .pomi-admin-logout').forEach(link => {
    link.addEventListener('click', () => closeDrawer());
  });

  collapseButton.addEventListener('click', () => {
    const collapsed = body.classList.toggle('pomi-admin-collapsed');
    collapseButton.setAttribute('aria-expanded', String(!collapsed));
    collapseButton.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    collapseButton.querySelector('.pomi-admin-collapse-label').textContent =
      collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && body.classList.contains('pomi-admin-drawer-open')) {
      closeDrawer(true);
    }
  });

  mobileQuery.addEventListener('change', event => {
    closeDrawer();
    body.classList.remove('pomi-admin-collapsed');
    collapseButton.setAttribute('aria-expanded', 'true');
    collapseButton.setAttribute('aria-label', 'Collapse sidebar');
    collapseButton.querySelector('.pomi-admin-collapse-label').textContent = 'Collapse sidebar';
  });
});
