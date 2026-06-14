const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 配置管理 ---
const CONFIG_PATH = path.join(__dirname, 'config.json');
const EXAMPLE_PATH = path.join(__dirname, 'config.example.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

let config = loadConfig();

// --- SSE 日志广播 ---
const sseClients = new Set();

function broadcast(type, payload) {
  const data = JSON.stringify({ type, ...payload, ts: new Date().toISOString() });
  for (const res of sseClients) {
    res.write(`data: ${data}\n\n`);
  }
}

function log(msg, level = 'info', taskId = null) {
  const entry = { msg, level, taskId };
  console.log(`[${level.toUpperCase()}]${taskId ? ` [Task:${taskId}]` : ''} ${msg}`);
  broadcast('log', entry);
}

// --- HTTP 工具 ---
async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: text };
  }
}

// --- Dujiao-Next 自动登录 & Token 管理 ---
let djToken = '';
let djTokenExp = 0; // Token 过期时间戳 (ms)

function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload);
  } catch {
    // base64url 解码失败时 fallback 到标准 base64
    try {
      const parts = token.split('.');
      const payload = Buffer.from(parts[1], 'base64').toString('utf-8');
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }
}

async function djLogin() {
  const { base_url, username, password } = config.dujiao;
  if (!base_url || !username || !password) {
    throw new Error('Dujiao 配置不完整: 缺少 base_url/username/password');
  }
  log(`正在登录 Dujiao-Next (用户: ${username})...`);
  const url = `${base_url}/api/v1/admin/login`;
  const res = await apiFetch(url, {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok || !res.data) {
    throw new Error(`Dujiao 登录失败 [${res.status}]: ${JSON.stringify(res.data)}`);
  }
  // 检查是否需要 2FA 验证
  const resBody = res.data;
  if (resBody.data && resBody.data.require_2fa) {
    throw new Error('Dujiao 管理员启用了 2FA，自动登录不支持 2FA 账号。请禁用 2FA 或使用专用的无 2FA 管理员账号。');
  }
  // 从响应中提取 token（兼容 token / access_token / data.token / data.access_token）
  let token = resBody.token || resBody.access_token
    || (resBody.data && (resBody.data.token || resBody.data.access_token)) || '';
  if (!token) {
    throw new Error(`Dujiao 登录响应中未找到 token: ${JSON.stringify(resBody)}`);
  }
  djToken = token;
  // 解析 JWT 过期时间
  const payload = decodeJwtPayload(token);
  if (payload && payload.exp) {
    djTokenExp = payload.exp * 1000; // 秒 → 毫秒
    const remainHours = ((djTokenExp - Date.now()) / 3600000).toFixed(1);
    log(`Dujiao 登录成功! Token 有效期剩余 ${remainHours}h`);
  } else {
    // 无法解析 exp，默认 23 小时后过期
    djTokenExp = Date.now() + 23 * 3600000;
    log('Dujiao 登录成功! (无法解析 Token 过期时间，默认 23h)');
  }
  return token;
}

async function djEnsureToken() {
  // Token 不存在 或 距离过期不足 1 小时 → 重新登录
  if (!djToken || Date.now() > djTokenExp - 3600000) {
    await djLogin();
  }
  return djToken;
}

function djHeaders() {
  return {
    'Authorization': `Bearer ${djToken}`,
    'x-lang': 'zh-CN',
  };
}

// Token 自动续期定时器
let tokenRefreshTimer = null;
function setupTokenRefresh() {
  if (tokenRefreshTimer) clearInterval(tokenRefreshTimer);
  // 每 30 分钟检查一次 Token 状态
  tokenRefreshTimer = setInterval(async () => {
    try {
      if (djToken && Date.now() > djTokenExp - 3600000) {
        log('Token 即将过期，自动续期...');
        await djLogin();
      }
    } catch (err) {
      log(`Token 自动续期失败: ${err.message}`, 'error');
    }
  }, 30 * 60 * 1000);
}

// --- Dujiao-Next API ---
async function djGetProducts() {
  await djEnsureToken();
  const url = `${config.dujiao.base_url}/api/v1/admin/products?page=1&page_size=100&fulfillment_type=auto`;
  return apiFetch(url, { headers: djHeaders() });
}

async function djGetProduct(productId) {
  await djEnsureToken();
  const url = `${config.dujiao.base_url}/api/v1/admin/products/${productId}`;
  return apiFetch(url, { headers: djHeaders() });
}

async function djGetCardStats(productId, skuId) {
  await djEnsureToken();
  const url = `${config.dujiao.base_url}/api/v1/admin/card-secrets/stats?product_id=${productId}&sku_id=${skuId}`;
  return apiFetch(url, { headers: djHeaders() });
}

async function djImportCards(productId, skuId, secrets, batchNo = '', note = '', deduplicate = true) {
  await djEnsureToken();
  const url = `${config.dujiao.base_url}/api/v1/admin/card-secrets/batch`;
  return apiFetch(url, {
    method: 'POST',
    headers: djHeaders(),
    body: JSON.stringify({ product_id: productId, sku_id: skuId, secrets, batch_no: batchNo, note, deduplicate }),
  });
}

// --- NewAPI ---
function naHeaders() {
  return { 'Authorization': `Bearer ${config.newapi.token}` };
}

async function naCreateRedemption(name, quota, count, prefix = '') {
  const url = `${config.newapi.base_url}/api/redemption/`;
  return apiFetch(url, {
    method: 'POST',
    headers: naHeaders(),
    body: JSON.stringify({ name, quota, count, prefix }),
  });
}

async function naGetRedemptions(page = 0, size = 100) {
  const url = `${config.newapi.base_url}/api/redemption/?p=${page}&size=${size}`;
  return apiFetch(url, { headers: naHeaders() });
}

// --- 任务执行引擎 ---
const runningTasks = new Map(); // taskId -> { running, lastRun, lastResult }

async function executeTask(taskId) {
  const task = config.tasks.find(t => t.id === taskId);
  if (!task) throw new Error(`任务 ${taskId} 不存在`);

  const state = runningTasks.get(taskId) || {};
  if (state.running) {
    log(`任务正在执行中，跳过`, 'warn', taskId);
    return { success: false, msg: '任务正在执行中' };
  }

  state.running = true;
  state.lastRun = new Date().toISOString();
  runningTasks.set(taskId, state);
  broadcast('task_status', { taskId, status: 'running' });

  try {
    log(`开始执行任务: ${task.name}`, 'info', taskId);

    // 1. 获取当前库存
    log(`查询库存状态 (商品:${task.product_id}, SKU:${task.sku_id})`, 'info', taskId);
    const statsRes = await djGetCardStats(task.product_id, task.sku_id);
    if (!statsRes.ok || statsRes.data.status_code !== 0) {
      throw new Error(`查询库存失败: ${JSON.stringify(statsRes.data)}`);
    }
    const stats = statsRes.data.data;
    log(`当前库存: 可用=${stats.available}, 已预留=${stats.reserved}, 已使用=${stats.used}, 总计=${stats.total}`, 'info', taskId);

    // 2. 判断是否需要补货
    if (stats.available >= task.threshold) {
      log(`库存充足 (${stats.available} >= 阈值${task.threshold})，无需补货`, 'info', taskId);
      state.lastResult = { success: true, msg: '库存充足，无需补货', stats };
      return state.lastResult;
    }

    const deficit = task.target_stock - stats.available;
    const createCount = Math.max(deficit, 1);
    log(`库存不足 (${stats.available} < 阈值${task.threshold})，需要补充 ${createCount} 个兑换码`, 'warn', taskId);

    // 3. 在 NewAPI 创建兑换码
    log(`调用 NewAPI 创建 ${createCount} 个兑换码 (额度:${task.newapi_quota}, 前缀:${task.newapi_prefix || '无'})`, 'info', taskId);
    const createRes = await naCreateRedemption(
      task.newapi_name || `Auto-${task.name}`,
      task.newapi_quota,
      createCount,
      task.newapi_prefix || ''
    );
    if (!createRes.ok) {
      throw new Error(`创建兑换码失败: ${JSON.stringify(createRes.data)}`);
    }
    log(`NewAPI 响应: ${JSON.stringify(createRes.data)}`, 'info', taskId);

    // 4. 提取兑换码 key 列表
    let keys = [];
    const resData = createRes.data;
    if (resData.data && Array.isArray(resData.data)) {
      keys = resData.data.map(item => item.key || item.Key || item);
    } else if (resData.data && typeof resData.data === 'object' && resData.data.keys) {
      keys = resData.data.keys;
    } else if (resData.key) {
      keys = [resData.key];
    } else if (resData.data && resData.data.key) {
      keys = [resData.data.key];
    }

    // 如果直接返回的不含 key，可能需要通过列表接口获取最新创建的
    if (keys.length === 0) {
      log(`创建响应中未直接包含兑换码，尝试通过列表接口获取...`, 'info', taskId);
      const listRes = await naGetRedemptions(0, createCount);
      if (listRes.ok && listRes.data.data && Array.isArray(listRes.data.data)) {
        keys = listRes.data.data
          .filter(item => item.status === 1 || item.redeemed_time === 0)
          .slice(0, createCount)
          .map(item => item.key || item.Key);
      }
    }

    if (keys.length === 0) {
      throw new Error('无法获取到创建的兑换码');
    }
    log(`成功获取 ${keys.length} 个兑换码`, 'info', taskId);

    // 5. 导入到 Dujiao-Next
    const batchNo = task.batch_no || '';
    const note = `自动补货 - ${task.name} - ${new Date().toISOString()}`;
    log(`导入卡密到 Dujiao (商品:${task.product_id}, SKU:${task.sku_id}, 数量:${keys.length})`, 'info', taskId);
    const importRes = await djImportCards(task.product_id, task.sku_id, keys, batchNo, note);
    if (!importRes.ok || importRes.data.status_code !== 0) {
      throw new Error(`导入卡密失败: ${JSON.stringify(importRes.data)}`);
    }
    log(`导入成功! 批次号: ${importRes.data.data.batch_no}, 数量: ${importRes.data.data.created}`, 'info', taskId);

    state.lastResult = {
      success: true,
      msg: `成功补充 ${importRes.data.data.created} 个卡密`,
      batch_no: importRes.data.data.batch_no,
      created: importRes.data.data.created,
      stats,
    };
    broadcast('task_status', { taskId, status: 'success', result: state.lastResult });
    return state.lastResult;

  } catch (err) {
    log(`执行失败: ${err.message}`, 'error', taskId);
    state.lastResult = { success: false, msg: err.message };
    broadcast('task_status', { taskId, status: 'error', error: err.message });
    return state.lastResult;
  } finally {
    state.running = false;
    runningTasks.set(taskId, state);
  }
}

// --- 定时任务 ---
let cronJob = null;

function setupCron() {
  if (cronJob) { cronJob.stop(); cronJob = null; }
  if (!config.cron_enabled) return;

  const expr = config.cron_expression || '*/10 * * * *';
  if (!cron.validate(expr)) {
    log(`无效的 cron 表达式: ${expr}`, 'error');
    return;
  }

  cronJob = cron.schedule(expr, async () => {
    log('定时巡检触发，开始检查所有启用的任务...', 'info');
    for (const task of config.tasks) {
      if (task.enabled) {
        await executeTask(task.id);
      }
    }
  });
  log(`定时巡检已启动: ${expr}`, 'info');
}

// --- sync-tool 自身 Token 认证 ---
const validTokens = new Set();

function authMiddleware(req, res, next) {
  // 放行登录、SSE、静态文件
  if (req.path === '/api/login' || req.path === '/api/events') return next();
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, msg: '未授权' });
  }
  const token = auth.slice(7);
  if (!validTokens.has(token)) {
    return res.status(401).json({ ok: false, msg: 'Token 无效或已过期' });
  }
  next();
}

app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path === '/events') return next();
  authMiddleware(req, res, next);
});

// --- API 路由 ---

// 登录验证
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === config.auth_password) {
    const token = crypto.randomBytes(32).toString('hex');
    validTokens.add(token);
    res.json({ ok: true, token });
  } else {
    res.status(401).json({ ok: false, msg: '密码错误' });
  }
});

// 登出
app.post('/api/logout', (req, res) => {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    validTokens.delete(auth.slice(7));
  }
  res.json({ ok: true });
});

// SSE 日志流
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// 获取全局配置（脱敏）
app.get('/api/config', (req, res) => {
  const cfg = { ...config };
  cfg.newapi = { ...cfg.newapi, token: cfg.newapi.token ? '***已配置***' : '' };
  cfg.dujiao = {
    ...cfg.dujiao,
    password: cfg.dujiao.password ? '***已配置***' : '',
  };
  cfg.auth_password = undefined;
  // 附加 Token 状态
  cfg._dj_token_status = {
    has_token: !!djToken,
    expires_at: djTokenExp ? new Date(djTokenExp).toISOString() : null,
    remaining_hours: djTokenExp ? Math.max(0, (djTokenExp - Date.now()) / 3600000).toFixed(1) : 0,
  };
  res.json({ ok: true, data: cfg });
});

// 更新全局配置
app.put('/api/config', (req, res) => {
  const updates = req.body;
  if (updates.newapi) {
    if (updates.newapi.base_url !== undefined) config.newapi.base_url = updates.newapi.base_url;
    if (updates.newapi.token && updates.newapi.token !== '***已配置***') config.newapi.token = updates.newapi.token;
  }
  if (updates.dujiao) {
    if (updates.dujiao.base_url !== undefined) config.dujiao.base_url = updates.dujiao.base_url;
    if (updates.dujiao.username !== undefined) config.dujiao.username = updates.dujiao.username;
    if (updates.dujiao.password && updates.dujiao.password !== '***已配置***') config.dujiao.password = updates.dujiao.password;
  }
  if (updates.auth_password) config.auth_password = updates.auth_password;
  if (updates.cron_enabled !== undefined) config.cron_enabled = updates.cron_enabled;
  if (updates.cron_expression !== undefined) config.cron_expression = updates.cron_expression;
  saveConfig(config);
  setupCron();
  res.json({ ok: true });
});

// Dujiao Token 状态
app.get('/api/dujiao/token-status', (req, res) => {
  res.json({
    ok: true,
    data: {
      has_token: !!djToken,
      expires_at: djTokenExp ? new Date(djTokenExp).toISOString() : null,
      remaining_hours: djTokenExp ? Math.max(0, (djTokenExp - Date.now()) / 3600000).toFixed(1) : 0,
    },
  });
});

// Dujiao 测试登录
app.post('/api/dujiao/test-login', async (req, res) => {
  try {
    await djLogin();
    res.json({ ok: true, msg: '登录成功', remaining_hours: ((djTokenExp - Date.now()) / 3600000).toFixed(1) });
  } catch (err) {
    res.status(400).json({ ok: false, msg: err.message });
  }
});

// Dujiao 商品列表（代理）
app.get('/api/proxy/dujiao/products', async (req, res) => {
  try {
    const result = await djGetProducts();
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// Dujiao 库存统计（代理）
app.get('/api/proxy/dujiao/card-stats', async (req, res) => {
  try {
    const { product_id, sku_id } = req.query;
    const result = await djGetCardStats(product_id, sku_id);
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// 任务 CRUD
app.get('/api/tasks', (req, res) => {
  const tasks = config.tasks.map(t => ({
    ...t,
    state: runningTasks.get(t.id) || { running: false },
  }));
  res.json({ ok: true, data: tasks });
});

app.post('/api/tasks', (req, res) => {
  const task = {
    id: crypto.randomUUID(),
    name: req.body.name || '未命名任务',
    enabled: req.body.enabled !== false,
    product_id: Number(req.body.product_id),
    sku_id: Number(req.body.sku_id),
    product_name: req.body.product_name || '',
    threshold: Number(req.body.threshold) || 5,
    target_stock: Number(req.body.target_stock) || 10,
    batch_no: req.body.batch_no || '',
    newapi_name: req.body.newapi_name || '',
    newapi_quota: Number(req.body.newapi_quota) || 500000,
    newapi_prefix: req.body.newapi_prefix || '',
    created_at: new Date().toISOString(),
  };
  config.tasks.push(task);
  saveConfig(config);
  res.json({ ok: true, data: task });
});

app.put('/api/tasks/:id', (req, res) => {
  const idx = config.tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, msg: '任务不存在' });
  const updates = req.body;
  const task = config.tasks[idx];
  for (const key of ['name', 'enabled', 'product_id', 'sku_id', 'product_name', 'threshold', 'target_stock', 'batch_no', 'newapi_name', 'newapi_quota', 'newapi_prefix']) {
    if (updates[key] !== undefined) {
      task[key] = ['product_id', 'sku_id', 'threshold', 'target_stock', 'newapi_quota'].includes(key)
        ? Number(updates[key])
        : updates[key];
    }
  }
  saveConfig(config);
  res.json({ ok: true, data: task });
});

app.delete('/api/tasks/:id', (req, res) => {
  config.tasks = config.tasks.filter(t => t.id !== req.params.id);
  saveConfig(config);
  res.json({ ok: true });
});

// 切换任务启用/禁用
app.patch('/api/tasks/:id/toggle', (req, res) => {
  const task = config.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ ok: false, msg: '任务不存在' });
  task.enabled = !task.enabled;
  saveConfig(config);
  res.json({ ok: true, data: task });
});

// 手动执行任务
app.post('/api/tasks/:id/execute', async (req, res) => {
  try {
    const result = await executeTask(req.params.id);
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// 执行全部启用的任务
app.post('/api/tasks/execute-all', async (req, res) => {
  const results = [];
  for (const task of config.tasks) {
    if (task.enabled) {
      const result = await executeTask(task.id);
      results.push({ taskId: task.id, name: task.name, ...result });
    }
  }
  res.json({ ok: true, data: results });
});

// 检查库存（不执行补货）
app.post('/api/tasks/:id/check', async (req, res) => {
  const task = config.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ ok: false, msg: '任务不存在' });
  try {
    const statsRes = await djGetCardStats(task.product_id, task.sku_id);
    if (!statsRes.ok || !statsRes.data || statsRes.data.status_code !== 0 || !statsRes.data.data) {
      return res.status(500).json({ ok: false, msg: `Dujiao 返回异常: ${JSON.stringify(statsRes.data)}` });
    }
    res.json({ ok: true, data: statsRes.data.data, threshold: task.threshold, target_stock: task.target_stock });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// --- 启动 ---
const PORT = config.port || 3456;
app.listen(PORT, async () => {
  console.log(`\n  🚀 同步工具已启动: http://localhost:${PORT}\n`);
  setupCron();
  setupTokenRefresh();
  // 启动时尝试自动登录 Dujiao
  if (config.dujiao.username && config.dujiao.password) {
    try {
      await djLogin();
    } catch (err) {
      log(`启动时 Dujiao 自动登录失败: ${err.message}（请在 WebUI 中检查配置）`, 'warn');
    }
  }
});
