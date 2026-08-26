require('ts-node').register();
const { sendTelegramPhotoNotification, addAdminChatId } = require('./src/utils/telegramService');
const fs = require('fs');

async function test() {
  // Add a test chat ID if needed (replace with a real one to see it on your end, but here we just want to see if it throws)
  addAdminChatId('7457813524'); // dummy
  
  try {
    const base64Image = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAGBAQABAAAA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAAPwA=";
    await sendTelegramPhotoNotification({
      imageSource: base64Image,
      caption: 'Test Image from Script'
    });
    console.log("Done");
  } catch (err) {
    console.error(err);
  }
}

test();
