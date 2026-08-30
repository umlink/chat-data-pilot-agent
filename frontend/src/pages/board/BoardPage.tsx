import { useCallback, useEffect, useState } from "react";
import { LayoutDashboard, Pencil, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartBlock } from "@/components/chat/ChartBlock";
import type { SavedChartInfo } from "@/types/analytics";

function formatTime(value?: string | null): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 收藏卡片：标题行（重命名/删除）+ 图表渲染（复用 ChartBlock：全屏/导出/查看 SQL）。 */
function SavedChartCard({
  chart,
  onRenamed,
  onDeleted,
}: {
  chart: SavedChartInfo;
  onRenamed: (id: string, title: string) => void;
  onDeleted: (chart: SavedChartInfo) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState(chart.title);
  const [savingName, setSavingName] = useState(false);
  const [renameError, setRenameError] = useState("");

  const commitRename = async () => {
    const title = titleDraft.trim();
    if (!title || title === chart.title) {
      setRenaming(false);
      return;
    }
    setSavingName(true);
    setRenameError("");
    try {
      await api.post("/saved-charts/update", { id: chart.id, title });
      onRenamed(chart.id, title);
      setRenaming(false);
    } catch (e) {
      // 保存失败：回退原标题并给出可读错误提示，避免静默丢失
      setRenameError(e instanceof Error ? e.message : "重命名失败，请稍后重试");
      setTitleDraft(chart.title);
      setRenaming(false);
    } finally {
      setSavingName(false);
    }
  };

  return (
    <div className="flex flex-col rounded-lg border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        {renaming ? (
          <Input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitRename();
              if (e.key === "Escape") {
                setTitleDraft(chart.title);
                setRenaming(false);
              }
            }}
            aria-label="重命名收藏图表"
            className="h-7 flex-1 text-[13px]"
            disabled={savingName}
          />
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground"
            title={chart.title}
          >
            {chart.title}
          </span>
        )}
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {formatTime(chart.created_at)}
        </span>
        <button
          onClick={() => setRenaming(true)}
          aria-label="重命名"
          title="重命名"
          className="rounded p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
        >
          <Pencil size={13} />
        </button>
        <button
          onClick={() => onDeleted(chart)}
          aria-label="取消收藏"
          title="取消收藏"
          className="rounded p-1 text-muted-foreground outline-none hover:bg-accent hover:text-error focus-visible:ring-2 focus-visible:ring-ring/30"
        >
          <Trash2 size={13} />
        </button>
      </div>
      {renameError && (
        <p className="border-b px-4 py-1.5 text-xs text-error" role="alert">
          {renameError}
        </p>
      )}
      <div className="p-4 pt-0">
        <ChartBlock
          content={chart.chart_content}
          showTitle={false}
          reserveToolbarTop
        />
      </div>
    </div>
  );
}

/** 图表看板（分析结果沉淀）：对话中收藏的 chart block 快照，网格布局展示。 */
export function BoardPage() {
  const [list, setList] = useState<SavedChartInfo[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [deleteChart, setDeleteChart] = useState<SavedChartInfo | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api.get<SavedChartInfo[]>("/saved-charts");
      setList(data);
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "看板加载失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmDelete = async () => {
    if (!deleteChart) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await api.post("/saved-charts/delete", { id: deleteChart.id });
      setList((prev) =>
        prev ? prev.filter((c) => c.id !== deleteChart.id) : prev,
      );
      setDeleteChart(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "取消收藏失败");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="px-6 pb-1 pt-6">
        <h2 className="text-[15px] font-semibold text-foreground">图表看板</h2>
        <p className="text-xs text-muted-foreground">
          对话中点击 ★ 收藏的分析图表快照，可在看板中全屏查看、导出或回溯查询
          SQL
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-4 px-6 pb-6 pt-4">
        {loadError && (
          <div className="flex items-center justify-between rounded-lg border border-error/30 bg-error-bg px-4 py-3">
            <p className="text-xs text-error">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </div>
        )}

        {list === null && !loadError && (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-72 w-full" />
            ))}
          </div>
        )}

        {list !== null && list.length === 0 && !loadError && (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              <LayoutDashboard size={18} />
            </div>
            <p className="text-[13px] text-muted-foreground">
              看板还是空的，在对话中生成图表后点击 ★ 收藏到看板
            </p>
          </div>
        )}

        {list !== null && list.length > 0 && (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {list.map((chart) => (
              <SavedChartCard
                key={chart.id}
                chart={chart}
                onRenamed={(id, title) =>
                  setList((prev) =>
                    prev
                      ? prev.map((c) => (c.id === id ? { ...c, title } : c))
                      : prev,
                  )
                }
                onDeleted={setDeleteChart}
              />
            ))}
          </div>
        )}
      </div>

      <Dialog
        open={deleteChart !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteChart(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>取消收藏</DialogTitle>
            <DialogDescription>
              确定移除「{deleteChart?.title ?? ""}
              」吗？看板中的快照将被删除，原始对话不受影响。
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="text-xs text-error" role="alert">
              {deleteError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteChart(null)}
              disabled={deleting}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting ? "删除中…" : "移除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
