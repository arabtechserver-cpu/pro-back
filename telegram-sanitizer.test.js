const assert = require('assert');
const { sanitizeTelegramHtml, stripHtml } = require('./dist/utils/telegramService');

console.log('Testing sanitizeTelegramHtml and stripHtml...');

// 1. Exact issue from user: Unsupported start tag "br/"
const inputWithBr = 'تم اكتمال طلبك بنجاح\nرقم الطلب: #82ede0\nالخدمة: Pubg Mobile 60 UC<br/>الكود: 12345-ABCDE<br />الرد: تم الشحن بنجاح';
const sanitizedBr = sanitizeTelegramHtml(inputWithBr);
console.log('Sanitized output for <br/>:\n', sanitizedBr);
assert.strictEqual(sanitizedBr.includes('<br'), false, 'Must not contain any <br tags');
assert.strictEqual(sanitizedBr.includes('12345-ABCDE'), true, 'Must preserve code text');
assert.strictEqual(sanitizedBr.includes('\nالكود: 12345-ABCDE\nالرد:'), true, 'Must turn <br/> into newlines');

// 2. Unsupported HTML tags like <div>, <p>, <span>, <font>
const inputWithUnsupported = '<div class="card"><p><b>تنبيه هام</b></p><span>محتوى عادي</span><font color="red">خط أحمر</font></div>';
const sanitizedUnsupported = sanitizeTelegramHtml(inputWithUnsupported);
console.log('Sanitized output for unsupported tags:\n', sanitizedUnsupported);
assert.strictEqual(sanitizedUnsupported.includes('<div'), false);
assert.strictEqual(sanitizedUnsupported.includes('<p'), false);
assert.strictEqual(sanitizedUnsupported.includes('<font'), false);
assert.strictEqual(sanitizedUnsupported.includes('<b>تنبيه هام</b>'), true);
assert.strictEqual(sanitizedUnsupported.includes('محتوى عادي'), true);
assert.strictEqual(sanitizedUnsupported.includes('خط أحمر'), true);

// 3. Supported tags: <b>, <i>, <code>, <pre>, <a>, <tg-spoiler>
const inputSupported = '<b>عريض</b> <i>مائل</i> <code>كود</code> <a href="https://example.com">رابط</a> <span class="tg-spoiler">حرق</span>';
const sanitizedSupported = sanitizeTelegramHtml(inputSupported);
console.log('Sanitized output for supported tags:\n', sanitizedSupported);
assert.strictEqual(sanitizedSupported.includes('<b>عريض</b>'), true);
assert.strictEqual(sanitizedSupported.includes('<i>مائل</i>'), true);
assert.strictEqual(sanitizedSupported.includes('<code>كود</code>'), true);
assert.strictEqual(sanitizedSupported.includes('<a href="https://example.com">رابط</a>'), true);
assert.strictEqual(sanitizedSupported.includes('<tg-spoiler>حرق</tg-spoiler>'), true);

// 4. Stray characters: &, <, > outside of valid tags
const inputStray = 'Amount < 50 & Discount > 10% &amp; AlreadyEscaped';
const sanitizedStray = sanitizeTelegramHtml(inputStray);
console.log('Sanitized output for stray chars:\n', sanitizedStray);
assert.strictEqual(sanitizedStray.includes('&lt;'), true, 'Stray < must be &lt;');
assert.strictEqual(sanitizedStray.includes('&gt;'), true, 'Stray > must be &gt;');
assert.strictEqual(sanitizedStray.includes('&amp;'), true, 'Stray & must be &amp;');
assert.strictEqual(sanitizedStray.includes('&amp;amp;'), false, 'Must not double escape already escaped entities');

// 5. Unclosed tags auto-closing
const inputUnclosed = '<b>طلب جديد <i>جاري المعالجة';
const sanitizedUnclosed = sanitizeTelegramHtml(inputUnclosed);
console.log('Sanitized output for unclosed tags:\n', sanitizedUnclosed);
assert.strictEqual(sanitizedUnclosed.endsWith('</i></b>'), true, 'Must automatically close unclosed tags in reverse order');

// 6. stripHtml converts line breaks and decodes entities
const inputPlain = '<b>سطر 1</b><br/>سطر 2 &amp; سطر 3';
const stripped = stripHtml(inputPlain);
console.log('Stripped plain text:\n', stripped);
assert.strictEqual(stripped.includes('<'), false);
assert.strictEqual(stripped, 'سطر 1\nسطر 2 & سطر 3');

console.log('ALL TELEGRAM SANITIZER TESTS PASSED SUCCESSFULLY!');
