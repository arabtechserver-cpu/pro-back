const axios = require('axios');
const FormData = require('form-data');

async function testUpload() {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN is required in environment variables');
    process.exit(1);
  }
  const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || '7457813524';

  try {
    const base64Data = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAGBAQABAAAA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAAPwA=";
    const buffer = Buffer.from(base64Data, 'base64');
    
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', 'Test caption');
    form.append('photo', buffer, { filename: 'receipt.jpg', contentType: 'image/jpeg' });

    console.log("Sending...");
    await axios.post(`${TELEGRAM_API_URL}/sendPhoto`, form, {
      headers: form.getHeaders()
    });
    console.log("Success!");
  } catch (error) {
    console.error(error.response ? error.response.data : error.message);
  }
}

testUpload();
