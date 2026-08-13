import { DatabaseSync } from "node:sqlite";

import { migrateDatabase } from "./migrations.js";
import {
  EventRunRepository,
  LlmTraceRepository,
  MemoryRepository,
  MessageRepository,
  OutboundMessageRepository,
} from "./repositories.js";

export {
  DatabaseRecordError,
  EventRunRepository,
  EventRunLifecycleError,
  LlmTraceRepository,
  MemoryRepository,
  MessageRepository,
  OutboundMessageRepository,
} from "./repositories.js";

export class KaguyaDatabase {
  readonly messages: MessageRepository;
  readonly memories: MemoryRepository;
  readonly eventRuns: EventRunRepository;
  readonly llmTraces: LlmTraceRepository;
  readonly outboundMessages: OutboundMessageRepository;

  private constructor(private readonly database: DatabaseSync) {
    this.messages = new MessageRepository(database);
    this.memories = new MemoryRepository(database);
    this.eventRuns = new EventRunRepository(database);
    this.llmTraces = new LlmTraceRepository(database);
    this.outboundMessages = new OutboundMessageRepository(database);
  }

  static open(path: string): KaguyaDatabase {
    return new KaguyaDatabase(new DatabaseSync(path));
  }

  migrate(): void {
    migrateDatabase(this.database);
  }

  close(): void {
    this.database.close();
  }
}
