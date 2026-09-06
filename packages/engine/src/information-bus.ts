/**
 * 功能概述：本模块提供信息 atom 的内存广播总线，在提交后的当前订阅者快照上并发调用。
 * 主要职责：`InformationBus.on`/`onAll` 记录带稳定 `InformationConsumer` 身份的 handler；
 * `publish` 冻结 atom，并以一次 `Promise.allSettled` 返回每个消费者的成功或失败结果。
 * 代码库关系：`InformationCore` 是唯一的调用方，负责把 rejected 结果转成
 * `consumer.failed` 事实；本总线不记录故障、不持久化，也不重放历史 atom。
 * 输入输出与副作用：订阅会改变进程内订阅集合；publish 返回消费者结果，handler 总是
 * 接收到同一个冻结快照，单个拒绝不会阻止其他 handler 启动或完成。
 */
import {
  freezeInformationAtom,
  type DeepReadonly,
  type InformationAtom,
} from "@kaguya/schema";

export interface InformationConsumer {
  readonly consumerId: string;
  readonly definitionId?: string;
  readonly instanceId?: string;
}

export type InformationSubscriber = (
  atom: DeepReadonly<InformationAtom>,
) => unknown | Promise<unknown>;

export type InformationBroadcastResult =
  | {
      readonly consumer: InformationConsumer;
      readonly status: "fulfilled";
    }
  | {
      readonly consumer: InformationConsumer;
      readonly status: "rejected";
      readonly reason: unknown;
    };

interface SubscriberRegistration {
  readonly id: number;
  readonly kind: string | null;
  readonly consumer: InformationConsumer;
  readonly handler: InformationSubscriber;
}

export class InformationBus {
  #subscriptions: SubscriberRegistration[] = [];
  #nextSubscriptionId = 0;

  on(
    kind: string,
    consumer: InformationConsumer,
    handler: InformationSubscriber,
  ): () => void {
    return this.addSubscription(kind, consumer, handler);
  }

  onAll(
    consumer: InformationConsumer,
    handler: InformationSubscriber,
  ): () => void {
    return this.addSubscription(null, consumer, handler);
  }

  clear(): void {
    this.#subscriptions = [];
  }

  async publish(
    atom: InformationAtom | DeepReadonly<InformationAtom>,
  ): Promise<readonly InformationBroadcastResult[]> {
    const snapshot = freezeSnapshot(atom);
    const subscribers = this.#subscriptions.filter(
      (subscription) =>
        subscription.kind === null || subscription.kind === snapshot.kind,
    );
    const settled = await Promise.allSettled(
      subscribers.map((subscription) =>
        Promise.resolve().then(() => subscription.handler(snapshot)),
      ),
    );
    return settled.map((result, index) => {
      const consumer = subscribers[index]!.consumer;
      return result.status === "fulfilled"
        ? { consumer, status: "fulfilled" }
        : { consumer, status: "rejected", reason: result.reason };
    });
  }

  private addSubscription(
    kind: string | null,
    consumer: InformationConsumer,
    handler: InformationSubscriber,
  ): () => void {
    const registration: SubscriberRegistration = {
      id: ++this.#nextSubscriptionId,
      kind,
      consumer: Object.freeze({ ...consumer }),
      handler,
    };
    this.#subscriptions.push(registration);
    return () => {
      const index = this.#subscriptions.indexOf(registration);
      if (index >= 0) {
        this.#subscriptions.splice(index, 1);
      }
    };
  }
}

function freezeSnapshot(
  atom: InformationAtom | DeepReadonly<InformationAtom>,
): DeepReadonly<InformationAtom> {
  return freezeInformationAtom(atom as InformationAtom);
}
