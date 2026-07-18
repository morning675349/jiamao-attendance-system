require('dotenv').config();

// 未接住的例外會讓 Node process 悄悄當掉，PM2 若短時間內重試多次會放棄重啟
// 這裡先記錄再乾淨地結束，讓 PM2 用正常流程重啟一次
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('💥 Unhandled Rejection:', err);
  process.exit(1);
});

const express = require('express');
const line = require('@line/bot-sdk');
const path = require('path');
const { handleEvent } = require('./linebot');

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || ''
};

const hasLineConfig = lineConfig.channelAccessToken && lineConfig.channelSecret;

// LINE Webhook（必須在 express.json() 之前，需要 raw body 驗章）
if (hasLineConfig) {
  app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
    try {
      await Promise.all(req.body.events.map(handleEvent));
      res.json({ status: 'ok' });
    } catch (err) {
      console.error('Webhook error:', err);
      res.status(500).end();
    }
  });
} else {
  console.warn('⚠️  LINE Bot 未設定（請複製 .env.example 為 .env 並填入憑證）');
  app.post('/webhook', express.json(), (req, res) => res.json({ status: 'line_not_configured' }));
}

app.use(express.json({ limit: '6mb' }));

// 這個路由必須在 apiRouter 之前，否則被 auth middleware 攔截
app.get('/api/liff-id', (req, res) => res.json({ liffId: process.env.LIFF_ID || null }));

const apiRouter = require('./routes/api');
app.use('/api', apiRouter);

const payrollRouter = require('./routes/payroll');
app.use('/api/payroll', payrollRouter);

// 動態注入 LIFF ID 到打卡頁面
const fs = require('fs');
app.get('/punch', (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'punch.html'), 'utf8');
  res.send(html.replace('{{LIFF_ID}}', process.env.LIFF_ID || ''));
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/admin.html'));

// 全域錯誤處理（必須放在所有路由之後）：
// 避免未被路由內 try/catch 接住的例外，被 Express 預設錯誤頁印出完整 stack trace 給前端
app.use((err, req, res, next) => {
  console.error('Unhandled route error:', err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: '伺服器發生錯誤，請稍後再試' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 打卡系統已啟動`);
  console.log(`🌐 管理後台：http://localhost:${PORT}/admin.html`);
  console.log(`💰 薪資系統：http://localhost:${PORT}/payroll.html`);
  console.log(`📡 LINE Webhook：http://localhost:${PORT}/webhook`);
  if (!hasLineConfig) console.log(`⚠️  LINE Bot 未設定，僅管理後台可用\n`);
});

// 用餐統計定時推播（每日 10:00 中午用餐統計）
if (hasLineConfig) require('./scheduler').start();
