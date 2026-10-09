import { z } from 'zod';

export const createOrderSchema = z.object({
  serviceId: z.union([z.string(), z.number()]).transform(v => String(v).trim()),
  serviceName: z.string().min(1, 'اسم الخدمة مطلوب').max(255),
  targetInput: z.string().max(500).optional(),
  rawImei: z.string().max(500).optional(),
  quantity: z.union([z.number(), z.string()])
    .optional()
    .transform(val => {
      if (val === undefined || val === null || val === '') return 1;
      const num = parseInt(String(val), 10);
      return isNaN(num) || num < 1 ? 1 : num;
    }),
  notes: z.string().max(1000).optional(),
  couponCode: z.string().max(50).optional(),
  customFields: z.record(z.any()).optional()
});
