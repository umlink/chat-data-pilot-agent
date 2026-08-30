import { spawn } from 'node:child_process'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9225
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--single-process',
    '--no-sandbox',
    '--disable-gpu',
    '--single-process',
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--disable-crashpad',
    '--disable-breakpad',
    `--user-data-dir=/tmp/datapilot-login-verify/diag-profile-${Date.now()}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const withTimeout = (p, ms, tag) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${tag} TIMEOUT ${ms}ms`)), ms)),
  ])

try {
  let ver = null
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) {
        ver = await res.json()
        break
      }
    } catch {}
    await sleep(250)
  }
  console.log('HTTP /json/version:', ver ? 'OK Browser=' + ver.Browser : 'FAILED')

  const wsCall = async (url, method, tag) => {
    const ws = new WebSocket(url)
    await withTimeout(
      new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true })
        ws.addEventListener('error', () => rej(new Error(tag + ' ws open error')), { once: true })
      }),
      8000,
      tag + ' open',
    )
    const reply = await withTimeout(
      new Promise((resolve, reject) => {
        ws.addEventListener('message', (ev) => {
          const m = JSON.parse(ev.data)
          if (m.id === 1) resolve(m)
        })
        ws.send(JSON.stringify({ id: 1, method, params: {} }))
      }),
      8000,
      tag + ' ' + method,
    )
    ws.close()
    return reply
  }

  const browserWs = ver.webSocketDebuggerUrl
  console.log('browser ws url:', browserWs)
  const r1 = await wsCall(browserWs, 'Browser.getVersion', 'browser')
  console.log('Browser.getVersion:', r1.result ? 'OK' : JSON.stringify(r1).slice(0, 200))

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  console.log('page target:', page ? page.url + ' | ' + page.webSocketDebuggerUrl : 'NONE', '| all:', JSON.stringify(list.map((t) => t.type)))
  const r2 = await wsCall(page.webSocketDebuggerUrl, 'Target.getTargetInfo', 'page')
  console.log('Target.getTargetInfo:', r2.result ? 'OK' : JSON.stringify(r2).slice(0, 200))

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res) => ws.addEventListener('open', res, { once: true }))
  const r3 = await withTimeout(
    new Promise((resolve, reject) => {
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data)
        if (m.id === 1) resolve(m)
      })
      ws.send(JSON.stringify({ id: 1, method: 'Page.enable', params: {} }))
    }),
    8000,
    'Page.enable',
  )
  console.log('Page.enable:', r3.result !== undefined ? 'OK' : JSON.stringify(r3).slice(0, 200))
  console.log('DIAG_ALL_OK')
} catch (e) {
  console.log('DIAG_FAIL:', e.message)
} finally {
  chrome.kill()
}
