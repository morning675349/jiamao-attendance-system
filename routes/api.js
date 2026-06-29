const express = require('express');
const https = require('https');
const router = express.Router();
const db = require('../db');
const client = require('../lineClient');
const { getTaipeiTime, calcAnnualLeaveDays, isLate, getLateMinutes } = require('../utils');

const LEAVE_TYPES = { annual: '特休假', sick: '病假', personal: '事假', other: '其他假別' };

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
  const { accessToken, action, lat, lng } = req.body || {};
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

  if (action === 'checkin') {
    const companySetting = (db.getCompanies() || []).find(c => c.id === (db.getSalarySettings(lineId) || {}).companyId);
    const workStart = companySetting?.workStart || process.env.WORK_START;
    const late = isLate(time, workStart);
    const lateMinutes = getLateMinutes(time, workStart);
    const result = db.checkIn(lineId, date, time, location, late ? 'late' : 'normal', lateMinutes);
    console.log(`[liff/punch] checkIn result:`, JSON.stringify(result));
    if (result.error) return res.status(400).json({ error: result.error });
    const note = late ? `⚠️ 遲到（規定 ${process.env.WORK_START || '09:00'}）` : '';
    res.json({ time, status: result.status, note });
    db.getAllEmployees().filter(e => e.role === 'admin').forEach(admin => {
      client.pushMessage({
        to: admin.lineId,
        messages: [{ type: 'text', text: `📍 打卡通知\n${employee.name} 上班打卡\n時間：${time}${late ? ' ⚠️遲到' : ''}${location ? '\n📍 GPS 已記錄' : ''}` }]
      }).catch(console.error);
    });
  } else {
    const result = db.checkOut(lineId, date, time, location);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ time, workHours: result.workHours, note: '' });
    db.getAllEmployees().filter(e => e.role === 'admin').forEach(admin => {
      client.pushMessage({
        to: admin.lineId,
        messages: [{ type: 'text', text: `📍 打卡通知\n${employee.name} 下班打卡\n時間：${time}\n⏱️ 今日工時：${result.workHours} 小時${location ? '\n📍 GPS 已記錄' : ''}` }]
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

  const typeText = type === 'checkin' ? '上班' : '下班';
  db.getAllEmployees().filter(e => e.role === 'admin').forEach(admin => {
    client.pushMessage({
      to: admin.lineId,
      messages: [{ type: 'text', text: `📝 補打卡申請\n${employee.name} 申請補打${typeText}卡\n日期：${date}\n申請時間：${requestedTime}\n原因：${reason}` }]
    }).catch(console.error);
  });

  res.json(request);
});

router.use(auth);

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
    return { ...r, employeeName: emp?.name || '未知', department: emp?.department || '' };
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
    const { lineId, date, type, requestedTime } = request;
    const existing = db.getAllAttendance().find(a => a.lineId === lineId && a.date === date);
    if (type === 'checkin') {
      if (existing) {
        db.updateAttendance(existing.id, { checkIn: requestedTime });
      } else {
        db.addAttendance({ lineId, date, checkIn: requestedTime, status: 'normal' });
      }
    } else if (type === 'checkout') {
      if (existing) {
        db.updateAttendance(existing.id, { checkOut: requestedTime });
      } else {
        db.addAttendance({ lineId, date, checkOut: requestedTime, status: 'normal' });
      }
    }
  }

  const emp = db.getEmployee(request.lineId);
  const typeText = request.type === 'checkin' ? '上班' : '下班';
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
  const { title, content } = req.body;
  if (!title?.trim() || !content?.trim()) return res.status(400).json({ error: '請填寫標題與內容' });
  res.json(db.createAnnouncement({ title: title.trim(), content: content.trim() }));
});

router.put('/announcements/:id', (req, res) => {
  const ann = db.updateAnnouncement(req.params.id, req.body);
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

  const employees = db.getAllEmployees().filter(e => e.role === 'employee');
  await Promise.allSettled(employees.map(emp =>
    client.pushMessage({
      to: emp.lineId,
      messages: [{ type: 'text', text: `📢 公司公告\n\n【${ann.title}】\n\n${ann.content}` }]
    })
  ));
  res.json({ pushed: employees.length });
});

// ── 地理圍欄設定（需 token 寫）────────────────────────────
router.put('/settings/geofence', (req, res) => {
  db.updateSettings({ geofence: req.body });
  res.json(req.body);
});

module.exports = router;
