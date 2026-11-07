/**
 * 功能概述：锁定领域深链接、过滤分页与原知识范围的导航合同。
 * 回归 Memory 第二页曾误清 nodeId 的路径，并验证 opaque cursor 不被解析、scope 变更由新链接隔离。
 * 纯 URL/API 路径测试，无 DOM、网络、模型或持久化副作用；浏览器前后退另由实际验收覆盖。
 */
import { describe, expect, it } from "vitest";
import {
  inspectionApiPath,
  inspectionLocation,
  inspectionPage,
  readInspectionLocation,
} from "./inspection-navigation.js";
describe("领域检视深链接", () => {
  const scope = JSON.stringify(["qq", "onebot", "group", "测试范围"]);
  it("恢复 scope、consumer、多个 opaque cursor 与包含斜线的稳定 ID", () => {
    const route = {
      ...readInspectionLocation("/situation", scope),
      consumer: "consumer:a",
      selected: "id/含空格 ?",
      cursors: ["opaque+/=1", "opaque?2"],
    };
    expect(
      readInspectionLocation(
        inspectionLocation("/situation?lifecycle=sleep", route),
      ),
    ).toEqual(route);
    expect(inspectionLocation("/situation?lifecycle=sleep", route)).toContain(
      "lifecycle=sleep",
    );
    const api = new URL(inspectionApiPath(route)!, "http://localhost/");
    expect(api.searchParams.get("cursor")).toBe("opaque?2");
    expect(api.searchParams.get("scope")).toBe(scope);
    expect(api.searchParams.get("consumerId")).toBe("consumer:a");
  });
  it("Memory 空页后继续翻页仍携带原 node/observation/step 和知识范围", () => {
    const route = {
      ...readInspectionLocation("/memory", scope),
      domain: "memory" as const,
      selected: "node/id",
      observation: "original-observation",
      step: "successor/step",
    };
    const next = inspectionPage(route, ["signed-next"]);
    expect(readInspectionLocation(inspectionLocation("/memory", next))).toEqual(
      next,
    );
    const api = new URL(inspectionApiPath(next)!, "http://localhost/");
    expect(api.pathname).toBe("/memory/node%2Fid/history");
    expect(api.searchParams.get("observationId")).toBe("original-observation");
    expect(api.searchParams.get("stepInformationId")).toBe("successor/step");
    expect(api.searchParams.get("cursor")).toBe("signed-next");
    expect(inspectionPage(next, []).selected).toBe("node/id");
  });
  it("目录翻页清详情，Memory 缺原观察时不构造正文读取", () => {
    const route = {
      ...readInspectionLocation("/situation", scope),
      selected: "old-detail",
    };
    expect(inspectionPage(route, ["next"]).selected).toBe("");
    expect(inspectionApiPath({ ...route, domain: "memory" })).toBeUndefined();
    expect(inspectionApiPath({ ...route, scope: "" })).toBeUndefined();
  });
  it("GUI Inspection 使用来源 ID；未知领域不形成任意服务端路径", () => {
    const route = readInspectionLocation(
      "/situation?inspect=gui-task&selected=requested%2Fsource&scope=scope",
    );
    expect(inspectionApiPath(route, true)).toBe(
      "gui-tasks/requested%2Fsource?scope=scope",
    );
    expect(
      readInspectionLocation("/situation?inspect=../../private").domain,
    ).toBe("observation");
  });
});
