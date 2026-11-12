/**
 * 功能概述：以领域、关系、完整稳定 ID 和可用状态呈现证据引用。
 * InspectionReference 只为 available 生成当前工作台内的原生链接，传递 scope/observation/step；
 * 缺失、未记录和无效引用保持可读，不发起替代查询或绕过证明读取正文。
 * DomainInspection 与情境/Memory 检视区调用；修饰键保留浏览器行为，普通导航沿用工作台守卫。
 */
import type { z, inspectionDomainReferenceSchema } from "@kaguya/schema";
import { useWorkbenchNavigate } from "./components/AppShell.js";
import {
  inspectionLocation,
  type InspectionLocation,
} from "./inspection-navigation.js";
export type DomainReference = z.infer<typeof inspectionDomainReferenceSchema>;
export function InspectionReference({
  reference,
  location,
  context,
}: {
  reference: DomainReference;
  location: string;
  context: InspectionLocation;
}) {
  const navigate = useWorkbenchNavigate();
  const label = {
    available: "可查看",
    "missing-or-denied": "来源缺失或不可访问",
    unrecorded: "未记录",
    invalid: "引用无效",
  }[reference.availability];
  const href = inspectionLocation(location, {
    ...context,
    domain: reference.domain,
    selected: reference.id,
    cursors: [],
  });
  return (
    <span className="inspection-reference">
      <span>
        {reference.relation} · {label}
      </span>
      {reference.availability === "available" ? (
        <a
          href={href}
          onClick={(event) => {
            if (
              event.button ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            void navigate(href);
          }}
        >
          <code>{reference.id}</code>
        </a>
      ) : (
        <code>{reference.id || "未记录"}</code>
      )}
    </span>
  );
}
