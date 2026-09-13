/**
 * 功能概述：将 Profile 切换与工作台导航接入同一个未保存草稿确认。
 * 主要职责：useProfileDraft 合并并发确认、串行保存，失败/取消保留草稿；三项操作由 Radix
 * AlertDialog 管理焦点。beforeunload 使用浏览器原生离开保护，不能提供自定义三按钮。
 * 代码库关系：App 提供 dirty/save 与 ProfileWorkspace 的编辑守卫；AppShell 调用导航守卫。
 * 输入输出与副作用：草稿只驻留 React 内存；保存成功才放行，卸载会解除监听并拒绝待决请求。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigationGuard } from "./components/AppShell.js";
import { AlertDialog, Button } from "./components/ui.js";
export function useProfileDraft(options: {
  dirty: boolean;
  busy: boolean;
  save: () => Promise<boolean>;
  register: (guard: () => Promise<boolean>) => () => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const pending = useRef<
    | { promise: Promise<boolean>; resolve: (allowed: boolean) => void }
    | undefined
  >(undefined);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const request = useCallback((): Promise<boolean> => {
    if (pending.current) return pending.current.promise;
    if (latest.current.busy) return Promise.resolve(false);
    if (!latest.current.dirty) return Promise.resolve(true);
    let resolve!: (allowed: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    pending.current = { promise, resolve };
    setOpen(true);
    return promise;
  }, []);
  useNavigationGuard(request);
  useEffect(() => options.register(request), [options.register, request]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (latest.current.dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      pending.current?.resolve(false);
    };
  }, []);
  const finish = (allowed: boolean) => {
    const current = pending.current;
    pending.current = undefined;
    setOpen(false);
    current?.resolve(allowed);
  };
  const save = async () => {
    setSaving(true);
    try {
      finish(await latest.current.save());
    } catch {
      finish(false);
    } finally {
      setSaving(false);
    }
  };
  return {
    request,
    dialog: (
      <AlertDialog.Root
        open={open}
        onOpenChange={(next) => {
          if (!next && !saving) finish(false);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="wb-overlay" />
          <AlertDialog.Content className="wb-dialog">
            <AlertDialog.Title>保留未保存的配置修改？</AlertDialog.Title>
            <AlertDialog.Description>
              保存后继续将只写入当前
              Profile；不会设为当前或应用配置。放弃会丢弃本次草稿，取消会留在当前编辑页。
            </AlertDialog.Description>
            <div className="editor-actions">
              <Button disabled={saving} onClick={() => void save()}>
                {saving ? "正在保存…" : "保存后继续"}
              </Button>
              <Button
                disabled={saving}
                variant="danger"
                onClick={() => finish(true)}
              >
                放弃修改
              </Button>
              <AlertDialog.Cancel asChild>
                <Button disabled={saving}>取消</Button>
              </AlertDialog.Cancel>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    ),
  };
}
