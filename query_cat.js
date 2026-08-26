const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    const category = await prisma.dhruCategory.findUnique({
      where: { id: 'ca278155-9929-4fe7-b6db-04672bb63e1d' }
    });
    console.log("Category:", category);
  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
