/**
 * 功能概述：工作台的按钮、标题、状态、字段反馈及无障碍弹层公共边界。
 * 主要职责：Button 默认不提交表单；PageHeader 接受标题/说明/动作；StatusBadge 与
 * FieldMessage 显示文字语义。Dialog、AlertDialog、DropdownMenu 导出 Radix 原语，
 * 由调用页声明标题、描述及操作，保留原语的焦点管理、键盘交互和受控状态能力。
 * 代码库关系：AppShell 与业务页共用 workbench.css 和现有 CSS variables；不处理请求。
 * 输入输出与副作用：透传原生按钮属性和 ref；错误反馈使用 alert，其余反馈为 status。
 */
import { CheckCircle2, AlertTriangle, CircleAlert, Info } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
export * as Dialog from "@radix-ui/react-dialog";
export * as AlertDialog from "@radix-ui/react-alert-dialog";
export * as DropdownMenu from "@radix-ui/react-dropdown-menu";
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary" | "danger";
  }
>(function Button(
  { variant = "secondary", className = "", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`wb-button wb-button-${variant} ${className}`}
      {...props}
    />
  );
});
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="wb-page-header">
      <div>
        <h1>{title}</h1>
        {description && (
          <details className="wb-page-help">
            <summary>页面说明</summary>
            <p>{description}</p>
          </details>
        )}
      </div>
      {actions && <div className="wb-page-actions">{actions}</div>}
    </header>
  );
}
export function StatusBadge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "error";
}) {
  const Icon =
    tone === "success"
      ? CheckCircle2
      : tone === "warning"
        ? AlertTriangle
        : tone === "error"
          ? CircleAlert
          : Info;
  return (
    <span className={`wb-status wb-status-${tone}`}>
      <Icon size={13} aria-hidden="true" />
      {children}
    </span>
  );
}
export function FieldMessage({
  children,
  tone = "neutral",
  id,
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "error";
  id?: string;
}) {
  return (
    <p
      id={id}
      className={`wb-field-message wb-status-${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {children}
    </p>
  );
}
