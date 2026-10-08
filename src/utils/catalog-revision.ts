let revision = 0;

export function getCatalogRevision(): number { return revision; }
export function invalidateCatalogRevision(): void { revision++; }
