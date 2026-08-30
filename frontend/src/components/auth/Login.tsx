import { useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  Database,
  Eye,
  EyeOff,
  LineChart,
  MessageSquare,
} from "lucide-react";
import {
  ApiError,
  api,
  setToken,
  setUsername as saveUsername,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * 登录页（GuestOnly 路由渲染）。
 * 布局：桌面端左侧品牌叙事区（渐变光晕 + 数据网格 + 图表装饰）+ 右侧登录卡；
 * 移动端折叠为单列卡片。色彩全部引用语义/图表 token（docs/UI设计规范.md 1.1/1.3），
 * 交互遵循 Web Interface Guidelines：<form> 原生提交、autocomplete、内联错误聚焦、请求中 spinner。
 */

/** 数据网格底纹：1px 网格线 + 径向遮罩淡出（色值引用 --border token，随明暗主题适配） */
const GRID_STYLE: CSSProperties = {
  backgroundImage:
    "linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
  backgroundSize: "44px 44px",
  maskImage:
    "radial-gradient(ellipse 90% 85% at 28% 40%, black 25%, transparent 78%)",
  WebkitMaskImage:
    "radial-gradient(ellipse 90% 85% at 28% 40%, black 25%, transparent 78%)",
};

/** 品牌区光晕：图表 token 色 + color-mix 半透明，避免裸色值 */
function orbStyle(token: string): CSSProperties {
  return {
    background: `radial-gradient(closest-side, color-mix(in oklch, ${token} 30%, transparent), transparent)`,
  };
}

const FEATURES = [
  {
    icon: MessageSquare,
    title: "自然语言提问",
    desc: "像对话一样描述分析需求，无需写 SQL",
  },
  {
    icon: LineChart,
    title: "图表即时生成",
    desc: "柱状 / 折线 / 饼图一步到位，可全屏与导出",
  },
  {
    icon: Database,
    title: "查询全程可回溯",
    desc: "每张图表关联 SQL 与数据源，结果可信可查",
  },
];

export function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setErr("");
    // 提交按钮在请求开始前保持可用（guidelines）；空值校验内联报错并聚焦首个错误字段
    const u = username.trim();
    if (!u) {
      setErr("请输入用户名");
      return;
    }
    if (!password) {
      setErr("请输入密码");
      passwordRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const data = await api.post<{
        token: string;
        user?: { username?: string };
      }>("/auth/login", { username: u, password }, { auth: false });
      setToken(data.token);
      saveUsername(data.user?.username ?? u);
      navigate("/", { replace: true });
    } catch (e2) {
      // 后端信封 message 已是中文可读（如「用户名或密码错误」），直接展示
      setErr(e2 instanceof Error ? e2.message : "登录失败，请稍后重试");
      // 凭据类错误：清空密码并聚焦到最可能的修复点
      if (e2 instanceof ApiError && e2.status === 401) {
        setPassword("");
        passwordRef.current?.focus();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      {/* 左侧品牌叙事区（桌面端） */}
      <aside className="relative hidden flex-1 flex-col justify-between overflow-hidden border-r border-r-zinc-100 p-10 lg:flex xl:p-14">
        {/* 装饰层：网格底纹 + 双光晕 + 抽象图表（纯装饰，对读屏隐藏） */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
        >
          <div className="absolute inset-0 opacity-70" style={GRID_STYLE} />
          <div
            className="dp-drift absolute -top-32 right-[-6rem] size-[480px] rounded-full blur-3xl"
            style={orbStyle("var(--chart-2)")}
          />
          <div
            className="dp-drift absolute bottom-[-10rem] left-[-8rem] size-[520px] rounded-full blur-3xl"
            style={{ ...orbStyle("var(--chart-4)"), animationDelay: "-8s" }}
          />
          {/* 抽象折线 + 柱状：呼应产品「自然语言 → 图表」 */}
          <svg
            className="dp-float absolute right-12 bottom-16 hidden xl:block"
            width="300"
            height="150"
            viewBox="0 0 300 150"
            fill="none"
          >
            <rect
              x="10"
              y="92"
              width="26"
              height="48"
              rx="4"
              fill="var(--chart-1)"
              opacity="0.5"
            />
            <rect
              x="48"
              y="70"
              width="26"
              height="70"
              rx="4"
              fill="var(--chart-2)"
              opacity="0.45"
            />
            <rect
              x="86"
              y="84"
              width="26"
              height="56"
              rx="4"
              fill="var(--chart-3)"
              opacity="0.4"
            />
            <path
              d="M10 70 C 60 40, 100 84, 140 58 S 230 20, 290 34"
              stroke="var(--chart-1)"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
            <path
              d="M10 104 C 66 92, 118 118, 160 96 S 244 66, 290 72"
              stroke="var(--chart-3)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray="1 6"
            />
          </svg>
        </div>

        {/* 品牌行 */}
        <div className="relative flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-[8px] bg-primary text-primary-foreground">
            <Activity className="size-4.5" aria-hidden="true" />
          </div>
          <span className="text-[15px] font-semibold text-foreground">
            DataPilot
          </span>
        </div>

        {/* 主叙事 */}
        <div className="relative max-w-lg">
          <h2 className="text-3xl leading-snug font-semibold tracking-tight text-foreground xl:text-4xl">
            用一句话，
            <br />
            读懂你的数据
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            DataPilot
            将自然语言转化为查询与可视化图表：提问、生成、收藏、导出，分析过程全程可回溯。
          </p>
        </div>

        {/* 特性 + 版权 */}
        <div className="relative">
          <ul className="mb-10 space-y-4">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex items-start gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                  <f.icon className="size-4" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {f.title}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {f.desc}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            © 2026 DataPilot · 自然语言数据分析
          </p>
        </div>
      </aside>

      {/* 右侧登录卡 */}
      <main className="flex w-full items-center justify-center px-6 lg:w-1/2 lg:shrink-0">
        <div className="w-full max-w-[420px] rounded-xl border bg-card p-8 shadow-[0_1px_2px_rgba(0,0,0,0.04)] sm:p-10">
          {/* 品牌区：桌面端由左侧品牌区承载，仅移动端显示 */}
          <div className="mb-6 flex items-center justify-center gap-2.5">
            <div className="flex size-10 items-center justify-center rounded-[9px] bg-primary text-primary-foreground">
              <Activity className="size-5" aria-hidden="true" />
            </div>
            <div className="text-left">
              <h1 className="text-lg font-semibold text-foreground">
                DataPilot
              </h1>
              <p className="text-xs text-muted-foreground">自然语言数据分析</p>
            </div>
          </div>

          <form onSubmit={submit} noValidate>
            <div className="space-y-8">
              <div className="space-y-1">
                <label
                  htmlFor="login-username"
                  className="text-xs font-medium text-foreground"
                >
                  用户名
                </label>
                <Input
                  id="login-username"
                  name="username"
                  type="text"
                  size={30}
                  // 登录页唯一主输入、桌面端为主场景：autoFocus 合理（guidelines: desktop only, single primary input）
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={busy}
                  className="h-10"
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="login-password"
                  className="text-xs font-medium text-foreground"
                >
                  密码
                </label>
                <div className="relative">
                  <Input
                    id="login-password"
                    ref={passwordRef}
                    name="password"
                    type={showPwd ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="current-password"
                    disabled={busy}
                    className="h-10 pr-8"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPwd((v) => !v)}
                    aria-label={showPwd ? "隐藏密码" : "显示密码"}
                    aria-pressed={showPwd}
                    className="absolute top-1/2 right-1.5 -translate-y-1/2 touch-manipulation rounded-sm p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
                  >
                    {showPwd ? (
                      <EyeOff className="size-3.5" aria-hidden="true" />
                    ) : (
                      <Eye className="size-3.5" aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>

              {err ? (
                <p
                  role="alert"
                  className="rounded-md bg-error-bg px-2.5 py-1.5 text-xs text-error"
                >
                  {err}
                </p>
              ) : null}

              <Button
                type="submit"
                disabled={busy}
                className="mt-1 h-9 w-full text-[13px]"
              >
                {busy ? (
                  <>
                    <span
                      className="size-3.5 animate-spin rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    登录中…
                  </>
                ) : (
                  "登录"
                )}
              </Button>
            </div>
          </form>

          <p className="mt-5 text-center text-xs text-muted-foreground">
            默认账号{" "}
            <code
              translate="no"
              className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px] whitespace-nowrap text-foreground"
            >
              admin / Admin@12345
            </code>
          </p>
        </div>
      </main>
    </div>
  );
}
