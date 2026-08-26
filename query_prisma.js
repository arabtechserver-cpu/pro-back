const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    const service = await prisma.dhruService.findUnique({
      where: { id: '08a37d70-7fc9-4430-82a8-be4c3391b267' }
    });
    console.log(JSON.stringify(service, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
