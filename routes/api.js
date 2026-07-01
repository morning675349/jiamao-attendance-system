const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const db = require('../db');
const client = require('../lineClient');
const { getTaipeiTime, calcAnnualLeaveDays, isLate, getLateMinutes } = require('../utils');

const LEAVE_TYPES = { annual: '特休假', sick: '病假', personal: '事假', other: '其他假別' };
const PUNCH_REQ_LABELS = { checkin: '上班', checkout: '下班', ot_checkin: '加班上班', ot_checkout: '加班下班' };

// 上班卡提前開放分鐘數（例：上班 08:00 → 07:55 起開放打卡）
const CHECKIN_OPEN_BEFORE_MIN = 5;
// 'HH:MM' → 當日分鐘數
const hhmmToMin = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const minToHhmm = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

// 公開網址基底（LINE 發圖需公開可抓的 https 網址）
const BASE_URL = process.env.BASE_URL || 'https://attendance.jiamao.com.tw';

// 儲存公告圖片（data URL → data/uploads/ann-<id>.<ext>），回傳檔名
function saveAnnouncementImage(id, dataUrl) {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) return null;
  const ext = /png/i.test(m[1]) ? 'png' : 'jpg';
  const dir = path.join(__dirname, '..', 'data', 'uploads');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fileName = `ann-${id}.${ext}`;
  fs.writeFileSync(path.join(dir, fileName), Buffer.from(m[2], 'base64'));
  return fileName;
}

// 所有 API 回應禁止 Varnish 快取
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// ── LINE Token 驗證（防止偽造打卡）────────────────────
function verifyLineToken(accessToken) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.line.me',
      path: '/v2/profile',
      headers: { Authorization: `Bearer ${accessToken}` }
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(JSON.parse(raw));
        else reject(new Error('Token 驗證失敗'));
      });
    }).on('error', reject);
  });
}

// ── Auth ───────────────────────────────────────────────
router.post('/login', (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    res.json({ token: process.env.ADMIN_TOKEN });
  } else {
    res.status(401).json({ error: '密碼錯誤' });
  }
});

function auth(req, res, next) {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: '未授權' });
  }
  next();
}

// ── 公開端點（LIFF 頁面使用，不需 admin token）──────────
router.post('/liff/punch', async (req, res) => {
  const { accessToken, action, lat, lng, mealEat, mealKind } = req.body || {};
  console.log(`[liff/punch] action=${action} hasToken=${!!accessToken} lat=${lat} lng=${lng}`);
  if (!accessToken) return res.status(400).json({ error: '缺少 accessToken，請關閉後重新從 LINE 開啟' });

  let profile;
  try {
    profile = await verifyLineToken(accessToken);
  } catch (e) {
    console.log('[liff/punch] token verify failed:', e.message);
    return res.status(401).json({ error: 'LINE Token 無效，請重新開啟打卡頁面' });
  }

  const lineId = profile.userId;
  console.log(`[liff/punch] lineId=${lineId} action=${action}`);
  const employee = db.getEmployee(lineId);
  if (!employee) return res.status(404).json({ error: '帳號未綁定，請先在 LINE Bot 輸入「綁定 姓名」' });

  // 地理圍欄驗證
  const fence = db.getSettings().geofence || {};
  if (fence.enabled && fence.strict && fence.lat && fence.lng && lat && lng) {
    const R = 6371000, d2r = Math.PI / 180;
    const dLat = (Number(fence.lat) - lat) * d2r;
    const dLng = (Number(fence.lng) - lng) * d2r;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat*d2r)*Math.cos(Number(fence.lat)*d2r)*Math.sin(dLng/2)**2;
    const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    if (dist > (Number(fence.radius) || 300)) {
      return res.status(403).json({ error: `距辦公室 ${Math.round(dist)} 公尺，超出允許範圍` });
    }
  }

  const { date, time } = getTaipeiTime();
  const location = (lat && lng) ? { lat, lng } : null;
  const companySetting = (db.getCompanies() || []).find(c => c.id === (db.getSalarySettings(lineId) || {}).companyId);

  const todayRec = db.getAllAttendance().find(a => a.lineId === lineId && a.date === date);
  // 判斷目前是否「上班中」（有開啟未閉合的時段）；相容舊資料
  const segs = todayRec
    ? (Array.isArray(todayRec.segments)
        ? todayRec.segments
        : (todayRec.checkIn ? [{ in: todayRec.checkIn, out: todayRec.checkOut || null }] : []))
    : [];
  const onShift = segs.length > 0 && !segs[segs.length - 1].out;

  if (action === 'checkin') {
    const isFirst = !todayRec;
    const workStart = companySetting?.workStart || process.env.WORK_START || '08:00';
    // ① 上班卡開放時間 = 上班時間提前 N 分鐘；太早不給打（僅當天第一次上班套用）
    if (isFirst) {
      const openMin = hhmmToMin(workStart) - CHECKIN_OPEN_BEFORE_MIN;
      if (hhmmToMin(time) < openMin) {
        return res.status(403).json({ error: `⏰ 尚未開放打卡\n上班卡 ${minToHhmm(openMin)} 起才能打（上班時間 ${workStart}）` });
      }
    }
    const late = isFirst && isLate(time, workStart);
    const lateMinutes = isFirst ? getLateMinutes(time, workStart) : 0;
    const result = db.checkIn(lineId, date, time, location, late ? 'late' : 'normal', lateMinutes);
    console.log(`[liff/punch] checkIn result:`, JSON.stringify({ first: result._firstCheckIn, error: result.error }));
    if (result.error) return res.status(400).json({ error: result.error });

    // 記錄用餐選擇（mealKind: 'lunch'=中午, 'ot'=加班；mealEat: 是否用餐）
    if (mealKind === 'lunch' || mealKind === 'ot') {
      db.setAttendanceMeal(lineId, date, mealKind, mealEat);
    }

    if (result._firstCheckIn) {
      const note = late ? `⚠️ 遲到（規定 ${workStart}）` : '';
      res.json({ time, status: result.status, note });
    } else {
      res.json({ time, title: '回來上班！', note: '已繼續計時，外出時間不計入工時' });
    }
    const tag = result._firstCheckIn ? '上班打卡' : '回來上班';
    db.getAllEmployees().filter(e => e.role === 'admin').forEach(admin => {
      client.pushMessage({
        to: admin.lineId,
        messages: [{ type: 'text', text: `📍 打卡通知\n${employee.name} ${tag}\n時間：${time}${late ? ' ⚠️遲到' : ''}${location ? '\n📍 GPS 已記錄' : ''}` }]
      }).catch(console.error);
    });
  } else {
    // 不在上班狀態 → 不能打下班/外出卡
    if (!onShift) {
      return res.status(400).json({ error: '您目前不在上班狀態，請先按「上班打卡」' });
    }
    // 下班卡不再限制時間；加班改由員工自行填「加班單」申報實際時段作為發放依據
    const result = db.checkOut(lineId, date, time, location);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ time, workHours: result.workHours, note: '若只是外出，回來請再按「上班打卡」' });
    db.getAllEmployees().filter(e => e.role === 'admin').forEach(admin => {
      client.pushMessage({
        to: admin.lineId,
        messages: [{ type: 'text', text: `📍 打卡通知\n${employee.name} 下班/外出打卡\n時間：${time}\n⏱️ 今日累計工時：${result.workHours} 小時${location ? '\n📍 GPS 已記錄' : ''}` }]
      }).catch(console.error);
    });
  }
});

router.get('/emp-info', (req, res) => {
  const emp = db.getEmployee(req.query.lineId);
  res.json(emp ? { name: emp.name, department: emp.department } : {});
});

router.get('/settings/geofence', (req, res) => {
  res.json(db.getSettings().geofence || { enabled: false });
});

router.post('/liff/punch-request', async (req, res) => {
  const { accessToken, date, type, requestedTime, reason } = req.body;
  if (!accessToken) return res.status(400).json({ error: '缺少 accessToken' });

  let profile;
  try {
    profile = await verifyLineToken(accessToken);
  } catch(e) {
    return res.status(401).json({ error: 'LINE Token 無效，請重新開啟頁面' });
  }

  const lineId = profile.userId;
  const employee = db.getEmployee(lineId);
  if (!employee) return res.status(404).json({ error: '帳號未綁定，請先在 LINE Bot 輸入「綁定 姓名」' });
  if (!date || !type || !requestedTime || !reason?.trim()) {
    return res.status(400).json({ error: '請填寫完整資訊' });
  }

  const request = db.createPunchRequest({ lineId, date, type, requestedTime, reason: reason.trim() });

  const typeText = PUNCH_REQ_LABELS[type] || '打卡';
  const flex = {
    type: 'flex',
    altText: `${employee.name} 申請補打${typeText}卡`,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#F59E0B',
        contents: [{ type: 'text', text: '📝 補打卡申請', weight: 'bold', size: 'lg', color: '#ffffff' }] },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'text', text: `👤 ${employee.name}`, weight: 'bold' },
        { type: 'text', text: `類型：補打${typeText}卡`, color: '#555555' },
        { type: 'text', text: `📅 ${date}　🕐 ${requestedTime}`, color: '#555555' },
        { type: 'text', text: `原因：${reason.trim()}`, color: '#555555', wrap: true },
      ] },
      footer: { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', color: '#10B981', action: { type: 'postback', label: '✅ 核准', data: `action=review_punch&id=${request.id}&status=approved`, displayText: '核准補打卡' } },
        { type: 'button', style: 'primary', color: '#EF4444', action: { type: 'postback', label: '❌ 駁回', data: `action=review_punch&id=${request.id}&status=rejected`, displayText: '駁回補打卡' } },
      ] }
    }
  };
  db.getAllEmployees().filter(e => e.role === 'admin').forEach(admin => {
    client.pushMessage({ to: admin.lineId, messages: [flex] }).catch(console.error);
  });

  res.json(request);
});

// ── 加班單（LIFF 表單）──
router.post('/liff/overtime-request', async (req, res) => {
  const { accessToken, date, startTime, endTime, reason, meal } = req.body || {};
  if (!accessToken) return res.status(400).json({ error: '缺少 accessToken' });
  let profile;
  try { profile = await verifyLineToken(accessToken); }
  catch (e) { return res.status(401).json({ error: 'LINE Token 無效，請重新開啟頁面' }); }
  const employee = db.getEmployee(profile.userId);
  if (!employee) return res.status(404).json({ error: '帳號未綁定，請先在 LINE Bot 輸入「綁定 姓名」' });
  if (!date || !startTime || !endTime || !reason?.trim()) return res.status(400).json({ error: '請填寫完整資訊' });
  const [sh, sm] = startTime.split(':').map(Number), [eh, em] = endTime.split(':').map(Number);
  let hours = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
  if (!(hours > 0)) return res.status(400).json({ error: '結束時間需晚於開始時間' });
  hours = Math.round(hours * 10) / 10;
  const request = db.createOvertimeRequest({ lineId: profile.userId, date, startTime, endTime, hours, reason: reason.trim(), meal: !!meal });
  const flex = {
    type: 'flex', altText: `${employee.name} 申請加班`,
    contents: { type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#F59E0B',
        contents: [{ type: 'text', text: '⏰ 加班單', weight: 'bold', size: 'lg', color: '#ffffff' }] },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'text', text: `👤 ${employee.name}`, weight: 'bold' },
        { type: 'text', text: `📅 ${date}　${startTime}–${endTime}（${hours}H）`, color: '#555555', wrap: true },
        { type: 'text', text: `便當：${meal ? '需要 🍱' : '不需要'}`, color: '#555555' },
        { type: 'text', text: `原因：${reason.trim()}`, color: '#555555', wrap: true },
      ] },
      footer: { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', color: '#10B981', action: { type: 'postback', label: '✅ 核准', data: `action=review_overtime&id=${request.id}&status=approved`, displayText: '核准加班' } },
        { type: 'button', style: 'primary', color: '#EF4444', action: { type: 'postback', label: '❌ 駁回', data: `action=review_overtime&id=${request.id}&status=rejected`, displayText: '駁回加班' } },
      ] } } };
  db.getAllEmployees().filter(e => e.role === 'admin').forEach(admin => client.pushMessage({ to: admin.lineId, messages: [flex] }).catch(console.error));
  res.json(request);
});

// ── 請假申請（LIFF 表單，可附證明）──
router.post('/liff/leave-request', async (req, res) => {
  const { accessToken, type, date, reason, imageBase64 } = req.body || {};
  if (!accessToken) return res.status(400).json({ error: '缺少 accessToken' });
  let profile;
  try { profile = await verifyLineToken(accessToken); }
  catch (e) { return res.status(401).json({ error: 'LINE Token 無效，請重新開啟頁面' }); }
  const employee = db.getEmployee(profile.userId);
  if (!employee) return res.status(404).json({ error: '帳號未綁定，請先在 LINE Bot 輸入「綁定 姓名」' });
  if (!type || !date || !reason?.trim()) return res.status(400).json({ error: '請填寫完整資訊' });
  let documentPath = null, hasDocument = false;
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(imageBase64 || '');
  if (m) {
    const ext = /png/i.test(m[1]) ? 'png' : 'jpg';
    const dir = path.join(__dirname, '..', 'data', 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    documentPath = `leave-${Date.now()}-${profile.userId.slice(-6)}.${ext}`;
    fs.writeFileSync(path.join(dir, documentPath), Buffer.from(m[2], 'base64'));
    hasDocument = true;
  }
  const leave = db.createLeave({ lineId: profile.userId, date, type, reason: reason.trim(), documentPath, hasDocument });
  const flex = {
    type: 'flex', altText: `${employee.name} 申請${LEAVE_TYPES[type] || '請假'}`,
    contents: { type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#3B82F6',
        contents: [{ type: 'text', text: '📋 請假申請', weight: 'bold', size: 'lg', color: '#ffffff' }] },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'text', text: `👤 ${employee.name}`, weight: 'bold' },
        { type: 'text', text: `📅 ${date}　假別：${LEAVE_TYPES[type] || type}`, color: '#555555', wrap: true },
        { type: 'text', text: `原因：${reason.trim()}`, color: '#555555', wrap: true },
        ...(hasDocument ? [{ type: 'text', text: '📎 已附證明（後台可查看）', color: '#16A34A', size: 'sm' }] : []),
      ] },
      footer: { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', color: '#10B981', action: { type: 'postback', label: '✅ 核准', data: `action=review_leave&id=${leave.id}&status=approved`, displayText: '核准假單' } },
        { type: 'button', style: 'primary', color: '#EF4444', action: { type: 'postback', label: '❌ 駁回', data: `action=review_leave&id=${leave.id}&status=rejected`, displayText: '駁回假單' } },
      ] } } };
  db.getAllEmployees().filter(e => e.role === 'admin').forEach(admin => client.pushMessage({ to: admin.lineId, messages: [flex] }).catch(console.error));
  res.json(leave);
});

// 請假證明文件（需 admin token；可用 ?token= 方便後台 <img>/<a> 直接連）
router.get('/leaves/:id/document', (req, res) => {
  const t = req.headers['x-admin-token'] || req.query.token;
  if (t !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: '未授權' });
  const leave = db.getLeaveById(req.params.id);
  if (!leave || !leave.documentPath) return res.status(404).json({ error: '查無證明文件' });
  const filePath = path.join(__dirname, '..', 'data', 'uploads', leave.documentPath);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '檔案不存在' });
  res.sendFile(filePath);
});

// 公告圖片（公開：LINE 需公開網址才能發圖給員工）
router.get('/announcement-image/:id', (req, res) => {
  const ann = db.getAllAnnouncements().find(a => a.id === req.params.id);
  if (!ann || !ann.imagePath) return res.status(404).json({ error: '查無圖片' });
  const filePath = path.join(__dirname, '..', 'data', 'uploads', ann.imagePath);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '檔案不存在' });
  res.sendFile(filePath);
});

router.use(auth);

// 手動觸發用餐統計推播（測試用）
router.post('/notify/lunch-stats', (req, res) => { require('../scheduler').notifyLunchStats(); res.json({ ok: true }); });
router.post('/notify/ot-stats', (req, res) => { require('../scheduler').notifyOtMealStats(); res.json({ ok: true }); });

// ── Stats ─────────────────────────────────────────────
router.get('/stats/today', (req, res) => {
  const { date } = getTaipeiTime();
  const employees = db.getAllEmployees().filter(e => e.role === 'employee');
  const todayRecords = db.getAllAttendance().filter(r => r.date === date);
  res.json({
    date,
    totalEmployees: employees.length,
    checkedIn: todayRecords.filter(r => r.checkIn).length,
    checkedOut: todayRecords.filter(r => r.checkOut).length,
    notCheckedIn: employees.length - todayRecords.filter(r => r.checkIn).length,
    pendingLeaves: db.getAllLeaves().filter(l => l.status === 'pending').length
  });
});

// ── Attendance ────────────────────────────────────────
router.get('/attendance', (req, res) => {
  const { date, month, lineId } = req.query;
  const employees = db.getAllEmployees();
  let records = db.getAllAttendance();

  if (date) records = records.filter(r => r.date === date);
  if (month) records = records.filter(r => r.date.startsWith(month));
  if (lineId) records = records.filter(r => r.lineId === lineId);

  records = records.map(r => {
    const emp = employees.find(e => e.lineId === r.lineId);
    const segCount = Array.isArray(r.segments) ? r.segments.length : (r.checkIn ? 1 : 0);
    // 未完成打卡：有開啟中、尚未閉合的時段（外出沒回來就走人）
    const incomplete = Array.isArray(r.segments)
      ? r.segments.some(s => s.in && !s.out)
      : (!!r.checkIn && !r.checkOut);
    return { ...r, employeeName: emp?.name || '未知', department: emp?.department || '', segmentCount: segCount, incomplete };
  });

  res.json(records.sort((a, b) => b.date.localeCompare(a.date)));
});

router.post('/attendance', (req, res) => {
  const { lineId, date, checkIn, checkOut, status } = req.body;
  if (!lineId || !date) return res.status(400).json({ error: '缺少 lineId 或 date' });
  const result = db.addAttendance({ lineId, date, checkIn, checkOut, status });
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

router.put('/attendance/:id', (req, res) => {
  const updated = db.updateAttendance(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: '記錄不存在' });
  res.json(updated);
});

router.delete('/attendance/:id', (req, res) => {
  db.deleteAttendance(req.params.id);
  res.json({ success: true });
});

// ── Employees ─────────────────────────────────────────
router.get('/employees', (req, res) => res.json(db.getAllEmployees()));

router.post('/employees', (req, res) => {
  const { name, lineId, department, role } = req.body;
  if (!name || !lineId) return res.status(400).json({ error: '缺少姓名或 LINE ID' });
  res.json(db.createEmployee({ lineId, name, department, role }));
});

router.put('/employees/:lineId', (req, res) => {
  const emp = db.updateEmployee(req.params.lineId, req.body);
  if (!emp) return res.status(404).json({ error: '員工不存在' });
  res.json(emp);
});

router.delete('/employees/:lineId', (req, res) => {
  db.deleteEmployee(req.params.lineId);
  res.json({ success: true });
});

// ── Leaves ────────────────────────────────────────────
router.get('/leaves', (req, res) => {
  const { status, month } = req.query;
  const employees = db.getAllEmployees();
  let leaves = db.getAllLeaves();

  if (status) leaves = leaves.filter(l => l.status === status);
  if (month) leaves = leaves.filter(l => l.date.startsWith(month));

  leaves = leaves.map(l => {
    const emp = employees.find(e => e.lineId === l.lineId);
    return { ...l, employeeName: emp?.name || '未知', department: emp?.department || '' };
  });

  res.json(leaves.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

router.put('/leaves/:id/review', async (req, res) => {
  const { status, note } = req.body;
  const leave = db.reviewLeave(req.params.id, status, note);
  if (!leave) return res.status(404).json({ error: '假單不存在' });

  const statusText = status === 'approved' ? '✅ 已核准' : '❌ 已駁回';
  const emp = db.getEmployee(leave.lineId);
  client.pushMessage({
    to: leave.lineId,
    messages: [{
      type: 'text',
      text: `📋 假單審核結果\n\n姓名：${emp?.name || '員工'}\n日期：${leave.date}\n假別：${LEAVE_TYPES[leave.type] || leave.type}\n狀態：${statusText}${note ? '\n備注：' + note : ''}`
    }]
  }).catch(console.error);

  res.json(leave);
});

// ── Monthly Report ────────────────────────────────────
router.get('/report/monthly', (req, res) => {
  const { month } = req.query;
  const currentMonth = month || getTaipeiTime().month;
  const employees = db.getAllEmployees().filter(e => e.role === 'employee');
  const attendance = db.getAllAttendance().filter(r => r.date.startsWith(currentMonth));
  const leaves = db.getAllLeaves().filter(l => l.date.startsWith(currentMonth) && l.status === 'approved');

  const report = employees.map(emp => {
    const recs = attendance.filter(a => a.lineId === emp.lineId);
    const empLeaves = leaves.filter(l => l.lineId === emp.lineId);
    return {
      lineId: emp.lineId, name: emp.name, department: emp.department,
      workDays: recs.filter(a => a.checkIn).length,
      totalHours: Math.round(recs.reduce((s, a) => s + (a.workHours || 0), 0) * 10) / 10,
      lateDays: recs.filter(a => a.status === 'late').length,
      leaveDays: empLeaves.length,
      attendance: recs, leaves: empLeaves
    };
  });

  res.json(report);
});

// ── Annual Leave Balance ──────────────────────────────
router.get('/leave-balance', (req, res) => {
  const year = req.query.year || getTaipeiTime().date.slice(0, 4);
  const employees = db.getAllEmployees().filter(e => e.role === 'employee');
  const allLeaves = db.getAllLeaves().filter(l =>
    l.type === 'annual' && l.status === 'approved' && l.date.startsWith(year)
  );

  const result = employees.map(emp => {
    const total = calcAnnualLeaveDays(emp.joinDate, emp.annualLeaveOverride);
    const usedLeaves = allLeaves.filter(l => l.lineId === emp.lineId);
    const used = usedLeaves.length;
    const joined = emp.joinDate ? new Date(emp.joinDate) : null;
    const years = joined
      ? Math.floor((new Date() - joined) / (365.25 * 24 * 60 * 60 * 1000))
      : null;
    return {
      lineId: emp.lineId,
      name: emp.name,
      department: emp.department,
      joinDate: emp.joinDate || null,
      yearsOfService: years,
      totalDays: total,
      usedDays: used,
      remainingDays: Math.max(0, total - used),
      annualLeaveOverride: emp.annualLeaveOverride ?? null,
      usedLeaves
    };
  });

  res.json(result);
});

// ── 補打卡申請（Admin）────────────────────────────────────
router.get('/punch-requests', (req, res) => {
  const { status } = req.query;
  const employees = db.getAllEmployees();
  let requests = db.getAllPunchRequests();
  if (status) requests = requests.filter(r => r.status === status);
  requests = requests.map(r => {
    const emp = employees.find(e => e.lineId === r.lineId);
    return { ...r, employeeName: emp?.name || '未知', department: emp?.department || '' };
  });
  res.json(requests.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

router.put('/punch-requests/:id/review', async (req, res) => {
  const { status, note } = req.body;
  const request = db.reviewPunchRequest(req.params.id, status, note);
  if (!request) return res.status(404).json({ error: '申請不存在' });

  if (status === 'approved') {
    const { lineId, date, requestedTime } = request;
    // 補卡：把時間點插進當天序列、自動重排配對成時段（適用四種補卡類型）
    db.addMakeupPunch(lineId, date, requestedTime);
  }

  const emp = db.getEmployee(request.lineId);
  const typeText = PUNCH_REQ_LABELS[request.type] || '打卡';
  const statusText = status === 'approved' ? '✅ 已核准' : '❌ 已駁回';
  client.pushMessage({
    to: request.lineId,
    messages: [{ type: 'text', text: `📝 補打卡結果\n\n姓名：${emp?.name || '員工'}\n日期：${request.date}\n類型：補打${typeText}卡\n申請時間：${request.requestedTime}\n狀態：${statusText}${note ? '\n備注：' + note : ''}` }]
  }).catch(console.error);

  res.json(request);
});

// ── 公告 ──────────────────────────────────────────────
router.get('/announcements', (req, res) => {
  let anns = db.getAllAnnouncements();
  if (req.query.active) anns = anns.filter(a => a.active);
  res.json(anns.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

router.post('/announcements', (req, res) => {
  const { title, content, imageBase64 } = req.body;
  if (!title?.trim() || !content?.trim()) return res.status(400).json({ error: '請填寫標題與內容' });
  const ann = db.createAnnouncement({ title: title.trim(), content: content.trim() });
  if (imageBase64) {
    const saved = saveAnnouncementImage(ann.id, imageBase64);
    if (saved) db.updateAnnouncement(ann.id, { imagePath: saved });
  }
  res.json(db.getAllAnnouncements().find(a => a.id === ann.id));
});

router.put('/announcements/:id', (req, res) => {
  const { imageBase64, ...updates } = req.body;
  if (imageBase64) {
    const saved = saveAnnouncementImage(req.params.id, imageBase64);
    if (saved) updates.imagePath = saved;
  }
  const ann = db.updateAnnouncement(req.params.id, updates);
  if (!ann) return res.status(404).json({ error: '公告不存在' });
  res.json(ann);
});

router.delete('/announcements/:id', (req, res) => {
  db.deleteAnnouncement(req.params.id);
  res.json({ success: true });
});

router.post('/announcements/:id/push', async (req, res) => {
  const ann = db.getAllAnnouncements().find(a => a.id === req.params.id);
  if (!ann) return res.status(404).json({ error: '公告不存在' });

  const messages = [{ type: 'text', text: `📢 公司公告\n\n【${ann.title}】\n\n${ann.content}` }];
  if (ann.imagePath) {
    const url = `${BASE_URL}/api/announcement-image/${ann.id}`;
    messages.push({ type: 'image', originalContentUrl: url, previewImageUrl: url });
  }
  const employees = db.getAllEmployees().filter(e => e.role === 'employee');
  await Promise.allSettled(employees.map(emp => client.pushMessage({ to: emp.lineId, messages })));
  res.json({ pushed: employees.length });
});

// ── 地理圍欄設定（需 token 寫）────────────────────────────
router.put('/settings/geofence', (req, res) => {
  db.updateSettings({ geofence: req.body });
  res.json(req.body);
});

module.exports = router;
