/** 功能占位页（对应里程碑未实现的模块）。 */
export function Placeholder({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-secondary text-2xl">
        🚧
      </div>
      <p className="text-lg text-foreground">{title}</p>
      {note && <p className="text-[13px] text-muted-foreground">{note}</p>}
    </div>
  )
}