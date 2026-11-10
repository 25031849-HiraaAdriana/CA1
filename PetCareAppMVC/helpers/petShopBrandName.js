function displayPetShopBrandName(name) {
  return name === 'Vita Prima' ? 'SUNSEED' : name;
}

function storedPetShopBrandName(name) {
  return typeof name === 'string' && name.trim().toLowerCase() === 'sunseed'
    ? 'Vita Prima'
    : name;
}

module.exports = {
  displayPetShopBrandName,
  storedPetShopBrandName
};
