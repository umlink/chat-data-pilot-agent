import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, setToken, setUsername as saveUsername } from '@/lib/api'

export function Login() {
  const navigate = useNavigate()
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    setErr('')
    try {
      const data = await api.post<{ token: string; user?: { username?: string } }>(
        '/auth/login',
        { username, password },
        { auth: false },
      )
      setToken(data.token)
      saveUsername(data.user?.username ?? username)
      navigate('/', { replace: true })
    } catch (e) {
      setErr(e instanceof Error ? e.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="w-80 space-y-4 rounded-lg border bg-card p-6">
        <h1 className="text-center text-lg font-semibold">DataPilot</h1>
        <p className="text-center text-[13px] text-muted-foreground">自然语言数据分析</p>
        <div className="space-y-2">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="用户名"
            aria-label="用户名"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="密码"
            aria-label="密码"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
          />
        </div>
        {err && <p className="text-xs text-error">{err}</p>}
        <button
          onClick={submit}
          disabled={busy || !username || !password}
          className="btn btn-primary w-full"
        >
          {busy ? '登录中…' : '登录'}
        </button>
        <p className="text-center text-xs text-muted-foreground">默认账号 admin / Admin@12345</p>
      </div>
    </div>
  )
}