import { getDhruCompatibleMergedCatalog } from '../services/unifiedCatalogService';
import { prisma } from '../utils/prisma';

async function main() {
  console.log('Testing local getDhruCompatibleMergedCatalog for "server"...');
  try {
    const res = await getDhruCompatibleMergedCatalog(8.0, 'server');
    console.log('Success! Total groups:', res.groupsList.length, 'total services:', res.totalServices);
  } catch (err: any) {
    console.error('Failed getDhruCompatibleMergedCatalog server:', err);
  }

  console.log('Testing local getDhruCompatibleMergedCatalog for "all"...');
  try {
    const res = await getDhruCompatibleMergedCatalog(8.0, 'all');
    console.log('Success! Total groups:', res.groupsList.length, 'total services:', res.totalServices);
  } catch (err: any) {
    console.error('Failed getDhruCompatibleMergedCatalog all:', err);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
