const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { calcWorkHours } = require('./utils');

const DB_PATH = path.join(__dirname, 'data', 'db.json');

function readDb() {
  if (!fs.existsSync(DB_PATH)) {
    const init = { employees: [], attendance: [], leaves: [], settings: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(init, null, 2));
    return init;
  }
  const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  if (!data.settings) data.settings = {};
  return data;
}

function writeDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ── 員工 ──────────────────────────────────────────
function getEmployee(lineId) {
  return readDb().employees.find(e => e.lineId === lineId) || null;
}

function getAllEmployees() {
  return readDb().employees;
}

function createEmployee({ lineId, name, department = '未分部門', role = 'employee' }) {
  const db = readDb();
  const exists = db.employees.findIndex(e => e.lineId === lineId);
  if (exists >= 0) {
    db.employees[exists] = { ...db.employees[exists], name, department, role };
    writeDb(db);
    return db.employees[exists];
  }
  const emp = { lineId, name, department, role, createdAt: new Date().toISOString() };
  db.employees.push(emp);
  writeDb(db);
  return emp;
}

function updateEmployee(lineId, updates) {
  const db = readDb();
  const idx = db.employees.findIndex(e => e.lineId === lineId);
  if (idx < 0) return null;
  db.employees[idx] = { ...db.employees[idx], ...updates };
  writeDb(db);
  return db.employees[idx];
}

function deleteEmployee(lineId) {
  const db = readDb();
  db.employees = db.employees.filter(e => e.lineId !== lineId);
  writeDb(db);
}

// ── 出勤 ──────────────────────────────────────────
function getTodayRecord(lineId, date) {
  return readDb().attendance.find(a => a.lineId === lineId && a.date === date) || null;
}

function getAllAttendance() {
  return readDb().attendance;
}

function checkIn(lineId, date, time, location, status, lateMinutes) {
  const db = readDb();
  if (db.attendance.find(a => a.lineId === lineId && a.date === date)) {
    return { error: '今日已打過上班卡' };
  }
  const record = {
    id: uuidv4(), lineId, date,
    checkIn: time, checkOut: null,
    checkInLat: location?.lat || null, checkInLng: location?.lng || null,
    checkOutLat: null, checkOutLng: null,
    status: status || 'normal', workHours: null,
    lateMinutes: lateMinutes || 0,
    createdAt: new Date().toISOString()
  };
  db.attendance.push(record);
  writeDb(db);
  return record;
}

function updateAttendance(id, updates) {
  const db = readDb();
  const idx = db.attendance.findIndex(a => a.id === id);
  if (idx < 0) return null;
  // Recalculate workHours if both times present
  const merged = { ...db.attendance[idx], ...updates };
  if (merged.checkIn && merged.checkOut) {
    merged.workHours = calcWorkHours(merged.checkIn, merged.checkOut);
  }
  db.attendance[idx] = merged;
  writeDb(db);
  return db.attendance[idx];
}

function deleteAttendance(id) {
  const db = readDb();
  db.attendance = db.attendance.filter(a => a.id !== id);
  writeDb(db);
}

function addAttendance({ lineId, date, checkIn, checkOut, status }) {
  const db = readDb();
  if (db.attendance.find(a => a.lineId === lineId && a.date === date)) {
    return { error: '該日期已有記錄' };
  }
  const record = {
    id: uuidv4(), lineId, date,
    checkIn: checkIn || null, checkOut: checkOut || null,
    checkInLat: null, checkInLng: null, checkOutLat: null, checkOutLng: null,
    status: status || 'normal',
    workHours: checkIn && checkOut ? calcWorkHours(checkIn, checkOut) : null,
    createdAt: new Date().toISOString(), manualEntry: true
  };
  db.attendance.push(record);
  writeDb(db);
  return record;
}

function checkOut(lineId, date, time, location) {
  const db = readDb();
  const idx = db.attendance.findIndex(a => a.lineId === lineId && a.date === date);
  if (idx < 0) return { error: '今日尚未打上班卡' };
  if (db.attendance[idx].checkOut) return { error: '今日已打過下班卡' };
  db.attendance[idx].checkOut = time;
  db.attendance[idx].checkOutLat = location?.lat || null;
  db.attendance[idx].checkOutLng = location?.lng || null;
  db.attendance[idx].workHours = calcWorkHours(db.attendance[idx].checkIn, time);
  writeDb(db);
  return db.attendance[idx];
}

// ── 假單 ──────────────────────────────────────────
function getAllLeaves() {
  return readDb().leaves;
}

function getLeavesByEmployee(lineId) {
  return readDb().leaves.filter(l => l.lineId === lineId);
}

function createLeave({ lineId, date, type, reason }) {
  const db = readDb();
  const leave = {
    id: uuidv4(), lineId, date, type, reason,
    status: 'pending',
    createdAt: new Date().toISOString(),
    reviewedAt: null, reviewNote: null
  };
  db.leaves.push(leave);
  writeDb(db);
  return leave;
}

function reviewLeave(id, status, note) {
  const db = readDb();
  const idx = db.leaves.findIndex(l => l.id === id);
  if (idx < 0) return null;
  db.leaves[idx].status = status;
  db.leaves[idx].reviewNote = note || '';
  db.leaves[idx].reviewedAt = new Date().toISOString();
  writeDb(db);
  return db.leaves[idx];
}

// ── 公告 ─────────────────────────────────────────────
function getAllAnnouncements() {
  const db = readDb();
  return db.announcements || [];
}

function createAnnouncement({ title, content }) {
  const db = readDb();
  if (!db.announcements) db.announcements = [];
  const ann = {
    id: uuidv4(), title, content,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.announcements.push(ann);
  writeDb(db);
  return ann;
}

function updateAnnouncement(id, updates) {
  const db = readDb();
  if (!db.announcements) return null;
  const idx = db.announcements.findIndex(a => a.id === id);
  if (idx < 0) return null;
  db.announcements[idx] = { ...db.announcements[idx], ...updates, updatedAt: new Date().toISOString() };
  writeDb(db);
  return db.announcements[idx];
}

function deleteAnnouncement(id) {
  const db = readDb();
  if (!db.announcements) return;
  db.announcements = db.announcements.filter(a => a.id !== id);
  writeDb(db);
}

// ── 補打卡申請 ──────────────────────────────────────────
function getAllPunchRequests() {
  const db = readDb();
  return db.punchRequests || [];
}

function createPunchRequest({ lineId, date, type, requestedTime, reason }) {
  const db = readDb();
  if (!db.punchRequests) db.punchRequests = [];
  const request = {
    id: uuidv4(), lineId, date, type, requestedTime, reason,
    status: 'pending',
    createdAt: new Date().toISOString(),
    reviewedAt: null, reviewNote: null
  };
  db.punchRequests.push(request);
  writeDb(db);
  return request;
}

function reviewPunchRequest(id, status, note) {
  const db = readDb();
  if (!db.punchRequests) return null;
  const idx = db.punchRequests.findIndex(r => r.id === id);
  if (idx < 0) return null;
  db.punchRequests[idx].status = status;
  db.punchRequests[idx].reviewNote = note || '';
  db.punchRequests[idx].reviewedAt = new Date().toISOString();
  writeDb(db);
  return db.punchRequests[idx];
}

// ── 系統設定 ─────────────────────────────────────────
function getSettings() {
  return readDb().settings || {};
}

function updateSettings(patch) {
  const db = readDb();
  db.settings = { ...db.settings, ...patch };
  writeDb(db);
  return db.settings;
}

// ── 公司設定 ──────────────────────────────────────────
const DEFAULT_COMPANIES = [
  {
    id: 'jiamao',
    name: '佳懋聯合設計有限公司',
    workStart: '08:00',
    workEnd: '17:00',
    overtimeStart: '17:30',
  },
  {
    id: 'shengxing',
    name: '晟涬金屬建材有限公司',
    workStart: '08:00',
    workEnd: '17:00',
    overtimeStart: '17:30',
  },
];

function getCompanies() {
  const db = readDb();
  if (!db.companies || db.companies.length === 0) {
    db.companies = DEFAULT_COMPANIES;
    writeDb(db);
  }
  return db.companies;
}

function updateCompany(id, updates) {
  const db = readDb();
  if (!db.companies) db.companies = DEFAULT_COMPANIES;
  const idx = db.companies.findIndex(c => c.id === id);
  if (idx < 0) return null;
  db.companies[idx] = { ...db.companies[idx], ...updates };
  writeDb(db);
  return db.companies[idx];
}

// ── 薪資設定（以 lineId 為 key）──────────────────────────
function getSalarySettings(lineId) {
  const db = readDb();
  return (db.salarySettings || {})[lineId] || null;
}

function getAllSalarySettings() {
  const db = readDb();
  return db.salarySettings || {};
}

function updateSalarySettings(lineId, updates) {
  const db = readDb();
  if (!db.salarySettings) db.salarySettings = {};
  db.salarySettings[lineId] = { ...(db.salarySettings[lineId] || {}), ...updates };
  writeDb(db);
  return db.salarySettings[lineId];
}

// ── 加班申請 ──────────────────────────────────────────
function getAllOvertimeRequests() {
  const db = readDb();
  return db.overtimeRequests || [];
}

function createOvertimeRequest({ lineId, date, startTime, endTime, hours, reason }) {
  const db = readDb();
  if (!db.overtimeRequests) db.overtimeRequests = [];
  const req = {
    id: uuidv4(), lineId, date, startTime, endTime,
    hours: Number(hours) || 0,
    reason,
    status: 'pending',
    reviewNote: '',
    reviewedAt: null,
    createdAt: new Date().toISOString(),
  };
  db.overtimeRequests.push(req);
  writeDb(db);
  return req;
}

function reviewOvertimeRequest(id, status, note) {
  const db = readDb();
  if (!db.overtimeRequests) return null;
  const idx = db.overtimeRequests.findIndex(r => r.id === id);
  if (idx < 0) return null;
  db.overtimeRequests[idx].status = status;
  db.overtimeRequests[idx].reviewNote = note || '';
  db.overtimeRequests[idx].reviewedAt = new Date().toISOString();
  writeDb(db);
  return db.overtimeRequests[idx];
}

// ── 薪資單 ──────────────────────────────────────────
function getAllPayrolls() {
  const db = readDb();
  return db.payrolls || [];
}

function getPayroll(lineId, year, month) {
  return getAllPayrolls().find(p => p.lineId === lineId && p.year === year && p.month === month) || null;
}

function savePayroll(payroll) {
  const db = readDb();
  if (!db.payrolls) db.payrolls = [];
  const existing = db.payrolls.findIndex(
    p => p.lineId === payroll.lineId && p.year === payroll.year && p.month === payroll.month
  );
  if (existing >= 0) {
    db.payrolls[existing] = { ...db.payrolls[existing], ...payroll, updatedAt: new Date().toISOString() };
    writeDb(db);
    return db.payrolls[existing];
  }
  const record = { id: uuidv4(), ...payroll, status: 'draft', createdAt: new Date().toISOString() };
  db.payrolls.push(record);
  writeDb(db);
  return record;
}

function updatePayroll(id, updates) {
  const db = readDb();
  if (!db.payrolls) return null;
  const idx = db.payrolls.findIndex(p => p.id === id);
  if (idx < 0) return null;
  db.payrolls[idx] = { ...db.payrolls[idx], ...updates, updatedAt: new Date().toISOString() };
  writeDb(db);
  return db.payrolls[idx];
}

function deletePayroll(id) {
  const db = readDb();
  if (!db.payrolls) return;
  db.payrolls = db.payrolls.filter(p => p.id !== id);
  writeDb(db);
}

module.exports = {
  getEmployee, getAllEmployees, createEmployee, updateEmployee, deleteEmployee,
  getTodayRecord, getAllAttendance, checkIn, checkOut,
  updateAttendance, deleteAttendance, addAttendance,
  getAllLeaves, getLeavesByEmployee, createLeave, reviewLeave,
  getAllPunchRequests, createPunchRequest, reviewPunchRequest,
  getAllAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement,
  getSettings, updateSettings,
  getCompanies, updateCompany,
  getSalarySettings, getAllSalarySettings, updateSalarySettings,
  getAllOvertimeRequests, createOvertimeRequest, reviewOvertimeRequest,
  getAllPayrolls, getPayroll, savePayroll, updatePayroll, deletePayroll,
};
