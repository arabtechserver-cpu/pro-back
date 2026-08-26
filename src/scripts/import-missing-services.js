/**
 * import-missing-services.js
 * يُضيف الخدمات الغائبة من backup إلى Prisma DhruService
 */
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();
const BACKUP_PATH = path.join(__dirname, '../../../full-database-2026-08-23T22-51-59-524Z.json');

async function run() {
  console.log('🔄 استيراد الخدمات الناقصة من backup...\n');

  const raw = fs.readFileSync(BACKUP_PATH, 'utf-8');
  const backup = JSON.parse(raw);
  const services = backup.tables?.services || [];
  const categories = backup.tables?.categories || [];

  // الخدمات المحتاجة استيراد (لديها select+options لكن غير موجودة في Prisma)
  const missingNames = ['CDMA YEMEN Team - Tool', 'Router Code'];
  const targets = services.filter(s => missingNames.some(n => s.name.includes(n)));

  console.log(`🎯 خدمات للاستيراد: ${targets.length}`);
  for (const t of targets) console.log(`   - ${t.name}`);
  console.log('');

  // تأكد من وجود categories في Prisma
  const existingCats = await prisma.dhruCategory.findMany();
  let serverCat = existingCats.find(c => c.name === 'Server Service');
  if (!serverCat) {
    serverCat = await prisma.dhruCategory.create({ data: { name: 'Server Service' } });
    console.log('✅ أضفت فئة Server Service');
  }

  let imported = 0;
  for (const svc of targets) {
    // parse fields وبناء requiresCustom
    let requiresCustom = null;
    if (svc.fields && svc.fields !== '[]') {
      try {
        const fields = JSON.parse(svc.fields);
        const customObj = {};
        for (const field of fields) {
          if (field.adminonly) continue;
          const key = field.api_name || field.field_id || field.label;
          customObj[key] = {
            reqid: field.field_id || key,
            fieldname: field.name || `custom_${key}`,
            fieldtype: field.type || 'text',
            required: field.required ? '1' : '0',
            description: '',
            fieldoptions: (field.options || []).join('\n'),
            label: field.label || key,
          };
        }
        requiresCustom = JSON.stringify(customObj);
      } catch {}
    }

    // تحقق هل موجود أصلاً
    const exists = await prisma.dhruService.findFirst({
      where: { name: { contains: svc.name.slice(0, 20) } }
    });
    if (exists) {
      console.log(`⏭️  موجود بالفعل: "${svc.name}"`);
      continue;
    }

    // ابحث عن category المناسب في Prisma
    let catId = serverCat.id; // default Server
    const backupCat = categories.find(c => c.id == svc.category_id);
    if (backupCat) {
      const matchedCat = existingCats.find(c =>
        c.name.toLowerCase().includes(backupCat.name?.toLowerCase()?.split(' ')[0] || '__')
      );
      if (matchedCat) catId = matchedCat.id;
    }

    // أضف للـ Prisma
    const fakeId = `backup_${svc.id || Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await prisma.dhruService.create({
      data: {
        dhruId: fakeId,
        name: svc.name,
        originalName: svc.name,
        groupName: backupCat?.name || 'Imported',
        credit: parseFloat(svc.price || '0'),
        time: svc.api_delivery_time || '',
        info: svc.description || '',
        categoryId: catId,
        requiresCustom,
        isActive: true,
        margin: 0,
      }
    });

    console.log(`✅ تم استيراد: "${svc.name}"`);
    if (requiresCustom) {
      const obj = JSON.parse(requiresCustom);
      for (const [k, v] of Object.entries(obj)) {
        if (v.fieldtype === 'select' && v.fieldoptions) {
          console.log(`   → ${k}: [${v.fieldoptions.replace(/\n/g, ', ')}]`);
        }
      }
    }
    imported++;
  }

  console.log(`\n🎉 انتهى! تم استيراد ${imported} خدمة جديدة.`);
  await prisma.$disconnect();
}

run().catch(e => {
  console.error('❌', e.message);
  process.exit(1);
});
