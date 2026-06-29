const db = require('./db');
const client = require('./lineClient');
const { getTaipeiTime, isLate, getLateMinutes, WEEKDAYS } = require('./utils');

const userStates = {};

const LEAVE_TYPES = { annual: '特休假', sick: '病假', personal: '事假', other: '其他假別' };

function getAdminIds() {
  return db.getAllEmployees().filter(e => e.role === 'admin').map(e => e.lineId);
}

async function handleEvent(event) {
  const lineId = event.source.userId;
  try {
    if (event.type === 'follow') return handleFollow(event, lineId);
    if (event.type === 'message' && event.message.type === 'text') return handleText(event, lineId);
    if (event.type === 'message' && event.message.type === 'location') return handleLocation(event, lineId);
    if (event.type === 'postback') return handlePostback(event, lineId);
  } catch (err) {
    console.error('LINE event error:', err.message);
  }
}

// ── 加入時 ──────────────────────────────────────────
async function handleFollow(event, lineId) {
  return reply(event.replyToken, '👋 歡迎使用打卡系統！\n\n請先完成綁定，輸入：\n綁定 您的姓名\n\n例如：綁定 王小明');
}

// ── 文字訊息 ────────────────────────────────────────
async function handleText(event, lineId) {
  const text = event.message.text.trim();
  const employee = db.getEmployee(lineId);

  // 跳過 GPS（快速回覆選項）
  if (text === '__skip_checkin__') return doCheckIn(event, lineId, employee, null);
  if (text === '__skip_checkout__') return doCheckOut(event, lineId, employee, null);

  // 綁定
  if (text.startsWith('綁定')) {
    const name = text.replace(/^綁定[\s　]+/, '').trim();
    if (!name) return reply(event.replyToken, '請輸入姓名，例如：綁定 王小明');
    const emp = db.createEmployee({ lineId, name });
    return reply(event.replyToken, `✅ 綁定成功！\n姓名：${emp.name}\n\n輸入「選單」查看所有功能`);
  }

  if (!employee) {
    return reply(event.replyToken, '您尚未綁定帳號，請輸入：\n綁定 您的姓名\n\n例如：綁定 王小明');
  }

  // 多步驟流程
  if (userStates[lineId]) return handleState(event, lineId, text, employee);

  const cmd = text;

  if (/選單|menu|主選單|help/.test(cmd)) return sendMenu(event.replyToken, employee);
  if (/上班打卡|打卡上班|上班|签到/.test(cmd)) return askLocation(event, lineId, employee, 'checkin');
  if (/下班打卡|打卡下班|下班|签退/.test(cmd)) return askLocation(event, lineId, employee, 'checkout');
  if (/申請請假|請假|假單/.test(cmd)) return startLeave(event, lineId);
  if (/出勤記錄|我的記錄|打卡記錄|查詢/.test(cmd)) return sendMyRecord(event.replyToken, lineId, employee);
  if (/假單記錄|請假記錄/.test(cmd)) return sendMyLeaves(event.replyToken, lineId, employee);
  if (/公司公告|公告/.test(cmd)) return sendAnnouncements(event.replyToken);
  if (/忘記打卡|補打卡/.test(cmd)) return sendForgotLink(event.replyToken);
  if (/加班申請|申請加班/.test(cmd)) return startOvertimeRequest(event, lineId);
  if (/查薪資|薪資單|我的薪資/.test(cmd)) return sendMyPayroll(event.replyToken, lineId, employee);

  if (employee.role === 'admin') {
    if (/今日出勤|出勤狀況/.test(cmd)) return sendTodayStats(event.replyToken);
    if (/待審假單|審核假單/.test(cmd)) return sendPendingLeaves(event.replyToken);
    if (/月報表|出勤報表/.test(cmd)) return sendMonthlyReport(event.replyToken);
    if (/待審加班|加班審核/.test(cmd)) return sendPendingOvertimeRequests(event.replyToken);
  }

  return sendMenu(event.replyToken, employee);
}

// ── GPS 位置訊息 ─────────────────────────────────────
async function handleLocation(event, lineId) {
  const employee = db.getEmployee(lineId);
  const state = userStates[lineId];
  if (!state || state.step !== 'location') return;
  delete userStates[lineId];

  const location = { lat: event.message.latitude, lng: event.message.longitude };
  if (state.action === 'checkin') return doCheckIn(event, lineId, employee, location);
  if (state.action === 'checkout') return doCheckOut(event, lineId, employee, location);
}

// ── Postback ─────────────────────────────────────────
async function handlePostback(event, lineId) {
  const employee = db.getEmployee(lineId);
  if (!employee) return;

  const p = new URLSearchParams(event.postback.data);
  const action = p.get('action');

  if (action === 'checkin') return askLocation(event, lineId, employee, 'checkin');
  if (action === 'checkout') return askLocation(event, lineId, employee, 'checkout');
  if (action === 'leave') return startLeave(event, lineId);
  if (action === 'my_record') return sendMyRecord(event.replyToken, lineId, employee);
  if (action === 'my_leaves') return sendMyLeaves(event.replyToken, lineId, employee);

  if (action === 'leave_type') {
    const type = p.get('type');
    userStates[lineId] = { step: 'leave_date', data: { type } };
    return client.replyMessage({ replyToken: event.replyToken, messages: [makeDatePickerFlex(type)] });
  }

  if (action === 'leave_date') {
    const type = p.get('type');
    const date = p.get('date');
    userStates[lineId] = { step: 'leave_reason', data: { type, date } };
    return reply(event.replyToken, `📋 假別：${LEAVE_TYPES[type]}\n📅 日期：${date}\n\n請輸入請假原因：`);
  }

  if (action === 'review_leave') {
    const id = p.get('id');
    const status = p.get('status');
    const leave = db.reviewLeave(id, status);
    if (!leave) return reply(event.replyToken, '找不到此假單');
    const statusText = status === 'approved' ? '✅ 已核准' : '❌ 已駁回';
    await reply(event.replyToken, `假單審核完成 ${statusText}`);
    const emp = db.getEmployee(leave.lineId);
    client.pushMessage({
      to: leave.lineId,
      messages: [{ type: 'text', text: `📋 假單審核結果\n\n姓名：${emp?.name || '員工'}\n日期：${leave.date}\n假別：${LEAVE_TYPES[leave.type]}\n狀態：${statusText}` }]
    }).catch(console.error);
  }
}

// ── 多步驟狀態處理 ─────────────────────────────────────
async function handleState(event, lineId, text, employee) {
  const state = userStates[lineId];

  if (state.step === 'leave_date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return reply(event.replyToken, '日期格式錯誤，請輸入 YYYY-MM-DD\n例如：2026-05-15');
    }
    userStates[lineId] = { step: 'leave_reason', data: { ...state.data, date: text } };
    return reply(event.replyToken, `📋 假別：${LEAVE_TYPES[state.data.type]}\n📅 日期：${text}\n\n請輸入請假原因：`);
  }

  if (state.step === 'leave_reason') {
    const { type, date } = state.data;
    const leave = db.createLeave({ lineId, date, type, reason: text });
    delete userStates[lineId];

    const adminIds = getAdminIds();
    for (const adminId of adminIds) {
      client.pushMessage({
        to: adminId,
        messages: [makeLeaveNotifyFlex(leave, employee)]
      }).catch(console.error);
    }

    return reply(event.replyToken, `📋 請假申請已送出！\n\n👤 ${employee.name}\n假別：${LEAVE_TYPES[type]}\n日期：${date}\n原因：${text}\n\n等待主管審核中...`);
  }

  // ── 加班申請步驟 ──
  if (state.step === 'ot_date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return reply(event.replyToken, '日期格式錯誤，請輸入 YYYY-MM-DD\n例如：2026-05-25');
    }
    userStates[lineId] = { step: 'ot_start', data: { date: text } };
    return reply(event.replyToken, `📅 加班日期：${text}\n\n請輸入加班開始時間（格式 HH:MM）\n例如：17:30`);
  }

  if (state.step === 'ot_start') {
    if (!/^\d{2}:\d{2}$/.test(text)) {
      return reply(event.replyToken, '時間格式錯誤，請輸入 HH:MM\n例如：17:30');
    }
    userStates[lineId] = { step: 'ot_end', data: { ...state.data, startTime: text } };
    return reply(event.replyToken, `開始時間：${text}\n\n請輸入加班結束時間（格式 HH:MM）\n例如：20:00`);
  }

  if (state.step === 'ot_end') {
    if (!/^\d{2}:\d{2}$/.test(text)) {
      return reply(event.replyToken, '時間格式錯誤，請輸入 HH:MM\n例如：20:00');
    }
    const { date, startTime } = state.data;
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = text.split(':').map(Number);
    const hours = Math.round(((eh * 60 + em) - (sh * 60 + sm)) / 6) / 10;
    if (hours <= 0) {
      return reply(event.replyToken, '結束時間必須晚於開始時間，請重新輸入：');
    }
    userStates[lineId] = { step: 'ot_reason', data: { ...state.data, endTime: text, hours } };
    return reply(event.replyToken, `時段：${startTime}～${text}（${hours}H）\n\n請輸入加班原因：`);
  }

  if (state.step === 'ot_reason') {
    const { date, startTime, endTime, hours } = state.data;
    const req = db.createOvertimeRequest({ lineId, date, startTime, endTime, hours, reason: text });
    delete userStates[lineId];
    const adminIds = getAdminIds();
    for (const adminId of adminIds) {
      client.pushMessage({
        to: adminId,
        messages: [{ type: 'text', text: `⏰ 加班申請\n\n姓名：${employee.name}\n日期：${date}\n時段：${startTime}～${endTime}（${hours}H）\n原因：${text}\n\n請至後台「薪資系統 > 加班申請」審核` }]
      }).catch(console.error);
    }
    return reply(event.replyToken, `✅ 加班申請已送出！\n\n姓名：${employee.name}\n日期：${date}\n時段：${startTime}～${endTime}（${hours}H）\n原因：${text}\n\n等待主管審核，結果會透過 LINE 通知您。`);
  }

  delete userStates[lineId];
  return reply(event.replyToken, '已取消，輸入「選單」重新操作。');
}

// ── 詢問位置 ─────────────────────────────────────────
async function askLocation(event, lineId, employee, action) {
  const { date, time } = getTaipeiTime();

  if (action === 'checkin') {
    const existing = db.getTodayRecord(lineId, date);
    if (existing?.checkIn) return reply(event.replyToken, `❌ 您今日已於 ${existing.checkIn} 打過上班卡`);
  }
  if (action === 'checkout') {
    const existing = db.getTodayRecord(lineId, date);
    if (!existing?.checkIn) return reply(event.replyToken, '❌ 您今日尚未打上班卡');
    if (existing?.checkOut) return reply(event.replyToken, `❌ 您今日已於 ${existing.checkOut} 打過下班卡`);
  }

  userStates[lineId] = { step: 'location', action, data: { date, time } };

  const skipMsg = action === 'checkin' ? '__skip_checkin__' : '__skip_checkout__';
  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [{
      type: 'text',
      text: '📍 請分享您的位置以完成打卡',
      quickReply: {
        items: [
          { type: 'action', action: { type: 'location', label: '📍 分享位置' } },
          { type: 'action', action: { type: 'message', label: '略過位置', text: skipMsg } }
        ]
      }
    }]
  });
}

// ── 實際打卡動作 ─────────────────────────────────────
async function doCheckIn(event, lineId, employee, location) {
  if (!employee) return;
  const { date, time } = userStates[lineId]?.data || getTaipeiTime();
  delete userStates[lineId];

  const late = isLate(time);
  const result = db.checkIn(lineId, date, time, location, late ? 'late' : 'normal');
  if (result.error) return reply(event.replyToken, `❌ ${result.error}`);

  const lateMsg = late ? `\n⚠️ 今日遲到（規定 ${process.env.WORK_START || '09:00'}）` : '';
  const gpsMsg = location ? '\n📍 位置已記錄' : '';
  await reply(event.replyToken, `✅ 上班打卡成功！\n\n👤 ${employee.name}\n📅 ${date}（週${WEEKDAYS[new Date(date).getDay()]}）\n🕐 ${time}${lateMsg}${gpsMsg}`);

  getAdminIds().forEach(adminId => {
    client.pushMessage({
      to: adminId,
      messages: [{ type: 'text', text: `📍 打卡通知\n${employee.name} 已上班打卡\n時間：${time}${late ? ' ⚠️遲到' : ''}` }]
    }).catch(console.error);
  });
}

async function doCheckOut(event, lineId, employee, location) {
  if (!employee) return;
  const { date, time } = userStates[lineId]?.data || getTaipeiTime();
  delete userStates[lineId];

  const result = db.checkOut(lineId, date, time, location);
  if (result.error) return reply(event.replyToken, `❌ ${result.error}`);

  const gpsMsg = location ? '\n📍 位置已記錄' : '';
  await reply(event.replyToken, `✅ 下班打卡成功！\n\n👤 ${employee.name}\n📅 ${date}\n🕕 ${time}\n⏱️ 今日工時：${result.workHours} 小時${gpsMsg}`);

  getAdminIds().forEach(adminId => {
    client.pushMessage({
      to: adminId,
      messages: [{ type: 'text', text: `📍 打卡通知\n${employee.name} 已下班打卡\n時間：${time}\n⏱️ 今日工時：${result.workHours} 小時` }]
    }).catch(console.error);
  });
}

// ── 選單 ─────────────────────────────────────────────
async function sendMenu(replyToken, employee) {
  const isAdmin = employee.role === 'admin';
  const items = [
    { label: '☀️ 打卡上班', data: 'action=checkin' },
    { label: '🌙 打卡下班', data: 'action=checkout' },
    { label: '📋 申請請假', data: 'action=leave' },
    { label: '📊 出勤記錄', data: 'action=my_record' },
  ];

  let text = `👋 ${employee.name}，您好！請選擇操作：\n\n⏰ 加班申請｜查薪資`;
  if (isAdmin) text += '\n\n💼 管理員指令：\n今日出勤｜待審假單｜月報表｜待審加班';

  return client.replyMessage({
    replyToken,
    messages: [{
      type: 'text',
      text,
      quickReply: {
        items: items.map(i => ({
          type: 'action',
          action: { type: 'postback', label: i.label, data: i.data, displayText: i.label }
        }))
      }
    }]
  });
}

// ── 個人記錄 ─────────────────────────────────────────
async function sendMyRecord(replyToken, lineId, employee) {
  const { month } = getTaipeiTime();
  const records = db.getAllAttendance().filter(a => a.lineId === lineId && a.date.startsWith(month));
  records.sort((a, b) => a.date.localeCompare(b.date));

  const workDays = records.filter(a => a.checkIn).length;
  const totalHours = records.reduce((s, a) => s + (a.workHours || 0), 0);
  const lateDays = records.filter(a => a.status === 'late').length;

  let text = `📊 ${employee.name} 的出勤記錄\n📅 ${month}\n\n出勤：${workDays} 天｜工時：${Math.round(totalHours * 10) / 10}h｜遲到：${lateDays} 次\n──────────────\n`;
  records.slice(-7).forEach(r => {
    const day = WEEKDAYS[new Date(r.date).getDay()];
    text += `${r.date.slice(5)}（週${day}）${r.status === 'late' ? '⚠️' : ''}\n  上班：${r.checkIn || '--:--'}  下班：${r.checkOut || '--:--'}\n`;
  });

  return reply(replyToken, text);
}

async function sendMyLeaves(replyToken, lineId, employee) {
  const leaves = db.getLeavesByEmployee(lineId).slice(-5).reverse();
  if (!leaves.length) return reply(replyToken, '📋 您目前沒有假單記錄');

  const emoji = { pending: '⏳', approved: '✅', rejected: '❌' };
  const label = { pending: '待審核', approved: '已核准', rejected: '已駁回' };

  let text = `📋 ${employee.name} 的假單記錄\n\n`;
  leaves.forEach(l => {
    text += `${emoji[l.status]} ${l.date} ${LEAVE_TYPES[l.type]} · ${label[l.status]}\n原因：${l.reason}\n\n`;
  });
  return reply(replyToken, text);
}

// ── 公告 & 補打卡連結 ─────────────────────────────────
async function sendAnnouncements(replyToken) {
  const anns = db.getAllAnnouncements().filter(a => a.active).slice(-5).reverse();
  if (!anns.length) return reply(replyToken, '📢 目前沒有公告');
  const text = '📢 公司公告\n' + '─'.repeat(14) + '\n\n' +
    anns.map(a => `【${a.title}】\n${a.content}`).join('\n\n' + '─'.repeat(14) + '\n\n');
  return reply(replyToken, text);
}

async function sendForgotLink(replyToken) {
  const url = `https://liff.line.me/${process.env.LIFF_ID}?action=forgot`;
  return reply(replyToken, `📝 補打卡申請\n\n點下方連結開啟申請表單：\n${url}\n\n填寫忘記打卡的原因後送出，等待主管審核，結果會透過 LINE 通知您。`);
}

// ── 管理員指令 ────────────────────────────────────────
async function sendTodayStats(replyToken) {
  const { date } = getTaipeiTime();
  const employees = db.getAllEmployees().filter(e => e.role === 'employee');
  const todayRecords = db.getAllAttendance().filter(r => r.date === date);
  const checkedIn = todayRecords.filter(r => r.checkIn);
  const notCheckedIn = employees.filter(e => !checkedIn.find(r => r.lineId === e.lineId));

  let text = `📋 今日出勤（${date}）\n員工：${employees.length}人｜已打：${checkedIn.length}人｜未打：${notCheckedIn.length}人\n──────────────\n`;
  if (checkedIn.length) {
    text += '✅ 已打卡：\n';
    checkedIn.forEach(r => {
      const emp = employees.find(e => e.lineId === r.lineId);
      text += `  ${emp?.name || '?'} ${r.checkIn}${r.status === 'late' ? ' ⚠️' : ''}\n`;
    });
  }
  if (notCheckedIn.length) {
    text += '\n❌ 未打卡：\n';
    notCheckedIn.forEach(e => { text += `  ${e.name}\n`; });
  }
  return reply(replyToken, text);
}

async function sendPendingLeaves(replyToken) {
  const pending = db.getAllLeaves().filter(l => l.status === 'pending');
  if (!pending.length) return reply(replyToken, '✅ 目前沒有待審核假單');

  const messages = [{ type: 'text', text: `📋 待審假單（${pending.length} 件）` }];
  pending.slice(0, 5).forEach(leave => {
    const emp = db.getEmployee(leave.lineId);
    messages.push(makeLeaveReviewFlex(leave, emp));
  });
  return client.replyMessage({ replyToken, messages });
}

async function sendMonthlyReport(replyToken) {
  const { month } = getTaipeiTime();
  const employees = db.getAllEmployees().filter(e => e.role === 'employee');
  const attendance = db.getAllAttendance().filter(r => r.date.startsWith(month));

  let text = `📊 ${month} 月出勤報表\n──────────────\n`;
  employees.forEach(emp => {
    const recs = attendance.filter(a => a.lineId === emp.lineId);
    const days = recs.filter(a => a.checkIn).length;
    const hours = Math.round(recs.reduce((s, a) => s + (a.workHours || 0), 0) * 10) / 10;
    const late = recs.filter(a => a.status === 'late').length;
    text += `👤 ${emp.name}\n出勤 ${days}天｜工時 ${hours}h｜遲到 ${late}次\n\n`;
  });
  text += '💡 詳細報表請至管理後台';
  return reply(replyToken, text);
}

// ── Flex Message 模板 ─────────────────────────────────
function makeLeaveNotifyFlex(leave, employee) {
  return {
    type: 'flex',
    altText: `${employee.name} 申請${LEAVE_TYPES[leave.type]}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#3B82F6',
        contents: [{ type: 'text', text: '📋 請假申請通知', weight: 'bold', size: 'lg', color: '#ffffff' }]
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `👤 ${employee.name}`, weight: 'bold' },
          { type: 'text', text: `📅 ${leave.date}`, color: '#555555' },
          { type: 'text', text: `假別：${LEAVE_TYPES[leave.type]}`, color: '#555555' },
          { type: 'text', text: `原因：${leave.reason}`, color: '#555555', wrap: true }
        ]
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#10B981', action: { type: 'postback', label: '✅ 核准', data: `action=review_leave&id=${leave.id}&status=approved`, displayText: '核准假單' } },
          { type: 'button', style: 'primary', color: '#EF4444', action: { type: 'postback', label: '❌ 駁回', data: `action=review_leave&id=${leave.id}&status=rejected`, displayText: '駁回假單' } }
        ]
      }
    }
  };
}

function makeLeaveReviewFlex(leave, employee) {
  return {
    type: 'flex',
    altText: `待審假單：${employee?.name}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `👤 ${employee?.name || '未知'}`, weight: 'bold' },
          { type: 'text', text: `📅 ${leave.date} ｜ ${LEAVE_TYPES[leave.type]}`, color: '#555555' },
          { type: 'text', text: `原因：${leave.reason}`, color: '#555555', wrap: true }
        ]
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#10B981', action: { type: 'postback', label: '✅ 核准', data: `action=review_leave&id=${leave.id}&status=approved`, displayText: '核准' } },
          { type: 'button', style: 'primary', color: '#EF4444', action: { type: 'postback', label: '❌ 駁回', data: `action=review_leave&id=${leave.id}&status=rejected`, displayText: '駁回' } }
        ]
      }
    }
  };
}

// ── 工具 ─────────────────────────────────────────────
function startLeave(event, lineId) {
  userStates[lineId] = null;
  const icons = { annual: '🌴', sick: '🏥', personal: '🙋', other: '📄' };
  const descs = { annual: '年度特休假', sick: '身體不適', personal: '私人事務', other: '其他原因' };
  const contents = Object.entries(LEAVE_TYPES).map(([key, label]) => ({
    type: 'bubble', size: 'micro',
    header: { type: 'box', layout: 'vertical', backgroundColor: '#1A1A1A', paddingAll: 'md',
      contents: [{ type: 'text', text: icons[key], size: 'xxl', align: 'center' }] },
    body: { type: 'box', layout: 'vertical', paddingAll: 'md', spacing: 'sm',
      contents: [
        { type: 'text', text: label, weight: 'bold', size: 'md', align: 'center' },
        { type: 'text', text: descs[key], size: 'xs', color: '#888888', align: 'center', wrap: true }
      ]
    },
    footer: { type: 'box', layout: 'vertical', paddingAll: 'sm',
      contents: [{ type: 'button', style: 'primary', color: '#C9A55A', height: 'sm',
        action: { type: 'postback', label: '選擇', data: `action=leave_type&type=${key}`, displayText: label }
      }]
    }
  }));
  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'flex', altText: '請選擇假別', contents: { type: 'carousel', contents } }]
  });
}

function makeDatePickerFlex(type) {
  const { date } = getTaipeiTime();
  const addDays = (d, n) => {
    const dt = new Date(d); dt.setDate(dt.getDate() + n);
    return dt.toISOString().slice(0, 10);
  };
  const dates = [
    { label: `今天  ${date}`, date },
    { label: `明天  ${addDays(date, 1)}`, date: addDays(date, 1) },
    { label: `後天  ${addDays(date, 2)}`, date: addDays(date, 2) },
  ];
  return {
    type: 'flex', altText: '請選擇請假日期',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#1A1A1A', paddingAll: 'lg',
        contents: [
          { type: 'text', text: '📅 請選擇日期', color: '#C9A55A', weight: 'bold', size: 'md' },
          { type: 'text', text: `假別：${LEAVE_TYPES[type]}`, color: '#ffffff', size: 'sm', margin: 'sm' }
        ]
      },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'md',
        contents: [
          ...dates.map(d => ({
            type: 'button', style: 'secondary', height: 'sm',
            action: { type: 'postback', label: d.label, data: `action=leave_date&type=${type}&date=${d.date}`, displayText: d.date }
          })),
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '或直接輸入日期（YYYY-MM-DD）', size: 'xs', color: '#999999', align: 'center', margin: 'md', wrap: true }
        ]
      }
    }
  };
}

function reply(replyToken, text) {
  return client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
}

// ── 加班申請啟動 ─────────────────────────────────────────
function startOvertimeRequest(event, lineId) {
  const { date } = getTaipeiTime();
  userStates[lineId] = { step: 'ot_date', data: {} };
  return reply(event.replyToken, `⏰ 加班申請\n\n請輸入加班日期（格式 YYYY-MM-DD）\n今天：${date}\n\n輸入「取消」可隨時退出`);
}

// ── 查薪資 ────────────────────────────────────────────
async function sendMyPayroll(replyToken, lineId, employee) {
  const { month } = getTaipeiTime();
  const [yearStr, monthStr] = month.split('-');
  const payrolls = db.getAllPayrolls().filter(
    p => p.lineId === lineId && p.year === Number(yearStr) && p.month === Number(monthStr)
  );

  if (!payrolls.length) {
    const prev = new Date();
    prev.setMonth(prev.getMonth() - 1);
    const prevMonth = prev.toISOString().slice(0, 7);
    const [py, pm] = prevMonth.split('-');
    const prevPayrolls = db.getAllPayrolls().filter(
      p => p.lineId === lineId && p.year === Number(py) && p.month === Number(pm)
    );
    if (!prevPayrolls.length) {
      return reply(replyToken, `📊 目前尚無薪資資料\n\n如有疑問請聯繫管理員`);
    }
    return formatPayrollReply(replyToken, prevPayrolls[0]);
  }
  return formatPayrollReply(replyToken, payrolls[0]);
}

function formatPayrollReply(replyToken, p) {
  const companies = db.getCompanies();
  const co = companies.find(c => c.id === p.companyId);
  const inc = p.income || {};
  const ded = p.deductions || {};
  const lines = [
    `💰 ${p.year}年${p.month}月薪資單`,
    `公司：${co?.name || '-'}`,
    ``,
    `【應付】`,
    `底薪：$${(inc.baseSalary || 0).toLocaleString()}`,
    inc.jobAllowance ? `職務加給：$${inc.jobAllowance.toLocaleString()}` : '',
    inc.mealAllowance ? `伙食津貼：$${inc.mealAllowance.toLocaleString()}` : '',
    inc.overtimePay ? `加班費：$${inc.overtimePay.toLocaleString()}` : '',
    (inc.transportAllowance || inc.phoneAllowance) ? `其他津貼��$${((inc.transportAllowance||0)+(inc.phoneAllowance||0)).toLocaleString()}` : '',
    `應付合計：$${(p.totalIncome || 0).toLocaleString()}`,
    ``,
    `【應扣】`,
    `勞保：$${(ded.laborInsurance || 0).toLocaleString()}`,
    `健保：$${(ded.healthInsurance || 0).toLocaleString()}`,
    ded.lateDeduction ? `遲到扣款：$${ded.lateDeduction.toLocaleString()}` : '',
    ded.leaveDeduction ? `假別扣款：$${ded.leaveDeduction.toLocaleString()}` : '',
    `應扣合計：$${(p.totalDeductions || 0).toLocaleString()}`,
    ``,
    `✅ 實領薪資：$${(p.netSalary || 0).toLocaleString()}`,
    p.notes ? `備注：${p.notes}` : '',
    ``,
    `出勤${p.summary?.attendanceDays || 0}天｜加班${p.summary?.totalOTHours || 0}H｜遲到${p.summary?.totalLateMinutes || 0}分`,
  ].filter(l => l !== undefined && l !== null);

  return reply(replyToken, lines.filter(Boolean).join('\n'));
}

// ── 待審加班（管理員）──────────────────────────────────
async function sendPendingOvertimeRequests(replyToken) {
  const pending = db.getAllOvertimeRequests().filter(r => r.status === 'pending');
  if (!pending.length) return reply(replyToken, '目前沒有待審核的加班申請 ✅');
  const employees = db.getAllEmployees();
  const lines = [`⏰ 待審加班申請（${pending.length} 件）\n`];
  pending.slice(0, 10).forEach((r, i) => {
    const emp = employees.find(e => e.lineId === r.lineId);
    lines.push(`${i + 1}. ${emp?.name || '?'} ${r.date} ${r.startTime}～${r.endTime}(${r.hours}H)\n   ${r.reason}`);
  });
  lines.push('\n請至後台「薪資系統 > 加班申請」審核');
  return reply(replyToken, lines.join('\n'));
}

module.exports = { handleEvent };
