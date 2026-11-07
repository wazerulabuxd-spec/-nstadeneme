
const express = require('express');
const fs = require('fs');
const path = require('path');
const { IgApiClient } = require('instagram-private-api');

const app = express();
app.use(express.json());

const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { accounts: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (e) {
    return { accounts: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// Instagram Oturum Oluşturucu (Geliştirilmiş Kararlılık)
async function createIgClient(sessionId) {
  const ig = new IgApiClient();
  
  // Mobil cihaz simülasyonu ve app version eşitleme
  ig.state.generateDevice('instagram_bot_user');
  ig.state.appVersion = '269.0.0.18.75';
  ig.state.deviceString = 'Instagram 269.0.0.18.75 Android (30/11; 480dpi; 1080x2266; OnePlus; LE2110; denali; en_US; 317743284)';
  ig.state.uuid = ig.state.generateUUID();

  // Cookie jar yükleme
  await ig.state.deserializeCookieJar(JSON.stringify({
    cookies: [
      {
        key: 'sessionid',
        value: sessionId.trim(),
        domain: '.instagram.com',
        path: '/',
        secure: true,
        httpOnly: true
      }
    ]
  }));
  
  return ig;
}

// --- API ROUTE'LARI ---

app.post('/api/accounts/add', async (req, res) => {
  let { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Session ID gerekli.' });

  // Temizlik: Başında sessionid= varsa temizle
  sessionId = sessionId.replace('sessionid=', '').trim();

  try {
    const ig = await createIgClient(sessionId);
    const user = await ig.account.currentUser();
    
    const db = loadData();
    const existing = db.accounts.find(a => a.id === user.pk);
    
    const accountData = {
      id: user.pk,
      username: user.username,
      full_name: user.full_name,
      sessionId: sessionId
    };

    if (existing) {
      Object.assign(existing, accountData);
    } else {
      db.accounts.push(accountData);
    }
    
    saveData(db);
    res.json({ success: true, account: accountData });
  } catch (error) {
    res.status(500).json({ error: 'Oturum doğrulanamadı. Hesap Instagram tarafından kilitlenmiş veya şüpheli giriş olarak algılanmış olabilir. Lütfen hesaba tarayıcınızdan tekrar girip çıkış/giriş yapın ve yeni sessionid alın. Detay: ' + error.message });
  }
});

app.get('/api/accounts', (req, res) => {
  const db = loadData();
  res.json(db.accounts);
});

app.get('/api/accounts/:id/threads', async (req, res) => {
  const db = loadData();
  const account = db.accounts.find(a => a.id == req.params.id);
  if (!account) return res.status(404).json({ error: 'Hesap bulunamadı.' });

  try {
    const ig = await createIgClient(account.sessionId);
    const inbox = ig.feed.directInbox();
    const threads = await inbox.items();
    
    const groupThreads = threads.map(t => ({
      threadId: t.thread_id,
      title: t.thread_title || t.users.map(u => u.username).join(', '),
      isGroup: t.is_group
    }));

    res.json(groupThreads);
  } catch (error) {
    res.status(500).json({ error: 'Gruplar çekilemedi, oturum düşmüş olabilir: ' + error.message });
  }
});

const activeJobs = new Map();
const systemLogs = [];

function addLog(username, text, type = 'info') {
  const time = new Date().toLocaleTimeString();
  const logEntry = { time, username, text, type };
  systemLogs.unshift(logEntry);
  if (systemLogs.length > 100) systemLogs.pop();
}

app.post('/api/bot/start', async (req, res) => {
  const { accountId, threadId, messages, delaySeconds, useTyping } = req.body;
  
  if (!accountId || !threadId || !messages || !messages.length) {
    return res.status(400).json({ error: 'Eksik parametreler.' });
  }

  const db = loadData();
  const account = db.accounts.find(a => a.id == accountId);
  if (!account) return res.status(404).json({ error: 'Hesap bulunamadı.' });

  const jobKey = `${accountId}_${threadId}`;
  if (activeJobs.get(jobKey)) {
    return res.status(400).json({ error: 'Bu sohbet için zaten çalışan bir bot var.' });
  }

  activeJobs.set(jobKey, true);
  addLog(account.username, 'Bot sonsuz döngü modunda başlatıldı.', 'success');

  (async () => {
    try {
      const ig = await createIgClient(account.sessionId);
      const thread = ig.entity.directThread(threadId);
      let loopCount = 0;

      while (activeJobs.get(jobKey)) {
        loopCount++;
        addLog(account.username, `Döngü turu #${loopCount} başladı.`, 'info');

        for (let i = 0; i < messages.length; i++) {
          if (!activeJobs.get(jobKey)) break;

          const msgText = messages[i].trim();
          if (!msgText) continue;

          if (useTyping) {
            try {
              await thread.indicateActivity(true);
              await new Promise(r => setTimeout(r, 1500));
            } catch (e) {}
          }

          await thread.broadcastText(msgText);
          addLog(account.username, `Gönderildi: "${msgText}"`, 'success');

          if (i < messages.length - 1 || activeJobs.get(jobKey)) {
            await new Promise(r => setTimeout(r, (delaySeconds || 3) * 1000));
          }
        }
        
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      addLog(account.username, 'Hata: ' + err.message, 'error');
    } finally {
      activeJobs.delete(jobKey);
      addLog(account.username, 'Bot durduruldu.', 'warning');
    }
  })();

  res.json({ success: true, message: 'Sonsuz döngü başlatıldı.' });
});

app.post('/api/bot/stop', (req, res) => {
  const { accountId, threadId } = req.body;
  const jobKey = `${accountId}_${threadId}`;
  activeJobs.delete(jobKey);
  res.json({ success: true, message: 'Durdurma sinyali gönderildi.' });
});

app.get('/api/logs', (req, res) => {
  res.json(systemLogs);
});

// --- HTML ARAYÜZÜ ---
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Instagram Sonsuz Bot</title>
  <style>
    :root {
      --bg: #09090b;
      --card: #121216;
      --accent: #0095f6;
      --text: #f4f4f5;
      --text-muted: #71717a;
      --border: #27272a;
      --danger: #ef4444;
      --success: #22c55e;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background-color: var(--bg); color: var(--text); padding: 12px; display: flex; justify-content: center; }
    .container { width: 100%; max-width: 480px; display: flex; flex-direction: column; gap: 12px; }
    h2 { font-size: 1rem; margin-bottom: 6px; color: var(--text); border-left: 3px solid var(--accent); padding-left: 6px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
    input, select, textarea, button {
      width: 100%; background: #1a1a1e; border: 1px solid var(--border); color: #fff;
      padding: 10px; border-radius: 6px; font-size: 0.85rem; outline: none; margin-top: 4px; margin-bottom: 10px;
    }
    textarea { height: 90px; resize: vertical; }
    input:focus, select:focus, textarea:focus { border-color: var(--accent); }
    button { background: var(--accent); border: none; font-weight: 600; cursor: pointer; transition: 0.2s; }
    button:active { transform: scale(0.98); }
    button.stop-btn { background: var(--danger); }
    .checkbox-group { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .checkbox-group input { width: auto; margin: 0; }
    .log-box {
      background: #050507; border: 1px solid var(--border); border-radius: 6px;
      height: 140px; overflow-y: auto; padding: 8px; font-family: monospace; font-size: 0.75rem;
      display: flex; flex-direction: column; gap: 4px;
    }
    .log-item { word-break: break-all; border-bottom: 1px solid #141418; padding-bottom: 2px; }
    .log-success { color: var(--success); }
    .log-error { color: var(--danger); }
    .log-info { color: #38bdf8; }
    .log-warning { color: #facc15; }
  </style>
</head>
<body>
<div class="container">
  <div class="card">
    <h2>1. Hesap Ekle (Session ID)</h2>
    <input type="text" id="sessionIdInput" placeholder="Session ID yapıştırın...">
    <button onclick="addAccount()">Hesabı Ekle & Doğrula</button>
  </div>
  <div class="card">
    <h2>2. Hesap & Grup Seçimi</h2>
    <label style="font-size: 0.75rem; color: var(--text-muted);">Kayıtlı Hesap</label>
    <select id="accountSelect" onchange="loadGroups()"></select>
    <label style="font-size: 0.75rem; color: var(--text-muted);">Hedef Grup / Sohbet</label>
    <select id="groupSelect"><option value="">Önce hesap seçin...</option></select>
  </div>
  <div class="card">
    <h2>3. Sonsuz Mesaj Döngüsü Ayarları</h2>
    <label style="font-size: 0.75rem; color: var(--text-muted);">Mesaj Tablosu (Her satır 1 mesaj)</label>
    <textarea id="messagesInput" placeholder="1. Mesaj&#10;2. Mesaj"></textarea>
    <label style="font-size: 0.75rem; color: var(--text-muted);">Mesaj Arası Gecikme (Saniye)</label>
    <input type="number" id="delayInput" value="4" min="1">
    <div class="checkbox-group">
      <input type="checkbox" id="typingCheck" checked>
      <label for="typingCheck" style="font-size: 0.8rem;">Instagram Yazıyor... Efekti</label>
    </div>
    <div style="display: flex; gap: 8px;">
      <button onclick="startBot()">Sonsuz Döngüyü Başlat</button>
      <button class="stop-btn" onclick="stopBot()">Durdur</button>
    </div>
  </div>
  <div class="card">
    <h2>Canlı İşlem Konsolu</h2>
    <div id="logBox" class="log-box">
      <div class="log-item log-info">[Sistem] Konsol hazır...</div>
    </div>
  </div>
</div>
<script>
  async function fetchAccounts() {
    const res = await fetch('/api/accounts');
    const accounts = await res.json();
    const select = document.getElementById('accountSelect');
    select.innerHTML = '<option value="">Hesap Seçin...</option>';
    accounts.forEach(acc => {
      select.innerHTML += \`<option value="\${acc.id}">@\${acc.username}</option>\`;
    });
  }
  async function addAccount() {
    const sessionId = document.getElementById('sessionIdInput').value;
    if(!sessionId) return alert('Session ID boş olamaz!');
    const res = await fetch('/api/accounts/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    const data = await res.json();
    if(data.success) {
      alert('Hesap eklendi: @' + data.account.username);
      document.getElementById('sessionIdInput').value = '';
      fetchAccounts();
    } else {
      alert('Hata: ' + data.error);
    }
  }
  async function loadGroups() {
    const accountId = document.getElementById('accountSelect').value;
    const groupSelect = document.getElementById('groupSelect');
    if(!accountId) return;
    groupSelect.innerHTML = '<option value="">Gruplar yükleniyor...</option>';
    const res = await fetch(\`/api/accounts/\${accountId}/threads\`);
    const threads = await res.json();
    if(threads.error) {
      alert(threads.error);
      groupSelect.innerHTML = '<option value="">Yüklenemedi</option>';
      return;
    }
    groupSelect.innerHTML = '';
    threads.forEach(t => {
      groupSelect.innerHTML += \`<option value="\${t.threadId}">\${t.isGroup ? '[GRUP] ' : ''}\${t.title}</option>\`;
    });
  }
  async function startBot() {
    const accountId = document.getElementById('accountSelect5' || 'accountSelect').value;
    const threadId = document.getElementById('groupSelect').value;
    const rawMessages = document.getElementById('messagesInput').value;
    const delaySeconds = parseInt(document.getElementById('delayInput').value);
    const useTyping = document.getElementById('typingCheck').checked;
    if(!accountId || !threadId) return alert('Lütfen hesap ve grup seçin.');
    const messages = rawMessages.split('\\n').filter(line => line.trim() !== '');
    if(messages.length === 0) return alert('Lütfen en az 1 mesaj girin.');
    const res = await fetch('/api/bot/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, threadId, messages, delaySeconds, useTyping })
    });
    const data = await res.json();
    if(!data.success) alert(data.error);
  }
  async function stopBot() {
    const accountId = document.getElementById('accountSelect').value;
    const threadId = document.getElementById('groupSelect').value;
    await fetch('/api/bot/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, threadId })
    });
  }
  async function fetchLogs() {
    try {
      const res = await fetch('/api/logs');
      const logs = await res.json();
      const logBox = document.getElementById('logBox');
      logBox.innerHTML = logs.map(l => {
        let cssClass = 'log-info';
        if(l.type === 'success') cssClass = 'log-success';
        if(l.type === 'error') cssClass = 'log-error';
        if(l.type === 'warning') cssClass = 'log-warning';
        return \`<div class="log-item \${cssClass}">[\${l.time}] [@\${l.username}] \${l.text}</div>\`;
      }).join('');
    } catch(e) {}
  }
  setInterval(fetchLogs, 2000);
  fetchAccounts();
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});
