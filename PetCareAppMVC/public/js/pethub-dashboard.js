document.addEventListener('DOMContentLoaded', () => {
  const dashboard = document.querySelector('.dashboard-page');
  if (!dashboard || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const hero = dashboard.querySelector('.dashboard-hero');
  if (hero) hero.classList.add('dashboard-enter');

  dashboard.querySelectorAll('.passport-card').forEach((card, index) => {
    card.style.setProperty('--card-delay', `${Math.min(index * 70, 350)}ms`);
    card.classList.add('dashboard-card-enter');
  });

  if (!('IntersectionObserver' in window)) return;

  const revealTargets = dashboard.querySelectorAll('[data-dashboard-reveal]');
  if (revealTargets.length === 0) return;

  const observer = new IntersectionObserver((entries, currentObserver) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      currentObserver.unobserve(entry.target);
    });
  }, {
    rootMargin: '0px 0px -48px 0px',
    threshold: 0.12
  });

  revealTargets.forEach(target => {
    target.classList.add('dashboard-reveal');
    observer.observe(target);
  });
});
