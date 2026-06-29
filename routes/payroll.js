const express = require('express');
const router = express.Router();
const db = require('../db');
const client = require('../lineClient');
const { generatePayroll } = require('../payroll');
const { getTaipeiTime } = require('../utils');

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

function auth(req, res, next) {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: '未授權' });
  }
  next();
}

router.use(auth);

// ── 公司設定 ──────────────────────────────────────────
router.get('/companies', (req, res) => {
  res.json(db.getCompanies());
});

router.put('/companies/:id', (req, res) => {
  const updated = db.updateCompany(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: '公司不存在' });
  res.json(updated);
});

// ── 薪資設定 ──────────────────────────────────────────
router.get('/salary-settings', (req, res) => {
  const settings = db.getAllSalarySettings();
  const employees = db.getAllEmployees();
  const result = employees.filter(e => e.role === 'employee').map(emp => ({
    ...emp,
    salarySettings: settings[emp.lineId] || {},
  }));
  res.json(result);
});

router.get('/salary-settings/:lineId', (req, res) => {
  res.json(db.getSalarySettings(req.params.lineId) || {});
});

router.put('/salary-settings/:lineId', (req, res) => {
  const emp = db.getEmployee(req.params.lineId);
  if (!emp) return res.status(404).json({ error: '員工不存在' });
  const updated = db.updateSalarySettings(req.params.lineId, req.body);
  res.json(updated);
});

// ── 加班申請 ──────────────────────────────────────────
router.get('/overtime-requests', (req, res) => {
  const { status, month } = req.query;
  const employees = db.getAllEmployees();
  let requests = db.getAllOvertimeRequests();

  if (status) requests = requests.filter(r => r.status === status);
  if (month) requests = requests.filter(r => r.date && r.date.startsWith(month));

  requests = requests.map(r => {
    const emp = employees.find(e => e.lineId === r.lineId);
    return { ...r, employeeName: emp?.name || '未知', department: emp?.department || '' };
  });

  res.json(requests.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

router.put('/overtime-requests/:id/review', async (req, res) => {
  const { status, note } = req.body;
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: '狀態只能是 approved 或 rejected' });
  }
  const request = db.reviewOvertimeRequest(req.params.id, status, note);
  if (!request) return res.status(404).json({ error: '申請不存在' });

  const emp = db.getEmployee(request.lineId);
  const statusText = status === 'approved' ? '✅ 核准' : '❌ 駁回';
  client.pushMessage({
    to: request.lineId,
    messages: [{
      type: 'text',
      text: `⏰ 加班申請審核結果\n\n姓名：${emp?.name || '員工'}\n日期：${request.date}\n時段：${request.startTime}～${request.endTime}（${request.hours}H）\n狀態：${statusText}${note ? '\n備注：' + note : ''}`,
    }],
  }).catch(console.error);

  res.json(request);
});

// ── 薪資生成 ──────────────────────────────────────────
router.post('/generate', (req, res) => {
  const { year, month, companyId } = req.body;
  if (!year || !month || !companyId) {
    return res.status(400).json({ error: '缺少 year / month / companyId' });
  }

  const monthStr = `${year}-${String(month).padStart(2, '0')}`;
  const employees = db.getAllEmployees().filter(e => e.role === 'employee');
  const allSettings = db.getAllSalarySettings();

  // 只產生屬於該公司的員工薪資
  const targetEmployees = employees.filter(e => {
    const s = allSettings[e.lineId];
    return s && s.companyId === companyId;
  });

  if (targetEmployees.length === 0) {
    return res.status(400).json({ error: '該公司沒有已設定薪資的員工' });
  }

  const results = [];
  for (const emp of targetEmployees) {
    const settings = allSettings[emp.lineId] || {};
    const attendance = db.getAllAttendance().filter(a => a.lineId === emp.lineId && a.date.startsWith(monthStr));
    const leaves = db.getAllLeaves().filter(
      l => l.lineId === emp.lineId && l.date.startsWith(monthStr) && l.status === 'approved'
    );
    const approvedOT = db.getAllOvertimeRequests().filter(
      r => r.lineId === emp.lineId && r.date.startsWith(monthStr) && r.status === 'approved'
    );

    const calc = generatePayroll({ salarySettings: settings, attendance, approvedLeaves: leaves, approvedOT });

    const payroll = db.savePayroll({
      lineId: emp.lineId,
      employeeName: emp.name,
      department: emp.department || '',
      companyId,
      year: Number(year),
      month: Number(month),
      ...calc,
      notes: '',
      status: 'draft',
    });

    results.push(payroll);
  }

  res.json(results);
});

// ── 薪資單管理 ──────────────────────────────────────────
router.get('/payrolls', (req, res) => {
  const { year, month, companyId, lineId } = req.query;
  let payrolls = db.getAllPayrolls();

  if (year) payrolls = payrolls.filter(p => p.year === Number(year));
  if (month) payrolls = payrolls.filter(p => p.month === Number(month));
  if (companyId) payrolls = payrolls.filter(p => p.companyId === companyId);
  if (lineId) payrolls = payrolls.filter(p => p.lineId === lineId);

  res.json(payrolls.sort((a, b) => {
    if (b.year !== a.year) return b.year - a.year;
    return b.month - a.month;
  }));
});

router.get('/payrolls/:id', (req, res) => {
  const p = db.getAllPayrolls().find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: '薪資單不存在' });
  res.json(p);
});

router.put('/payrolls/:id', (req, res) => {
  const updated = db.updatePayroll(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: '薪資單不存在' });
  res.json(updated);
});

router.post('/payrolls/:id/confirm', (req, res) => {
  const updated = db.updatePayroll(req.params.id, { status: 'confirmed', confirmedAt: new Date().toISOString() });
  if (!updated) return res.status(404).json({ error: '薪資單不存在' });
  res.json(updated);
});

router.delete('/payrolls/:id', (req, res) => {
  db.deletePayroll(req.params.id);
  res.json({ success: true });
});

// 推播薪資通知給員工
router.post('/payrolls/:id/notify', async (req, res) => {
  const p = db.getAllPayrolls().find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: '薪資單不存在' });

  const companies = db.getCompanies();
  const company = companies.find(c => c.id === p.companyId);
  const monthLabel = `${p.year}年${p.month}月`;

  const msg = [
    `💰 ${monthLabel}薪資單已發放`,
    `公司：${company?.name || p.companyId}`,
    `應付合計：$${p.totalIncome?.toLocaleString()}`,
    `應扣合計：$${p.totalDeductions?.toLocaleString()}`,
    `✅ 實領薪資：$${p.netSalary?.toLocaleString()}`,
    p.notes ? `備注：${p.notes}` : '',
    '\n如有疑問請洽管理員',
  ].filter(Boolean).join('\n');

  try {
    await client.pushMessage({ to: p.lineId, messages: [{ type: 'text', text: msg }] });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 員工查自己的薪資（LIFF 用，不需 admin token — 覆蓋 auth middleware）
// 另外在 server.js 掛一個公開路由
module.exports = router;
