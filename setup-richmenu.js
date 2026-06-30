#!/usr/bin/env node
/**
 * 自動建立 LINE 圖文選單（6 格 3x2）
 * 執行：node setup-richmenu.js
 */
require('dotenv').config();
const https = require('https');

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LIFF_ID = process.env.LIFF_ID;

if (!TOKEN || TOKEN.includes('待填入')) {
  console.error('❌ 請先設定 .env 的 LINE_CHANNEL_ACCESS_TOKEN');
  process.exit(1);
}
if (!LIFF_ID) {
  console.error('❌ 請先設定 .env 的 LIFF_ID');
  process.exit(1);
}

// ── SVG 設計（2500x1686 / 3x2 格）─────────────────────
function buildSVG() {
  // Column centers
  const cx = [416, 1250, 2083];
  // Row 1: icon center y=278, Row 2: icon center y=1121
  const iconY = [278, 1121];
  const titleY = [538, 1381];
  const subtY  = [634, 1477];
  const accentY= [728, 1571];

  function sunIcon(x, y) {
    const r = 68, ir = 90, or = 112;
    const rays = [0,45,90,135,180,225,270,315].map(deg => {
      const rad = deg * Math.PI / 180;
      const x1 = Math.round(x + ir * Math.sin(rad));
      const y1 = Math.round(y - ir * Math.cos(rad));
      const x2 = Math.round(x + or * Math.sin(rad));
      const y2 = Math.round(y - or * Math.cos(rad));
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    }).join('');
    return `
      <circle cx="${x}" cy="${y}" r="${r}" fill="rgba(255,255,255,0.92)"/>
      <g stroke="rgba(255,255,255,0.88)" stroke-width="14" stroke-linecap="round">${rays}</g>`;
  }

  function moonIcon(x, y) {
    const dx = x - 1250, dy = y - 278;
    return `
      <path d="M${1210+dx} ${182+dy} Q${1328+dx} ${210+dy} ${1328+dx} ${278+dy}
               Q${1328+dx} ${346+dy} ${1210+dx} ${374+dy}
               Q${1336+dx} ${382+dy} ${1390+dx} ${302+dy}
               Q${1436+dx} ${225+dy} ${1390+dx} ${198+dy}
               Q${1336+dx} ${174+dy} ${1210+dx} ${182+dy} Z"
            fill="rgba(255,255,255,0.92)"/>
      <circle cx="${1372+dx}" cy="${192+dy}" r="14" fill="rgba(255,255,255,0.82)"/>
      <circle cx="${1412+dx}" cy="${245+dy}" r="9"  fill="rgba(255,255,255,0.62)"/>
      <circle cx="${1388+dx}" cy="${168+dy}" r="7"  fill="rgba(255,255,255,0.52)"/>`;
  }

  function bellIcon(x, y) {
    return `
      <rect x="${x-57}" y="${y-28}" width="54" height="66" rx="8" fill="rgba(255,255,255,0.92)"/>
      <path d="M${x-3} ${y-28} L${x+78} ${y-82} L${x+78} ${y+82} L${x-3} ${y+28} Z"
            fill="rgba(255,255,255,0.92)"/>
      <path d="M${x+80} ${y-56} Q${x+118} ${y-28} ${x+118} ${y} Q${x+118} ${y+28} ${x+80} ${y+56}"
            stroke="rgba(255,255,255,0.82)" stroke-width="13" fill="none" stroke-linecap="round"/>
      <path d="M${x+90} ${y-80} Q${x+145} ${y-40} ${x+145} ${y} Q${x+145} ${y+40} ${x+90} ${y+80}"
            stroke="rgba(255,255,255,0.58)" stroke-width="11" fill="none" stroke-linecap="round"/>
      <rect x="${x-42}" y="${y+38}" width="24" height="24" rx="5" fill="rgba(255,255,255,0.7)"/>`;
  }

  function docIcon(x, y) {
    return `
      <rect x="${x-68}" y="${y-80}" width="136" height="162" rx="12" fill="rgba(255,255,255,0.92)"/>
      <rect x="${x-68}" y="${y-80}" width="136" height="38" rx="10" fill="rgba(255,255,255,0)"/>
      <rect x="${x-68}" y="${y-80}" width="136" height="38" rx="8" fill="rgba(234,88,12,0.38)"/>
      <rect x="${x-52}" y="${y-26}" width="104" height="12" rx="4" fill="rgba(234,88,12,0.55)"/>
      <rect x="${x-52}" y="${y}  " width="104" height="12" rx="4" fill="rgba(234,88,12,0.48)"/>
      <rect x="${x-52}" y="${y+26}" width="78" height="12" rx="4" fill="rgba(234,88,12,0.32)"/>
      <circle cx="${x+46}" cy="${y+62}" r="22" fill="#EA580C"/>
      <path d="M${x+35} ${y+62} L${x+43} ${y+70} L${x+57} ${y+54}"
            stroke="white" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  }

  function clockIcon(x, y) {
    return `
      <circle cx="${x}" cy="${y}" r="82" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="15"/>
      <circle cx="${x}" cy="${y}" r="9" fill="rgba(255,255,255,0.92)"/>
      <line x1="${x}" y1="${y}" x2="${x}" y2="${y-58}"
            stroke="rgba(255,255,255,0.92)" stroke-width="14" stroke-linecap="round"/>
      <line x1="${x}" y1="${y}" x2="${x+50}" y2="${y+28}"
            stroke="rgba(255,255,255,0.92)" stroke-width="14" stroke-linecap="round"/>
      <circle cx="${x+68}" cy="${y-68}" r="30" fill="#9333EA" stroke="rgba(255,255,255,0.88)" stroke-width="6"/>
      <text x="${x+68}" y="${y-58}" font-family="Arial,sans-serif" font-size="36" font-weight="bold"
            text-anchor="middle" dominant-baseline="middle" fill="white">?</text>`;
  }

  function chartIcon(x, y) {
    const base = y + 68;
    return `
      <rect x="${x-92}" y="${base-64}" width="42" height="64" rx="5" fill="rgba(255,255,255,0.88)"/>
      <rect x="${x-42}" y="${base-108}" width="42" height="108" rx="5" fill="rgba(255,255,255,0.88)"/>
      <rect x="${x+8}" y="${base-150}" width="42" height="150" rx="5" fill="rgba(255,255,255,0.88)"/>
      <rect x="${x+58}" y="${base-124}" width="42" height="124" rx="5" fill="rgba(255,255,255,0.88)"/>
      <line x1="${x-108}" y1="${base}" x2="${x+118}" y2="${base}"
            stroke="rgba(255,255,255,0.8)" stroke-width="10" stroke-linecap="round"/>`;
  }

  function glowCircles(x, y, r1=140, r2=100) {
    return `
      <circle cx="${x}" cy="${y}" r="${r1}" fill="rgba(255,255,255,0.10)"/>
      <circle cx="${x}" cy="${y}" r="${r2}" fill="rgba(255,255,255,0.16)"/>`;
  }

  function cellText(x, ty, sy, ay, title, sub) {
    return `
      <text x="${x}" y="${ty}"
            font-family="PingFang TC,Microsoft JhengHei,Noto Sans CJK TC,sans-serif"
            font-size="108" font-weight="bold" text-anchor="middle" fill="white">${title}</text>
      <text x="${x}" y="${sy}"
            font-family="Arial,Helvetica,sans-serif"
            font-size="52" text-anchor="middle" fill="rgba(255,255,255,0.58)">${sub}</text>
      <rect x="${x-70}" y="${ay}" width="140" height="7" rx="3.5" fill="rgba(255,255,255,0.35)"/>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="2500" height="1686">
  <defs>
    <linearGradient id="bg"  x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0D1B2A"/><stop offset="100%" stop-color="#1A2B3C"/></linearGradient>
    <linearGradient id="g1"  x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#4ADE80"/><stop offset="100%" stop-color="#166534"/></linearGradient>
    <linearGradient id="g2"  x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#60A5FA"/><stop offset="100%" stop-color="#1E3A8A"/></linearGradient>
    <linearGradient id="g3"  x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#FCD34D"/><stop offset="100%" stop-color="#92400E"/></linearGradient>
    <linearGradient id="g4"  x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#FB923C"/><stop offset="100%" stop-color="#7C2D12"/></linearGradient>
    <linearGradient id="g5"  x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#C084FC"/><stop offset="100%" stop-color="#581C87"/></linearGradient>
    <linearGradient id="g6"  x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#22D3EE"/><stop offset="100%" stop-color="#164E63"/></linearGradient>
  </defs>

  <!-- Background -->
  <rect width="2500" height="1686" fill="url(#bg)"/>

  <!-- Grid dividers -->
  <rect x="822"  y="10" width="9" height="1666" rx="4" fill="rgba(255,255,255,0.07)"/>
  <rect x="1657" y="10" width="9" height="1666" rx="4" fill="rgba(255,255,255,0.07)"/>
  <rect x="10" y="839" width="2480" height="9" rx="4" fill="rgba(255,255,255,0.07)"/>

  <!-- ── CARD 1: 上班打卡 ── -->
  <rect x="12" y="12" width="802" height="819" rx="32" fill="url(#g1)"/>
  ${glowCircles(416, 278)}
  ${sunIcon(416, 278)}
  ${cellText(416, titleY[0], subtY[0], accentY[0], '上班打卡', 'Check In')}

  <!-- ── CARD 2: 下班打卡 ── -->
  <rect x="839" y="12" width="811" height="819" rx="32" fill="url(#g2)"/>
  ${glowCircles(1250, 278)}
  ${moonIcon(1250, 278)}
  ${cellText(1250, titleY[0], subtY[0], accentY[0], '下班打卡', 'Check Out')}

  <!-- ── CARD 3: 加班申請 ── -->
  <rect x="1667" y="12" width="821" height="819" rx="32" fill="url(#g3)"/>
  ${glowCircles(2083, 278)}
  ${bellIcon(2083, 278)}
  ${cellText(2083, titleY[0], subtY[0], accentY[0], '加班申請', 'Overtime')}

  <!-- ── CARD 4: 請假申請 ── -->
  <rect x="12" y="855" width="802" height="819" rx="32" fill="url(#g4)"/>
  ${glowCircles(416, 1121)}
  ${docIcon(416, 1121)}
  ${cellText(416, titleY[1], subtY[1], accentY[1], '請假申請', 'Leave Request')}

  <!-- ── CARD 5: 忘記打卡 ── -->
  <rect x="839" y="855" width="811" height="819" rx="32" fill="url(#g5)"/>
  ${glowCircles(1250, 1121)}
  ${clockIcon(1250, 1121)}
  ${cellText(1250, titleY[1], subtY[1], accentY[1], '忘記打卡', 'Missed Punch')}

  <!-- ── CARD 6: 出勤紀錄 ── -->
  <rect x="1667" y="855" width="821" height="819" rx="32" fill="url(#g6)"/>
  ${glowCircles(2083, 1121)}
  ${chartIcon(2083, 1121)}
  ${cellText(2083, titleY[1], subtY[1], accentY[1], '出勤紀錄', 'My Records')}
</svg>`;
}

// ── LINE API ──────────────────────────────────────────
function lineApi(method, path, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const isBuffer = Buffer.isBuffer(body);
    const bodyBuf = body ? (isBuffer ? body : Buffer.from(body)) : null;
    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': opts.contentType || 'application/json',
    };
    if (bodyBuf) headers['Content-Length'] = bodyBuf.length;

    const req = https.request({
      hostname: opts.dataApi ? 'api-data.line.me' : 'api.line.me',
      path, method, headers
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ── 主程式 ────────────────────────────────────────────
async function main() {
  console.log('\n🎨 開始建立 LINE 圖文選單（6 格）...\n');

  const checkinUrl  = `https://liff.line.me/${LIFF_ID}?action=checkin`;
  const checkoutUrl = `https://liff.line.me/${LIFF_ID}?action=checkout`;
  const forgotUrl   = `https://liff.line.me/${LIFF_ID}?action=forgot`;
  const overtimeUrl = `https://liff.line.me/${LIFF_ID}?action=overtime`;
  const leaveUrl    = `https://liff.line.me/${LIFF_ID}?action=leave`;

  // 1. 建立選單結構（2500x1686 / 3x2）
  const menuDef = {
    size: { width: 2500, height: 1686 },
    selected: true,
    name: '打卡選單 6格',
    chatBarText: '📋 打開選單',
    areas: [
      { bounds: { x:0,    y:0,    width:833, height:843 }, action: { type: 'uri',     uri: checkinUrl } },
      { bounds: { x:833,  y:0,    width:834, height:843 }, action: { type: 'uri',     uri: checkoutUrl } },
      { bounds: { x:1667, y:0,    width:833, height:843 }, action: { type: 'uri',     uri: overtimeUrl } },
      { bounds: { x:0,    y:843,  width:833, height:843 }, action: { type: 'uri',     uri: leaveUrl } },
      { bounds: { x:833,  y:843,  width:834, height:843 }, action: { type: 'uri',     uri: forgotUrl } },
      { bounds: { x:1667, y:843,  width:833, height:843 }, action: { type: 'message', text: '出勤記錄' } },
    ]
  };

  const r1 = await lineApi('POST', '/v2/bot/richmenu', JSON.stringify(menuDef));
  if (r1.status !== 200) {
    console.error('❌ 建立選單失敗:', JSON.stringify(r1.body));
    process.exit(1);
  }
  const richMenuId = r1.body.richMenuId;
  console.log(`✅ 選單結構建立成功\n   ID: ${richMenuId}`);

  // 2. SVG → PNG
  let pngBuffer;
  try {
    const { Resvg } = require('@resvg/resvg-js');
    const resvg = new Resvg(buildSVG(), {
      font: { loadSystemFonts: true },
      fitTo: { mode: 'width', value: 2500 }
    });
    pngBuffer = resvg.render().asPng();
    console.log('✅ 圖片生成成功');
  } catch (e) {
    console.error('❌ 圖片生成失敗:', e.message);
    console.log('請先執行：npm install @resvg/resvg-js');
    process.exit(1);
  }

  // 3. 上傳圖片
  const r2 = await lineApi(
    'POST',
    `/v2/bot/richmenu/${richMenuId}/content`,
    pngBuffer,
    { contentType: 'image/png', dataApi: true }
  );
  if (r2.status !== 200) {
    console.error('❌ 圖片上傳失敗:', JSON.stringify(r2.body));
    process.exit(1);
  }
  console.log('✅ 圖片上傳成功');

  // 4. 設為預設選單
  const r3 = await lineApi('POST', `/v2/bot/user/all/richmenu/${richMenuId}`, null);
  if (r3.status !== 200) {
    console.error('❌ 設定預設選單失敗:', JSON.stringify(r3.body));
    process.exit(1);
  }
  console.log('✅ 已設為所有用戶預設選單');
  console.log('\n🎉 完成！下拉重新整理 LINE，底部會出現 6 格選單\n');
}

main().catch(e => { console.error('❌ 錯誤:', e.message); process.exit(1); });
