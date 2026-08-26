const axios = require('axios');
const FormData = require('form-data');

async function testUpload() {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8520796422:AAEwT2cu1NU4IGdYjjxh627zC8cen01rftE';
  const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
  const chatId = '7457813524'; // Using dummy or a known one, it will fail with "chat not found" if fake, but if it passes format validation, we know buffer logic is fine.

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
