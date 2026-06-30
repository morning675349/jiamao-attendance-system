require('dotenv').config();
const line = require('@line/bot-sdk');

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN || 'placeholder';

const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: token });
// 下載使用者傳來的圖片內容（請假證明）用
const blobClient = new line.messagingApi.MessagingApiBlobClient({ channelAccessToken: token });

module.exports = client;
module.exports.blobClient = blobClient;
