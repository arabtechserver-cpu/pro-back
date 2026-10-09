import { z } from 'zod';

export const createDepositTransactionSchema = z.object({
  amount: z.union([z.number(), z.string()])
    .transform(val => parseFloat(String(val)))
    .refine(val => !isNaN(val) && val > 0 && val <= 50000, {
      message: 'المبلغ يجب أن يكون رقماً موجباً وبحد أقصى 50,000'
    }),
  method: z.string().min(1, 'طريقة الدفع مطلوبة').max(100),
  refNo: z.string().min(1, 'رقم المعاملة أو المرجع مطلوب').max(120),
  receiptImage: z.string().min(10, 'صورة الإشعار أو الإيصال مطلوبة').max(15_000_000),
  type: z.string().max(100).optional()
});

export const createWalletRequestSchema = z.object({
  amount: z.union([z.number(), z.string()])
    .transform(val => parseFloat(String(val)))
    .refine(val => !isNaN(val) && val > 0 && val <= 50000, {
      message: 'المبلغ يجب أن يكون رقماً موجباً وبحد أقصى 50,000'
    }),
  type: z.string().max(100).optional()
});

export const approveTransactionSchema = z.object({
  transactionId: z.string().uuid('معرف العملية غير صالح')
});
