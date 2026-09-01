import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from "../utils/prisma";
import { sendTelegramPhotoNotification, sendTelegramAlert } from '../utils/telegramService';

const router = Router();

// Optional Customer Auth Middleware for AI chat
const optionalAuth = async (req: any, res: any, next: any) => {
  try {
    const authHeader = req.headers['authorization'];
    if (authHeader) {
      const token = authHeader.split(' ')[1];
      if (token) {
        const decoded: any = jwt.verify(token, process.env.JWT_SECRET || 'your_super_strong_secret_key_here');
        if (decoded && decoded.id) {
          req.user = decoded;
        }
      }
    }
  } catch (e) {
    // Guest user
  }
  next();
};

const SYSTEM_PROMPT = `
أنت "المساعد الذكي للدعم الفني وخدمة العملاء والتفاوض" لمنصة "عرب تك برو سيرفر - Arab Tech Pro Server" (arabtechproserver.tech).
أنت تتحدث بأسلوب بشري ذكي، لبق، متفهم، هادئ، واحترافي جداً.

قواعدك الأساسية في الحوار:
1. **الاستماع والنقاش البناء والترحيب**:
   - تفاعل مع العميل بود واحترام.
   - إذا كان العميل غاضباً أو يشتكي من خسارة أو منافسة أو أسعار: تفهم موقفه فوراً، وأكد له أن Arab Tech Pro Server شريك داعم للتجار والفنيين، واعرض عليه تقديم باقات خاصة للتجار والموزعين (VIP Wholesale)، وأسعار خاصة عبر الـ API وخصومات الشحن.
2. **حل المشاكل التقنية وتتبع الطلبات واسترجاع الرصيد**:
   - إذا اشتكى العميل من تأخر طلب أو كود: اسأله بلطف عن رقم الطلب (Order ID) أو افحص طلباته عبر الأدوات المتاحة، وطمئنه بأن سياسة السيرفر تضمن استرجاع الرصيد 100% لمحفظته في حال وجود أي مشكلة.
3. **رفع التذاكر وإشعار الإدارة فورياً على تيليجرام (submit_complaint)**:
   - عندما يطلب العميل رفع شكوى رسمية أو تسجيل تذكرة لإدارة السيرفر، أو عندما يقدم تفاصيل مشكلة واضحة، استدعِ أداة 'submit_complaint'.
   - بعد رفع التذكرة، أخبر العميل برقم التذكرة الناتج وطمئنه أن التذكرة والتفاصيل أُرسلت فوراً إلى إدارة السيرفر عبر تيليجرام وسيتواصلون معه.
4. **بيانات المنصة الرسمية**:
   - اسم الموقع: عرب تك برو سيرفر (Arab Tech Pro Server).
   - الدومين الرسمي: https://arabtechproserver.tech
   - المطور والمدير: Mina Samir.
   - واتساب الدعم: https://wa.me/16728972935
   - تيليجرام الدعم: @ARABTECHSUPPURT2
   - البريد الرسمي: arabtechserver@gmail.com
   - عملة رصيد المحفظة في الموقع هي الدولار الأمريكي (USD) فقط. لا تذكر الريال أو أي عملة أخرى عند الحديث عن الرصيد أو الأسعار.
   - عند سؤال العميل عن رصيده أو طلباته، استخدم الأدوات المتاحة للتحقق من بيانات حسابه بدل التخمين.
`.trim();

const tools = [
  {
    type: "function",
    function: {
      name: "submit_complaint",
      description: "Create a support ticket / complaint in the database and dispatch an instant priority alert directly to the administration team on Telegram.",
      parameters: {
        type: "object",
        required: ["subject", "details"],
        properties: {
          subject: { type: "string", description: "Brief title or summary of the issue/complaint" },
          details: { type: "string", description: "Comprehensive description of the customer problem or request" },
          order_id: { type: "string", description: "Order ID if related to a specific order (optional)" },
          customer_name: { type: "string", description: "Customer name or username" },
          customer_phone: { type: "string", description: "Customer phone or WhatsApp number" },
          customer_email: { type: "string", description: "Customer email address" },
          category: { type: "string", description: "Category of issue (e.g. استرجاع رصيد / شكوى تجارية / تأخر تنفيذ / كود لا يعمل / شحن محفظة / استفسار عام)" },
          urgency: { type: "string", enum: ["عادية", "متوسطة", "عاجلة"], description: "Urgency level" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_customer_overview",
      description: "Get the authenticated customer's profile, wallet balance, and recent orders.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_wallet_balance",
      description: "Get the current wallet balance of the user.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_latest_orders",
      description: "Get the 5 most recent orders for the user.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "search_services",
      description: "Search available IMEI and Server services by keyword.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search keyword (e.g., 'Xiaomi', 'Samsung', 'Borneo', 'Bypass')"
          }
        },
        required: ["query"]
      }
    }
  }
];

// Helper to format order status in Arabic
function formatOrderStatus(status: string) {
  const labels: Record<string, string> = {
    pending: 'قيد الانتظار ⏳',
    processing: 'قيد التنفيذ 🚀',
    completed: 'مكتمل ✅',
    rejected: 'مرفوض ❌',
    cancelled: 'ملغي ⚠️',
    canceled: 'ملغي ⚠️',
    refunded: 'تم استرجاع الرصيد 💰'
  };
  return labels[String(status || '').toLowerCase()] || status || 'غير محدد';
}

// Tool Execution Logic
async function executeToolCall(toolCall: any, userId?: string, guestInfo: any = {}) {
  const name = toolCall.function.name;
  let args: any = {};

  try {
    if (toolCall.function.arguments) {
      args = typeof toolCall.function.arguments === 'string' ? JSON.parse(toolCall.function.arguments) : toolCall.function.arguments;
    }
  } catch (e) {
    console.error('[AI Tool] JSON parse error:', e);
  }

  try {
    if (name === 'submit_complaint') {
      const subject = String(args.subject || '').trim();
      const details = String(args.details || '').trim();
      if (!subject || !details) return { error: 'Subject and details are required' };

      const orderId = args.order_id || null;
      const category = args.category || 'دعم فني وشكاوى';
      const urgency = args.urgency || 'متوسطة';

      let customerName = args.customer_name || guestInfo.name || 'عميل الموقع';
      let customerEmail = args.customer_email || guestInfo.email || '';
      let customerPhone = args.customer_phone || guestInfo.phone || '';

      if (userId) {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (user) {
          customerName = user.fullName || user.username || customerName;
          customerEmail = user.email || customerEmail;
        }
      }

      const ticketId = `TICK-${Date.now().toString().slice(-6)}`;

      // Send Instant Telegram Notification to Admins with Interactive Action Buttons
      const tgMsg = 
        `🚨 <b>تذكرة دعم فني / شكوى جديدة #${ticketId}</b> 🚨\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>العميل:</b> ${customerName}\n` +
        (customerEmail ? `📧 <b>البريد:</b> <code>${customerEmail}</code>\n` : '') +
        (customerPhone ? `📱 <b>الهاتف:</b> <code>${customerPhone}</code>\n` : '') +
        (orderId ? `📦 <b>رقم الطلب:</b> <code>#${orderId}</code>\n` : '') +
        `🏷️ <b>القسم:</b> <b>${category}</b>\n` +
        `⚡ <b>الأولوية:</b> <b>${urgency}</b>\n\n` +
        `📝 <b>عنوان التذكرة:</b>\n<b>${subject}</b>\n\n` +
        `📄 <b>التفاصيل:</b>\n${details}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🤖 <i>تم الاستلام والإرسال فورياً عبر المساعد الذكي AI</i>`;

      const replyMarkup = {
        inline_keyboard: [
          customerPhone ? [{ text: "📱 فتح محادثة واتساب مع العميل", url: `https://wa.me/${customerPhone.replace(/[^0-9]/g, '')}` }] : [],
          customerEmail ? [{ text: "📧 إرسال إيميل للعميل", url: `mailto:${customerEmail}` }] : []
        ].filter(r => r.length > 0)
      };

      console.log(`[AI Complaint] Dispatching Ticket #${ticketId} to Telegram admins...`);
      await sendTelegramPhotoNotification({ caption: tgMsg, replyMarkup }).catch(err => {
        console.error('[AI Complaint Telegram Error]:', err);
      });

      return {
        success: true,
        ticket_id: ticketId,
        message: `تم تسجيل تذكرة الدعم بنجاح برقم #${ticketId} وتم إرسال الإشعار والتفاصيل كاملة للإدارة على تيليجرام فورياً.`
      };
    }

    if (name === 'get_customer_overview') {
      if (!userId) return { customer: null, orders: [], note: 'العميل غير مسجل الدخول' };
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, fullName: true, username: true, balance: true, role: true }
      });
      const orders = await prisma.order.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 5
      });
      return { customer: user, orders };
    }

    if (name === 'get_wallet_balance') {
      if (!userId) return { balance: 0, note: 'العميل غير مسجل الدخول' };
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { balance: true }
      });
      return { balance: user?.balance || 0 };
    }

    if (name === 'get_latest_orders') {
      if (!userId) return { orders: [], note: 'العميل غير مسجل الدخول' };
      const orders = await prisma.order.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 5
      });
      return { orders };
    }

    if (name === 'search_services') {
      const query = String(args.query || '').toLowerCase().trim();
      if (!query) return { results: [] };

      // Search Dhru services in Prisma
      const services = await prisma.dhruService.findMany({
        where: {
          OR: [
            { name: { contains: query, mode: 'insensitive' } },
            { groupName: { contains: query, mode: 'insensitive' } },
            { originalName: { contains: query, mode: 'insensitive' } }
          ],
          isActive: true
        },
        take: 6
      });

      return {
        results: services.map(s => ({
          id: s.dhruId,
          name: s.name,
          price: `$${Number(s.credit + (s.margin || 0)).toFixed(2)} USD`,
          time: s.time || 'فوري',
          group: s.groupName,
          url: `https://arabtechproserver.tech/pricing?search=${encodeURIComponent(s.name)}`
        }))
      };
    }
  } catch (e: any) {
    console.error(`[AI Tool Error] ${name}:`, e.message);
    return { error: 'Failed to execute tool' };
  }

  return { error: 'Tool not found' };
}

// Smart Local Fallback (Knowledge-backed)
async function buildLocalReply(message: string, userId?: string, guestInfo: any = {}) {
  const text = String(message || '').trim();
  const normalized = text.toLowerCase();

  // 1. Merchant VIP / Grievances / Wholesale
  if (/تنافس|بتنافس|خسرت|تخسرني|خصرت|عملاء|منافسة|جملة|تاجر|موزع/.test(normalized)) {
    return `أهلاً بك يا غالي ويسعدنا جداً سماع وجهة نظرك وتفهم موقفك تماماً! 🤝\n\nنحن في **عرب تك برو سيرفر (Arab Tech Pro Server)** هدفنا الأول ليس منافسة زملائنا التجار أو أصحاب المحلات، بل بالعكس نحن نوفر أسعار جملة وسيرفرات API مباشرة لتمكين التجار والفنيين من تحقيق أعلى هامش ربح وخدمة عملائهم بأسرع وقت وبأقل تكلفة.\n\nيسعدنا فتح **حساب تاجر / موزع VIP** لك بأسعار مخصصة وأعلى نسبة خصم! يمكنك التواصل مع الإدارة مباشرة عبر واتساب: https://wa.me/16728972935 أو تيليجرام: @ARABTECHSUPPURT2.`;
  }

  // 2. Complaint or Ticket Request (Comprehensive match)
  if (/شكوى|شكوه|اشتكي|أشتكي|مشكلة|مشكله|تأخر|تأخير|معلق|تذكرة|تذكره|تظلم|كود غلط|مش شغال|ما وصل|طلب رقم/.test(normalized)) {
    const toolRes = await executeToolCall({
      function: {
        name: 'submit_complaint',
        arguments: JSON.stringify({
          subject: text.slice(0, 80),
          details: text,
          customer_name: guestInfo.name,
          customer_phone: guestInfo.phone,
          customer_email: guestInfo.email,
          category: 'شكاوى ودعم فني'
        })
      }
    }, userId, guestInfo);

    if (toolRes && toolRes.success) {
      return `✅ تم رفع تذكرتك بنجاح برقم **#${toolRes.ticket_id}**.\n\n📲 **تم إرسال كافة التفاصيل فوراً إلى إدارة السيرفر على تيليجرام**.\nفريق الدعم الفني والإدارة سيقومون بمتابعتها والرد عليك في أقرب وقت. يمكنك أيضاً مراسلة الإدارة مباشرة على تيليجرام: @ARABTECHSUPPURT2 أو واتساب: https://wa.me/16728972935`;
    }
  }

  // 3. Delays / Refunds / Wallet balance refund
  if (/استرجاع|استرداد|فلوس|refund/.test(normalized)) {
    return `حقك محفوظ تماماً وسياسة الموقع تضمن رد الرصيد 100% لمحفظتك في حال تأخر أو تعذر تنفيذ أي طلب! 🛡️\n\nفضلاً زودني برقم الطلب (Order ID) لفحصه وتحديث حالته، أو لإلغائه وإعادة الرصيد إلى محفظتك مباشرة.`;
  }

  // 4. Contacts
  if (/تواصل|واتس|واتساب|تلجرام|تيليجرام|رقمكم|contact|الدعم/.test(normalized)) {
    return `قنوات التواصل الرسمية لخدمة العملاء:\n• واتساب: https://wa.me/16728972935\n• تيليجرام الدعم الفني: @ARABTECHSUPPURT2\n• البريد الرسمي: arabtechserver@gmail.com`;
  }

  // 5. Wallet balance
  if (/رصيد|محفظ|balance|wallet/.test(normalized)) {
    if (!userId) return 'لعرض رصيدك والشحن، يرجى تسجيل الدخول: https://arabtechproserver.tech/login';
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { balance: true } });
    return `رصيد محفظتك الحالي: **$${Number(user?.balance || 0).toFixed(2)} USD**\nيمكنك شحن المحفظة من هنا: https://arabtechproserver.tech/dashboard/wallet`;
  }

  // 6. Search Services
  const searchRes = await executeToolCall({
    function: { name: 'search_services', arguments: JSON.stringify({ query: normalized }) }
  }, userId);

  if (searchRes?.results?.length) {
    const list = searchRes.results.slice(0, 5).map((s: any) => `• **${s.name}** — ${s.price} (${s.time})\n  🔗 [طلب الخدمة](${s.url})`).join('\n');
    return `وجدت هذه الخدمات المتاحة في السيرفر:\n\n${list}`;
  }

  return `أهلاً بك في المساعد الذكي لمنصة **عرب تك برو سيرفر - Arab Tech Pro Server**! 🤖\n\nأنا هنا لمساعدتك في الاستفسار عن أسعار وخدمات السيرفر، فحص حالة الطلبات، أو رفع تذكرة مباشرة لإدارة الموقع على تيليجرام.\n\nكيف يمكنني مساعدتك اليوم؟`;
}

// Call OpenRouter API
async function callOpenRouter(messages: any[]) {
  const apiKey = process.env.OPENROUTER_API_KEY || '';
  const model = process.env.OPENROUTER_MODEL || 'openrouter/free';

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://arabtechproserver.tech',
      'X-Title': 'Arab Tech Pro Server'
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      tools,
      tool_choice: 'auto'
    })
  });

  if (!response.ok) {
    throw new Error(`OpenRouter returned status ${response.status}`);
  }

  return await response.json();
}

/**
 * POST /api/ai/chat
 */
router.post('/chat', optionalAuth, async (req: any, res: any) => {
  try {
    const { message, history, guest_name, guest_email, guest_phone } = req.body;
    const userId = req.user?.id;
    const guestInfo = { name: guest_name, email: guest_email, phone: guest_phone };

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const isComplaintIntent = /شكوى|شكوه|اشتكي|أشتكي|مشكلة|مشكله|تأخر|تأخير|معلق|تذكرة|تذكره|تظلم|نصب|خسارة|حقوق|استرجاع|استرداد|مش شغال|ما وصل|كود غلط/i.test(message);

    let conversation = Array.isArray(history) ? [...history] : [];
    conversation.push({ role: 'user', content: message });

    // Try OpenRouter AI
    try {
      const completion: any = await callOpenRouter(conversation);
      const choice = completion?.choices?.[0];

      if (choice?.message?.tool_calls?.length) {
        const toolCall = choice.message.tool_calls[0];
        const toolResult = await executeToolCall(toolCall, userId, guestInfo);

        // Follow up with tool result
        conversation.push(choice.message);
        conversation.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: JSON.stringify(toolResult)
        });

        const followUp: any = await callOpenRouter(conversation);
        const content = followUp?.choices?.[0]?.message?.content?.trim();
        const finalReply = content || toolResult.message || (toolResult.ticket_id ? `✅ تم تسجيل تذكرتك بنجاح برقم #${toolResult.ticket_id} وتم إرسال الإشعار والتفاصيل كاملة للإدارة على تيليجرام فورياً.` : 'تم تنفيذ العملية بنجاح.');
        return res.json({ reply: finalReply, history: [...conversation, { role: 'assistant', content: finalReply }] });
      }

      if (choice?.message?.content) {
        let replyText = choice.message.content;

        // Proactive Safety Guarantee: If user reported a complaint and LLM replied with text only, dispatch Telegram ticket automatically!
        if (isComplaintIntent) {
          const autoTicket = await executeToolCall({
            function: {
              name: 'submit_complaint',
              arguments: JSON.stringify({
                subject: message.slice(0, 80),
                details: message,
                customer_name: guestInfo.name,
                customer_phone: guestInfo.phone,
                customer_email: guestInfo.email,
                category: 'شكاوى ودعم فني'
              })
            }
          }, userId, guestInfo);

          if (autoTicket && autoTicket.ticket_id) {
            replyText += `\n\n---\n✅ **تم تسجيل شكواك رسمياً برقم تذكرة:** \`#${autoTicket.ticket_id}\`\n📲 **تم إرسال إشعار فوري وتفصيلي لإدارة السيرفر على تيليجرام** لمتابعتها والرد عليك.`;
          }
        }

        return res.json({
          reply: replyText,
          history: [...conversation, { role: 'assistant', content: replyText }]
        });
      }
    } catch (llmErr: any) {
      console.warn('[AI Route] LLM fallback activated:', llmErr.message);
    }

    // Smart Local Fallback
    const localReply = await buildLocalReply(message, userId, guestInfo);
    return res.json({
      reply: localReply,
      history: [...conversation, { role: 'assistant', content: localReply }]
    });
  } catch (error: any) {
    console.error('[AI Chat Error]:', error);
    return res.status(500).json({ error: 'Failed to process AI chat request' });
  }
});

/**
 * GET /api/ai/suggestions
 */
router.get('/suggestions', (req, res) => {
  res.json({
    suggestions: [
      "ما هي أسعار تفعيل Borneo Schematics؟",
      "كيف أقوم بشحن رصيد محفظتي؟",
      "أريد أسعار باقات التجار والموزعين VIP",
      "أريد فتح تذكرة دعم فني أو شكوى للإدارة",
      "ما هي شروط وسياسة استرجاع الرصيد؟"
    ]
  });
});

export default router;
