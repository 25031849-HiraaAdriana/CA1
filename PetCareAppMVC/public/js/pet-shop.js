(() => {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const revealItems = document.querySelectorAll('.shop-reveal');

  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealItems.forEach(item => item.classList.add('is-visible'));
  } else {
    const revealObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -35px 0px' });
    revealItems.forEach(item => revealObserver.observe(item));
  }

  const hero = document.querySelector('.shop-hero');
  const heroImage = hero?.querySelector('.shop-hero-photo img');
  if (heroImage) {
    heroImage.addEventListener('error', () => {
      heroImage.src = '/images/pethub-cat.jpg';
    }, { once: true });
  }

  const productCategory = document.querySelector('#productCategory');
  const prescriptionControl = document.querySelector('[data-prescription-control]');
  const prescriptionFallback = document.querySelector('[data-prescription-fallback]');
  if (productCategory && prescriptionControl && prescriptionFallback) {
    const updatePrescriptionControl = () => {
      const selectedCategory = productCategory.selectedOptions[0];
      const isMedicalCategory = selectedCategory?.dataset.categoryCode === 'animal-medical-healthcare';
      prescriptionControl.hidden = !isMedicalCategory;
      prescriptionFallback.disabled = isMedicalCategory;
    };
    productCategory.addEventListener('change', updatePrescriptionControl);
    updatePrescriptionControl();
  }

  const ageSuitability = document.querySelector('[data-age-suitability]');
  const ageRangeFields = document.querySelectorAll('[data-age-range-field]');
  if (ageSuitability && ageRangeFields.length) {
    const updateAgeRangeFields = () => {
      const ageIsRestricted = ageSuitability.value === 'range';
      ageRangeFields.forEach(field => {
        field.hidden = !ageIsRestricted;
        const input = field.querySelector('input');
        if (input) input.disabled = !ageIsRestricted;
      });
    };
    ageSuitability.addEventListener('change', updateAgeRangeFields);
    updateAgeRangeFields();
  }

  const storefrontPlacement = document.querySelector('[data-storefront-placement]');
  const trustedBrandSelect = document.querySelector('[data-trusted-brand]');
  const productBrandInput = document.querySelector('[data-product-brand]');
  if (storefrontPlacement && trustedBrandSelect) {
    const updateTrustedBrands = () => {
      const expectedGroup = {
        trusted_cats_dogs: 'cats_dogs',
        trusted_small_furries: 'small_furries'
      }[storefrontPlacement.value];
      trustedBrandSelect.disabled = !expectedGroup;
      Array.from(trustedBrandSelect.options).forEach(option => {
        if (!option.dataset.brandGroup) return;
        const matches = option.dataset.brandGroup === expectedGroup;
        option.hidden = !matches;
        option.disabled = !matches;
        if (!matches && option.selected) trustedBrandSelect.value = '';
      });
    };
    storefrontPlacement.addEventListener('change', updateTrustedBrands);
    trustedBrandSelect.addEventListener('change', () => {
      if (productBrandInput && trustedBrandSelect.value) {
        productBrandInput.value = trustedBrandSelect.value;
      }
    });
    updateTrustedBrands();
  }

  document.querySelectorAll('[data-logo-image]').forEach(image => {
    const showLogo = () => {
      image.hidden = false;
      const fallback = image.parentElement?.querySelector('[data-logo-fallback]');
      if (fallback) fallback.hidden = true;
    };
    if (image.complete && image.naturalWidth > 0) showLogo();
    else image.addEventListener('load', showLogo, { once: true });
    image.addEventListener('error', () => {
      image.hidden = true;
      const fallback = image.parentElement?.querySelector('[data-logo-fallback]');
      if (fallback) fallback.hidden = false;
    }, { once: true });
  });

  const imageUpload = document.querySelector('[data-product-image-upload]');
  const imagePreview = document.querySelector('[data-product-image-preview]');
  if (imageUpload && imagePreview) {
    let previewUrls = [];
    imageUpload.addEventListener('change', () => {
      previewUrls.forEach(url => URL.revokeObjectURL(url));
      previewUrls = [];
      imagePreview.replaceChildren();
      Array.from(imageUpload.files || []).forEach(file => {
        if (!file.type.startsWith('image/')) return;
        const url = URL.createObjectURL(file);
        previewUrls.push(url);
        const figure = document.createElement('figure');
        const image = document.createElement('img');
        const caption = document.createElement('figcaption');
        image.src = url;
        image.alt = '';
        caption.textContent = file.name;
        figure.append(image, caption);
        imagePreview.append(figure);
      });
    });
  }

  if (hero && !reduceMotion && window.matchMedia('(pointer: fine)').matches) {
    let frame = 0;
    let pointerX = 0;
    let pointerY = 0;
    hero.addEventListener('pointermove', event => {
      pointerX = (event.clientX / window.innerWidth - 0.5) * 12;
      pointerY = (event.clientY / window.innerHeight - 0.5) * 9;
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        const image = hero.querySelector('.shop-hero-photo img');
        if (image) image.style.transform = `scale(1.02) translate3d(${pointerX}px, ${pointerY}px, 0)`;
        frame = 0;
      });
    });
    hero.addEventListener('pointerleave', () => {
      const image = hero.querySelector('.shop-hero-photo img');
      if (image) image.style.transform = '';
    });
  }

  document.querySelectorAll('[data-gallery-image]').forEach(button => {
    button.addEventListener('click', () => {
      const image = document.querySelector('[data-gallery-main]');
      if (!image) return;
      image.src = button.dataset.galleryImage;
      image.alt = button.dataset.galleryAlt || '';
      document.querySelectorAll('[data-gallery-image]').forEach(item => item.classList.remove('is-selected'));
      button.classList.add('is-selected');
    });
  });

  document.querySelectorAll('[data-quantity-step]').forEach(button => {
    button.addEventListener('click', () => {
      const input = button.closest('.shop-quantity-control')?.querySelector('input');
      if (!input || input.readOnly) return;
      const min = Number(input.min) || 1;
      const max = Number(input.max) || 99;
      const current = Number(input.value) || min;
      input.value = String(Math.max(min, Math.min(max, current + Number(button.dataset.quantityStep))));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });

  document.querySelectorAll('.shop-category-photo img, .shop-editorial-image img, .shop-collection-banner img').forEach(image => {
    image.addEventListener('error', () => {
      image.closest('.shop-category-photo, .shop-editorial-image, .shop-collection-banner')?.classList.add('is-image-unavailable');
      image.remove();
    }, { once: true });
  });
})();
