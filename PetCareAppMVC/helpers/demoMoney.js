function formatDemoCents(cents) {
  const value = Number(cents);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid demo amount.');
  return `S$${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}

module.exports = { formatDemoCents };
