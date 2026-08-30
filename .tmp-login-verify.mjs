import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9224
const OUT = '/tmp/datapilot-login-verify'
const FAKE_HOME = '/tmp/datapilot-login-verify/home'
mkdirSync(`${FAKE_HOME}/Library/Application Support`, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-crash-reporter',
    '--disable-crashpad',
    '--disable-breakpad',
    '--crash-dumps-dir=/tmp/datapilot-login-verify/crashpad',
    '--disable-features=OptimizationHints,MediaRouter',
    `--user-data-dir=/tmp/datapilot-login-verify/profile-${Date.now()}`,
    'about:blank',
  ],
  { stdio: 'ignore', env: { ...process.env, HOME: FAKE_HOME } },
)

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.listeners = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      } else if (msg.method) {
        const cbs = this.listeners.get(msg.method) ?? []
        for (const cb of cbs) cb(msg.params)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  once(event) {
    return new Promise((resolve) => {
      const cb = (p) => {
        const cbs = this.listeners.get(event) ?? []
        this.listeners.set(event, cbs.filter((f) => f !== cb))
        resolve(p)
      }
      const cbs = this.listeners.get(event) ?? []
      cbs.push(cb)
      this.listeners.set(event, cbs)
    })
  }
}

const waitForPageTarget = async () => {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (res.ok) {
        const targets = await res.json()
        const page = targets.find((t) => t.type === 'page')
        if (page) return page.webSocketDebuggerUrl
      }
    } catch {}
    await sleep(200)
  }
  throw new Error('Chrome debug endpoint not ready')
}

const INSPECT_FN = `(() => {
  const vis = (el) => {
    if (!el) return false
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const q = (sel) => document.querySelector(sel)
  const aside = q('aside')
  const orbs = document.querySelectorAll('.dp-drift')
  const svg = aside ? aside.querySelector('svg') : null
  const h2 = aside ? aside.querySelector('h2') : null
  const lis = aside ? aside.querySelectorAll('ul li') : []
  let copy = null
  if (aside) for (const p of aside.querySelectorAll('p')) if (p.textContent.includes('©')) copy = p
  const card = q('main > div')
  const mobileBrand = q('main h1')
  const rootDiv = q('#root > div')
  const overlap = (el) => {
    if (!el || !vis(el)) return { present: !!el, visible: el ? vis(el) : false, skipped: true }
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight)
      return { visible: true, skipped: true, reason: 'center outside viewport' }
    const hit = document.elementFromPoint(cx, cy)
    return {
      visible: true,
      occluded: hit ? !(hit === el || el.contains(hit) || hit.contains(el)) : true,
      hit: hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') : null,
    }
  }
  const cardRect = card ? card.getBoundingClientRect() : null
  const rs = getComputedStyle(document.documentElement)
  return {
    viewport: { w: innerWidth, h: innerHeight },
    overflowX: {
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
      bodyScrollW: document.body.scrollWidth,
      hasHorizOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    },
    aside: {
      exists: !!aside,
      visible: vis(aside),
      contentClipped: aside ? aside.scrollHeight > aside.clientHeight + 1 : null,
    },
    decorations: {
      grid: aside ? vis(aside.querySelector('[aria-hidden="true"] > div')) : false,
      orbCount: orbs.length,
      orbVisible: Array.from(orbs).filter(vis).length,
      svg: { exists: !!svg, visible: vis(svg) },
    },
    headline: h2 ? h2.textContent.replace(/\\s+/g, ' ').trim() : null,
    featureCount: lis.length,
    copyright: copy ? copy.textContent.trim() : null,
    card: {
      exists: !!card,
      visible: card ? vis(card) : false,
      bg: card ? getComputedStyle(card).backgroundColor : null,
      centerX: cardRect ? Math.round(cardRect.left + cardRect.width / 2) : null,
      expectedCenterX: Math.round(innerWidth / 2),
    },
    mobileBrandTitle: mobileBrand
      ? { exists: true, visible: vis(mobileBrand), text: mobileBrand.textContent }
      : { exists: false, visible: false, text: null },
    form: {
      'login-username': overlap(q('#login-username')),
      'login-password': overlap(q('#login-password')),
      'pwd-toggle': overlap(q('main button[type="button"]')),
      'submit': overlap(q('main button[type="submit"]')),
    },
    theme: {
      appBg: rootDiv ? getComputedStyle(rootDiv).backgroundColor : null,
      tokenBackground: rs.getPropertyValue('--background').trim(),
      tokenCard: rs.getPropertyValue('--card').trim(),
      tokenChart2: rs.getPropertyValue('--chart-2').trim(),
      tokenChart4: rs.getPropertyValue('--chart-4').trim(),
      htmlClasses: document.documentElement.className,
    },
  }
})()`

const evalJson = async (cdp, expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result.value
}

const waitForSelector = async (cdp, sel, timeoutMs = 15000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ok = await evalJson(cdp, `!!document.querySelector(${JSON.stringify(sel)})`)
    if (ok) return true
    await sleep(250)
  }
  return false
}

const shot = async (cdp, file) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}/${file}`, Buffer.from(r.data, 'base64'))
}

const results = { steps: [] }

try {
  const wsUrl = await waitForPageTarget()
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const cdp = new CDP(ws)

  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    screenWidth: 1440, screenHeight: 900,
  })

  results.steps.push({ step: '1-navigate' })
  const url = 'http://localhost:5173/login'
  const loadDone = cdp.once('Page.loadEventFired')
  await cdp.send('Page.navigate', { url })
  await loadDone
  let usernameReady = await waitForSelector(cdp, '#login-username')
  let finalUrl = await evalJson(cdp, 'location.href')
  let wasRedirected = !finalUrl.includes('/login')
  if (wasRedirected) {
    await evalJson(
      cdp,
      `(() => { localStorage.removeItem('datapilot_token'); localStorage.removeItem('datapilot_username'); return 'cleared' })()`,
    )
    const load2 = cdp.once('Page.loadEventFired')
    await cdp.send('Page.navigate', { url })
    await load2
    usernameReady = await waitForSelector(cdp, '#login-username')
    finalUrl = await evalJson(cdp, 'location.href')
  }
  await sleep(800)
  results.steps[0] = {
    step: '1-navigate',
    wasRedirected,
    finalUrl,
    usernameInputPresent: usernameReady,
  }

  const desktop = await evalJson(cdp, INSPECT_FN)
  await shot(cdp, '01-desktop-light-1440.png')
  results.steps.push({ step: '2-desktop-light-1440', ...desktop })

  await evalJson(cdp, `document.documentElement.classList.add('dark') || 'ok'`)
  await sleep(600)
  const dark = await evalJson(cdp, INSPECT_FN)
  await shot(cdp, '02-desktop-dark-1440.png')
  await evalJson(cdp, `document.documentElement.classList.remove('dark') || 'ok'`)
  await sleep(600)
  results.steps.push({
    step: '3-dark-mode',
    themeDuringDark: dark.theme,
    overflowXDuringDark: dark.overflowX,
    cardBgDuringDark: dark.card.bg,
    asideVisibleDuringDark: dark.aside.visible,
    htmlClassesAfterRestore: await evalJson(cdp, 'document.documentElement.className || "(empty)"'),
  })

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 900, height: 900, deviceScaleFactor: 1, mobile: false,
    screenWidth: 900, screenHeight: 900,
  })
  await sleep(800)
  const narrow = await evalJson(cdp, INSPECT_FN)
  await shot(cdp, '03-narrow-900.png')
  results.steps.push({ step: '4-narrow-900', ...narrow })

  writeFileSync(`${OUT}/result.json`, JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
} catch (e) {
  console.error('VERIFY_FAIL:', e.message)
  writeFileSync(`${OUT}/result.json`, JSON.stringify(results, null, 2))
  process.exitCode = 1
} finally {
  chrome.kill()
}
