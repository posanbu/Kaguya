/**
 * 架构说明：本模块提供信息 atom 的发布总线，负责在边界处创建冻结快照，
 * 再以注册顺序分发给同 kind 订阅者与全量订阅者，隔离观察者异常。
 * 代码库关系：`InformationCore.append()` 在持久化成功后调用这里的 publish，
 * 从而保证“先写后看”的一致性，而不会让订阅者直接触碰原始可变输入。
 */
import {
  freezeInformationAtom,
  type DeepReadonly,
  type InformationAtom,
} from "@kaguya/schema";

type InformationSubscriber = (atom: DeepReadonly<InformationAtom>) => unknown | Promise<unknown>;

interface SubscriberRegistration {
  readonly id: number;
  readonly kind: string | null;
  readonly handler: InformationSubscriber;
}

export interface InformationBusOptions {
  readonly onSubscriberError?: (error: unknown) => void | Promise<void>;
}

export class InformationBus {
  #subscriptions: SubscriberRegistration[] = [];
  #nextSubscriptionId = 0;

  constructor(private readonly options: InformationBusOptions = {}) {}

  subscribe(kind: string, handler: InformationSubscriber): () => void {
    return this.addSubscription(kind, handler);
  }

  subscribeAll(handler: InformationSubscriber): () => void {
    return this.addSubscription(null, handler);
  }

  clear(): void {
    this.#subscriptions = [];
  }

  async publish(
    atom: InformationAtom | DeepReadonly<InformationAtom>,
  ): Promise<DeepReadonly<InformationAtom>> {
    const snapshot = freezeSnapshot(atom);
    const subscribers = this.#subscriptions
      .filter((subscription) => subscription.kind === null || subscription.kind === snapshot.kind)
      .sort((left, right) => left.id - right.id);

    for (const subscription of subscribers) {
      try {
        await subscription.handler(snapshot);
      } catch (error) {
        await this.reportSubscriberError(error);
      }
    }

    return snapshot;
  }

  private addSubscription(kind: string | null, handler: InformationSubscriber): () => void {
    const registration: SubscriberRegistration = {
      id: ++this.#nextSubscriptionId,
      kind,
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

  private async reportSubscriberError(error: unknown): Promise<void> {
    try {
      await this.options.onSubscriberError?.(error);
    } catch {
      // 订阅者错误汇报不得影响已提交的业务结果。
    }
  }
}

function freezeSnapshot(
  atom: InformationAtom | DeepReadonly<InformationAtom>,
): DeepReadonly<InformationAtom> {
  return freezeInformationAtom(atom as InformationAtom);
}
