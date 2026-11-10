function medicalCategoryLabel(code, label) {
  return code === 'x_rays_imaging' ? 'Radiology Results (X-ray, CT, MRI)' : label;
}

module.exports = { medicalCategoryLabel };
