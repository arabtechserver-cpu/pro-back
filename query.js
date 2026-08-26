const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const srvs = await prisma.dhruService.findMany({
    where: { name: { contains: 'Samsung Canada' } }
  });
  console.log(srvs);
}
main();
