import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const service = await prisma.dhruService.findUnique({
    where: { id: '08a37d70-7fc9-4430-82a8-be4c3391b267' }
  });
  console.log(JSON.stringify(service, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
