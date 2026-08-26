/**
 * migrate-fields-options.js
 * يُحدّث requiresCustom في SQLite للخدمات التي لديها select fields بـ options
 */
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();
const BACKUP_PATH = path.join(__dirname, '../../../full-database-2026-08-23T22-51-59-524Z.json');

async function run() {
  console.log('🔄 بدء تحديث حقول الـ options...\n');

  if (!fs.existsSync(BACKUP_PATH)) {
    console.error('❌ ملف الـ backup غير موجود:', BACKUP_PATH);
    process.exit(1);
  }

  const raw = fs.readFileSync(BACKUP_PATH, 'utf-8');
  const backup = JSON.parse(raw);
  const services = backup.tables?.services || [];

  // فلتر الخدمات ذات حقول select+options
  const targets = [];
  for (const svc of services) {
    if (!svc.fields || svc.fields === '[]' || svc.fields === '') continue;
    try {
      const fields = JSON.parse(svc.fields);
      const selectFields = fields.filter(f => f.type === 'select' && Array.isArray(f.options) && f.options.length > 0);
      if (selectFields.length > 0) {
        targets.push({ name: svc.name, fields });
      }
    } catch {}
  }

  console.log(`🎯 خدمات محتاجة تحديث: ${targets.length}`);
  for (const t of targets) {
    console.log(`   📌 ${t.name}`);
    for (const f of t.fields.filter(x => x.type === 'select' && x.options?.length > 0)) {
      console.log(`      → ${f.label}: [${f.options.join(', ')}]`);
    }
  }
  console.log('');

  let updated = 0;
  let notFound = 0;

  for (const target of targets) {
    // ابحث بالاسم (partial match)
    const candidates = await prisma.dhruService.findMany({
      where: { name: { contains: target.name } }
    });

    if (candidates.length === 0) {
      console.log(`⚠️  لم يُوجد في Prisma: "${target.name}"`);
      notFound++;
      continue;
    }

    for (const svc of candidates) {
      // parse الـ requiresCustom الحالي
      let current = {};
      if (svc.requiresCustom) {
        try { current = JSON.parse(svc.requiresCustom); } catch {}
      }

      // حدّث/أضف كل حقل من الـ backup
      for (const field of target.fields) {
        if (field.adminonly) continue;
        const key = field.api_name || field.field_id || field.label;

        current[key] = {
          reqid: field.field_id || key,
          fieldname: field.name || `custom_${key}`,
          fieldtype: field.type || 'text',
          required: field.required ? '1' : '0',
          description: '',
          // الـ options كـ string مفصولة بـ \n (format Dhru API)
          fieldoptions: (field.options || []).join('\n'),
          label: field.label || key,
        };
      }

      await prisma.dhruService.update({
        where: { id: svc.id },
        data: { requiresCustom: JSON.stringify(current) }
      });

      console.log(`✅ "${svc.name}" → تم تحديث requiresCustom`);
      updated++;
    }
  }

  console.log(`\n🎉 انتهى! تم تحديث ${updated} خدمة، لم يُوجد ${notFound}.`);
  await prisma.$disconnect();
}

run().catch(e => {
  console.error('❌', e.message);
  process.exit(1);
});
