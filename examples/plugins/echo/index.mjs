/**
 * 功能概述：独立可安装的示例包，将入站文本长度写成版本化领域事实。
 * 主要职责：默认导出 SDK 插件声明；settingsSchema 配置标签，durable handler 使用 registerOnce
 * 保证恢复重放只派生一次结果；宿主自动收集输出 Kind 并管理实例生命周期。
 * 代码库关系：只依赖公开 SDK、schema 和内置入站 Kind，不引用 Server/Runtime/Database 实现。
 * 输入输出与副作用：创建时不访问外部服务，只有收到入站事实时通过 ModuleHost 写账本。
 */
import { z } from "@kaguya/schema";
import {
  defineModulePlugin,
  defineVersionedInformationKind,
  defineInformationModule,
  onInformation,
} from "@kaguya/sdk";

export const echoKind = defineVersionedInformationKind({
  owner: "example.echo",
  version: 1,
  kind: "example.echo.record.v1",
  displayName: "示例记录",
  description: "独立插件记录的文本长度",
  payloadSchema: z.strictObject({
    label: z.string(),
    length: z.number().int().nonnegative(),
  }),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": { required: true, multiple: false },
  },
  log: { enabled: false },
});

export default function createPlugin(host) {
  const inboundTextInformationKind = host.kind("core.message.inbound.text");
  return defineModulePlugin({
    id: "example.echo",
    version: "1.0.0",
    modules: [
      defineInformationModule({
        manifest: {
          protocolVersion: 1,
          definitionId: "example.echo",
          moduleVersion: "1.0.0",
          displayName: "示例插件",
          summary: "将入站长度写入账本",
          description: "验证独立包发现、配置和生命周期。",
          settingsSchema: z.strictObject({ label: z.string().default("echo") }),
          consumes: [inboundTextInformationKind],
          produces: [echoKind],
          selectors: [],
          promptRenderers: [],
          requires: [],
          provides: [],
        },
        create: ({ settings, instanceId }) => ({
          provisions: [],
          subscriptions: [
            onInformation(
              inboundTextInformationKind,
              { subscriptionId: "echo", delivery: "durable" },
              async (atom, context) => {
                await context.registerOnce(
                  `${instanceId}.echo.v1`,
                  atom.informationId,
                  echoKind,
                  {
                    payload: {
                      label: settings.label,
                      length: atom.payload.text.length,
                    },
                  },
                );
              },
            ),
          ],
        }),
      }),
    ],
  });
}
